// STPresetEditor — local-files + cloud extension host.
//
// MODEL (2026-07 "storage + explicit save"): the cloud is passive NAMED
// storage. Nothing syncs by itself from this extension — there is no
// background reconcile, no folder mapping, no watcher-driven push. The host
// only executes EXPLICIT actions the user takes:
//
//   • Interface A — the file editor ("Open in STPresetEditor" on a .json):
//     reads the file into a webview ({type:'load'}) and writes edits back
//     atomically ({type:'save'}). Local only. Its single cloud affordance is
//     the explicit "Send to cloud" button (cloudSend → one named PUT; same
//     name = replace, previous cloud version kept as a snapshot).
//   • Interface B — the cloud browser (stpe.openEditor, a webview panel with
//     no file): lists the cloud presets (cloudList/cloudLoad), lets the user
//     open one in the editor, and saves it into a workspace folder they pick
//     (saveToWorkspace — overwrites a same-named file, never a second copy).
//     Deletes/renames in its Preset Manager call cloudDelete/cloudRename.
//
// Cloud auth: the HOST does the Cloudflare HTTP over Node (no browser CORS).
// The webview can't ride the web app's login cookie, so the extension
// authenticates with a generated **API key** (`X-API-Key`) created in the web
// app (Settings → Cloud sync). The key lives in VS Code SecretStorage
// (encrypted), never in the repo and never echoed to the webview. There is NO
// built-in endpoint: nothing is sent anywhere until the user pastes their own
// Worker URL + key.
//
// The Explorer "ST Presets" tree lists the workspace's preset .json files with
// plain file operations (New/Duplicate/Rename/Delete/Reveal) and a per-file
// "Send to cloud" context action. It never talks to the cloud on its own.
//
// Plain CommonJS so it runs with no compile step.
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const folderLib = require('./presetFolder');

const SECRET_KEY = 'stpe.apiKey';

// Sentinel key in `panels` for the single cloud-browser panel (no file).
// A NUL prefix can never collide with a real filesystem path. Written as the
// \0 ESCAPE (not a literal NUL byte) so the file stays text for grep/tooling.
const LIBRARY_PANEL_KEY = '\0library';

// One webview per file path (plus the library sentinel), so re-opening reveals
// the existing panel instead of stacking duplicates.
const panels = new Map();
let extensionContext = null; // for SecretStorage access
let statusBar; // file-save confirmation
let activePanel = null; // last-focused STPE webview
let cloudKey = ''; // API key, cached from SecretStorage
let keyLoad = null; // resolves once the stored API key has loaded (startup race)
let urlPromptShown = false; // one-time nudge to configure the cloud URL

function activate(context) {
  extensionContext = context;
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  context.subscriptions.push(statusBar);

  // Load the stored API key (async) so explicit cloud actions work without
  // re-entry. Keep the promise: a webview's first cloud request can arrive
  // before this resolves, and answering "not connected" too early looks like
  // a broken key. The cloud handlers await this before answering.
  keyLoad = context.secrets.get(SECRET_KEY).then((key) => {
    cloudKey = key || '';
  });

  context.subscriptions.push(
    vscode.commands.registerCommand('stpe.open', (uri) => {
      const filePath = resolveTargetPath(uri);
      if (filePath) openEditor(context, filePath);
    }),
    // The cloud browser: the STPresetEditor UI with no file attached — browse
    // your cloud library, open a preset, save it into a workspace folder.
    vscode.commands.registerCommand('stpe.openEditor', () => openLibraryEditor(context)),
    // Explicit per-file "Send to cloud" from the tree context menu.
    vscode.commands.registerCommand('stpe.sendPreset', sendPresetFileToCloud),
    // Forward editor keybindings VS Code would otherwise swallow (Ctrl+F/K/S)
    // into the focused webview, so shortcuts work like the web app.
    vscode.commands.registerCommand('stpe.shortcut', (action) => {
      if (activePanel) activePanel.webview.postMessage({ type: 'shortcut', action });
    }),
  );

  // --- ST Presets tree (plain file list — no cloud state) ---
  treeProvider = new PresetTreeProvider();
  context.subscriptions.push(
    vscode.window.createTreeView('stpePresets', { treeDataProvider: treeProvider }),
    vscode.commands.registerCommand('stpe.refreshPresets', () => treeProvider.refresh()),
    vscode.commands.registerCommand('stpe.newPreset', newPresetFile),
    vscode.commands.registerCommand('stpe.duplicatePreset', duplicatePresetFile),
    vscode.commands.registerCommand('stpe.renamePreset', renamePresetFile),
    vscode.commands.registerCommand('stpe.deletePreset', deletePresetFile),
    vscode.commands.registerCommand('stpe.revealInExplorer', (item) => {
      if (item && item.fsPath) {
        vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(item.fsPath));
      }
    }),
  );
  setupWatcher(context);
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('stpe.presetGlob')) setupWatcher(context);
    }),
  );
}

// --- ST Presets tree -------------------------------------------------------------

let treeProvider = null;
let watcher = null;

function workspaceRoot() {
  const ws = vscode.workspace.workspaceFolders;
  return ws && ws.length ? ws[0].uri.fsPath : null;
}

function presetGlob() {
  const cfg = vscode.workspace.getConfiguration('stpe').get('presetGlob');
  return typeof cfg === 'string' && cfg.trim() ? cfg.trim() : '**/*.json';
}

/** Workspace .json files that parse as ST presets (object with a prompts array). */
async function findPresetFiles() {
  const uris = await vscode.workspace.findFiles(presetGlob(), '**/node_modules/**', 500);
  const files = [];
  for (const uri of uris) {
    let text;
    try {
      if (fs.statSync(uri.fsPath).size > 5 * 1024 * 1024) continue;
      text = fs.readFileSync(uri.fsPath, 'utf8');
    } catch {
      continue;
    }
    if (!folderLib.isPresetJson(text)) continue; // silently skip non-presets
    files.push(uri.fsPath);
  }
  files.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
  return files;
}

class PresetTreeProvider {
  constructor() {
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._emitter.event;
  }
  refresh() {
    this._emitter.fire(undefined);
  }
  async getChildren(element) {
    if (element) return [];
    const root = workspaceRoot();
    const files = await findPresetFiles();
    return files.map((fsPath) => ({
      fsPath,
      rel: root ? path.relative(root, fsPath) : path.basename(fsPath),
    }));
  }
  getTreeItem(entry) {
    const item = new vscode.TreeItem(path.basename(entry.fsPath));
    item.resourceUri = vscode.Uri.file(entry.fsPath);
    item.contextValue = 'stpePreset';
    item.iconPath = new vscode.ThemeIcon('json');
    item.command = {
      command: 'stpe.open',
      title: 'Open in STPresetEditor',
      arguments: [vscode.Uri.file(entry.fsPath)],
    };
    return item;
  }
}

function setupWatcher(context) {
  if (watcher) watcher.dispose();
  watcher = vscode.workspace.createFileSystemWatcher(presetGlob());
  const onFsEvent = () => {
    if (treeProvider) treeProvider.refresh();
  };
  watcher.onDidCreate(onFsEvent);
  watcher.onDidChange(onFsEvent);
  watcher.onDidDelete(onFsEvent);
  context.subscriptions.push(watcher);
  if (treeProvider) treeProvider.refresh();
}

// --- Tree file operations ---------------------------------------------------------

async function newPresetFile() {
  const root = workspaceRoot();
  if (!root) {
    vscode.window.showErrorMessage('STPresetEditor: open a folder first.');
    return;
  }
  const name = await vscode.window.showInputBox({
    prompt: 'Name for the new preset',
    value: 'New Preset',
  });
  if (!name) return;
  const existing = fs.readdirSync(root).filter((f) => f.toLowerCase().endsWith('.json'));
  const fileName = folderLib.fileNameForEntry(name, existing);
  const target = path.join(root, fileName);
  writeFileAtomic(target, folderLib.starterPresetJson());
  if (treeProvider) treeProvider.refresh();
  openEditor(extensionContext, target);
}

async function duplicatePresetFile(item) {
  if (!item || !item.fsPath) return;
  let text;
  try {
    text = fs.readFileSync(item.fsPath, 'utf8');
  } catch (error) {
    vscode.window.showErrorMessage(`STPresetEditor: cannot read file — ${error.message}`);
    return;
  }
  const dir = path.dirname(item.fsPath);
  const base = path.basename(item.fsPath, '.json');
  const existing = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.json'));
  const fileName = folderLib.fileNameForEntry(`${base} copy`, existing);
  writeFileAtomic(path.join(dir, fileName), text);
  if (treeProvider) treeProvider.refresh();
}

async function renamePresetFile(item) {
  if (!item || !item.fsPath) return;
  const oldBase = path.basename(item.fsPath);
  const input = await vscode.window.showInputBox({ prompt: 'New file name', value: oldBase });
  if (!input || input === oldBase) return;
  const safe = input.replace(/[\\/:*?"<>|]/g, '_');
  const newName = safe.toLowerCase().endsWith('.json') ? safe : `${safe}.json`;
  const target = path.join(path.dirname(item.fsPath), newName);
  if (fs.existsSync(target)) {
    vscode.window.showErrorMessage(`STPresetEditor: "${newName}" already exists.`);
    return;
  }
  try {
    fs.renameSync(item.fsPath, target);
  } catch (error) {
    vscode.window.showErrorMessage(`STPresetEditor: rename failed — ${error.message}`);
    return;
  }
  // If the old file was open in an editor, that panel is keyed by (and autosaves
  // to) the OLD path — it would recreate the old filename on the next edit. Close
  // it and reopen the renamed file so editing follows the rename seamlessly.
  const openPanel = panels.get(item.fsPath);
  if (openPanel) {
    openPanel.dispose(); // onDidDispose removes it from `panels`
    if (extensionContext) openEditor(extensionContext, target);
  }
  if (treeProvider) treeProvider.refresh();
}

async function deletePresetFile(item) {
  if (!item || !item.fsPath) return;
  const base = path.basename(item.fsPath);
  const confirmed = await vscode.window.showWarningMessage(
    `Delete "${base}"?`,
    { modal: true },
    'Delete',
  );
  if (confirmed !== 'Delete') return;
  try {
    await vscode.workspace.fs.delete(vscode.Uri.file(item.fsPath), { useTrash: true });
  } catch (error) {
    vscode.window.showErrorMessage(`STPresetEditor: delete failed — ${error.message}`);
    return;
  }
  // Close any editor open on the deleted file so its autosave can't immediately
  // recreate the file we just removed. Deleting a FILE never touches the cloud.
  const openPanel = panels.get(item.fsPath);
  if (openPanel) openPanel.dispose(); // onDidDispose removes it from `panels`
  if (treeProvider) treeProvider.refresh();
}

/** Tree context action: explicitly send ONE preset file to the cloud under its
 *  file name (same name = replace + keep the previous version as a snapshot). */
async function sendPresetFileToCloud(item) {
  if (!item || !item.fsPath) return;
  if (keyLoad) await keyLoad.catch(() => {});
  if (!cloudConfigured()) {
    if (!apiBase()) nudgeForCloudUrl();
    else {
      vscode.window.showWarningMessage(
        'STPresetEditor: connect cloud sync first (paste an API key in the editor’s Settings → Cloud sync).',
      );
    }
    return;
  }
  let text;
  try {
    text = fs.readFileSync(item.fsPath, 'utf8');
  } catch (error) {
    vscode.window.showErrorMessage(`STPresetEditor: cannot read file — ${error.message}`);
    return;
  }
  let data;
  try {
    data = folderLib.parsePresetFile(text);
  } catch {
    vscode.window.showErrorMessage(
      `STPresetEditor: "${path.basename(item.fsPath)}" is not a valid preset file.`,
    );
    return;
  }
  const name = path.basename(item.fsPath, '.json');
  try {
    const res = await cloudPutOne(
      name,
      {
        data: { ...data, originalFilename: path.basename(item.fsPath) },
        updatedAt: new Date().toISOString(),
      },
      { snapshot: true },
    );
    if (!res.ok) throw new Error('the cloud rejected the write');
    vscode.window.showInformationMessage(
      res.existed
        ? `STPresetEditor: updated "${name}" in the cloud (previous version kept as a snapshot).`
        : `STPresetEditor: created "${name}" in the cloud.`,
    );
  } catch (error) {
    vscode.window.showErrorMessage(`STPresetEditor: send failed — ${error.message}`);
  }
}

/** Resolve the .json path from a context-menu uri or the active editor. */
function resolveTargetPath(uri) {
  let filePath;
  if (uri && uri.fsPath) {
    filePath = uri.fsPath;
  } else {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage('STPresetEditor: open or select a .json preset first.');
      return null;
    }
    filePath = editor.document.fileName;
  }
  if (!filePath.toLowerCase().endsWith('.json')) {
    vscode.window.showErrorMessage('STPresetEditor: please choose a .json preset file.');
    return null;
  }
  return filePath;
}

/** Open (or reveal) the file-backed editor for one local .json. */
function openEditor(context, filePath) {
  openPanel(context, { filePath, mode: 'file' });
}

/** Open (or reveal) the single cloud-browser panel (no file attached). */
function openLibraryEditor(context) {
  openPanel(context, { mode: 'library' });
}

/**
 * Create (or reveal) an STPE webview.
 *   mode 'file'    — mirrors `filePath`; the host pushes its content on 'ready'.
 *   mode 'library' — the cloud browser; the webview lists/loads cloud presets
 *                    through this host. Keyed by a sentinel so only one exists.
 * `mode` is injected into the HTML (window.__STPE_MODE__) so the Vue app knows
 * from first paint whether it is file-backed or the cloud browser.
 */
function openPanel(context, { filePath = null, mode = 'file' } = {}) {
  const key = filePath || LIBRARY_PANEL_KEY;
  const existing = panels.get(key);
  if (existing) {
    existing.reveal(vscode.ViewColumn.One);
    return;
  }

  const mediaUri = vscode.Uri.joinPath(context.extensionUri, 'media');
  const title = filePath ? path.basename(filePath) : 'STPresetEditor — Cloud';
  const panel = vscode.window.createWebviewPanel('stpeEditor', title, vscode.ViewColumn.One, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [mediaUri],
  });
  panels.set(key, panel);
  activePanel = panel;

  panel.onDidChangeViewState(
    (e) => {
      if (e.webviewPanel.active) activePanel = e.webviewPanel;
    },
    null,
    context.subscriptions,
  );
  panel.onDidDispose(
    () => {
      panels.delete(key);
      if (activePanel === panel) activePanel = null;
    },
    null,
    context.subscriptions,
  );

  panel.webview.onDidReceiveMessage(
    (message) => handleMessage(message, panel, filePath),
    undefined,
    context.subscriptions,
  );

  panel.webview.html = getWebviewHtml(panel.webview, mediaUri, mode);
}

function handleMessage(message, panel, filePath) {
  if (!message || typeof message !== 'object') return;
  switch (message.type) {
    case 'ready':
      // The cloud browser has no file to load; it lists the cloud instead.
      if (filePath) sendLoad(panel, filePath);
      sendCloudState(panel);
      break;
    case 'save':
      if (filePath) handleSave(filePath, message.json);
      break;
    case 'createFile':
      if (filePath) handleCreateFile(panel, filePath, message);
      break;
    case 'cloudStateRequest':
      sendCloudState(panel);
      break;
    case 'cloudConnect':
      handleConnect(panel, message);
      break;
    case 'cloudDisconnect':
      handleDisconnect(panel);
      break;
    case 'cloudList':
      handleCloudList(panel);
      break;
    case 'cloudLoad':
      handleCloudLoad(panel, message);
      break;
    case 'cloudSend':
      handleCloudSend(panel, message);
      break;
    case 'cloudDelete':
      handleCloudDelete(panel, message);
      break;
    case 'cloudRename':
      handleCloudRename(panel, message);
      break;
    case 'saveToWorkspace':
      handleSaveToWorkspace(panel, message);
      break;
  }
}

// --- Explicit cloud actions (webview → host → worker) ------------------------------

/** GET the index for the webview. Replies { connected:false } when no key /
 *  unreachable, else { connected:true, presets:[{name,updatedAt}] }. */
async function handleCloudList(panel) {
  if (keyLoad) await keyLoad.catch(() => {}); // don't answer before the key loads
  if (!cloudConfigured()) {
    panel.webview.postMessage({ type: 'cloudListResult', connected: false });
    return;
  }
  try {
    const index = await cloudGetIndex();
    panel.webview.postMessage({
      type: 'cloudListResult',
      connected: true,
      presets: index,
    });
  } catch {
    panel.webview.postMessage({ type: 'cloudListResult', connected: false });
  }
}

async function handleCloudLoad(panel, message) {
  try {
    const entry = await cloudGetOne(String(message.name || ''));
    panel.webview.postMessage({ type: 'cloudLoaded', ok: Boolean(entry), entry });
  } catch {
    panel.webview.postMessage({ type: 'cloudLoaded', ok: false });
  }
}

async function handleCloudSend(panel, message) {
  try {
    const body = { data: message.data, updatedAt: message.updatedAt };
    if (Array.isArray(message.snapshots)) body.snapshots = message.snapshots;
    const res = await cloudPutOne(String(message.name || ''), body, {
      snapshot: Boolean(message.snapshot),
    });
    panel.webview.postMessage({ type: 'cloudSent', ...res });
  } catch {
    panel.webview.postMessage({ type: 'cloudSent', ok: false });
  }
}

async function handleCloudDelete(panel, message) {
  try {
    const res = await cloudDeleteOne(String(message.name || ''));
    panel.webview.postMessage({ type: 'cloudDeleted', ok: res.ok });
  } catch {
    panel.webview.postMessage({ type: 'cloudDeleted', ok: false });
  }
}

/** Rename = read old → write new (keeping data + snapshots; a same-named
 *  target is replaced, its previous version kept as a snapshot) → delete old. */
async function handleCloudRename(panel, message) {
  try {
    const oldName = String(message.oldName || '');
    const newName = String(message.newName || '');
    if (!oldName || !newName || oldName === newName) {
      panel.webview.postMessage({ type: 'cloudRenamed', ok: Boolean(newName) });
      return;
    }
    const existing = await cloudGetOne(oldName);
    if (!existing) {
      // Nothing to move (the old name was never sent) — the rename is local.
      panel.webview.postMessage({ type: 'cloudRenamed', ok: true, updatedAt: null });
      return;
    }
    const updatedAt = new Date().toISOString();
    const res = await cloudPutOne(
      newName,
      { data: existing.data, snapshots: existing.snapshots || [], updatedAt },
      { snapshot: true },
    );
    if (!res.ok) throw new Error('write failed');
    await cloudDeleteOne(oldName);
    panel.webview.postMessage({ type: 'cloudRenamed', ok: true, updatedAt });
  } catch {
    panel.webview.postMessage({ type: 'cloudRenamed', ok: false });
  }
}

// --- Save into a workspace folder (the cloud browser's Save button) ----------------

/** Every directory in the open workspace (roots + subfolders, depth ≤ 3,
 *  skipping dot-folders and node_modules) for the destination QuickPick. */
function listWorkspaceDirectories() {
  const out = [];
  for (const folder of vscode.workspace.workspaceFolders || []) {
    const rootPath = folder.uri.fsPath;
    out.push({ label: folder.name, fsPath: rootPath });
    collectSubdirectories(rootPath, rootPath, folder.name, out, 0);
  }
  return out;
}

function collectSubdirectories(dir, root, rootName, out, depth) {
  if (depth >= 3) return;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const abs = path.join(dir, entry.name);
    const rel = path.relative(root, abs).split(path.sep).join('/');
    out.push({ label: `${rootName}/${rel}`, fsPath: abs });
    collectSubdirectories(abs, root, rootName, out, depth + 1);
  }
}

/**
 * The cloud browser's Save: pick any folder currently in the workspace and
 * write `<name>.json` there. A same-named file is OVERWRITTEN (name =
 * identity, no "(2)" copies). An open editor panel on that path is reloaded.
 */
async function handleSaveToWorkspace(panel, message) {
  const reply = (payload) => panel.webview.postMessage({ type: 'workspaceSaved', ...payload });
  try {
    const json = typeof message.json === 'string' ? message.json : '';
    JSON.parse(json); // guard: never write invalid JSON as a preset file
    const dirs = listWorkspaceDirectories();
    if (!dirs.length) {
      vscode.window.showErrorMessage('STPresetEditor: open a folder in this window first.');
      reply({ ok: false, reason: 'no_workspace' });
      return;
    }
    const picked = await vscode.window.showQuickPick(
      dirs.map((d) => ({ label: d.label, description: d.fsPath, fsPath: d.fsPath })),
      { placeHolder: 'Save the preset into which workspace folder?' },
    );
    if (!picked) {
      reply({ ok: false, reason: 'cancelled' });
      return;
    }
    const rawName = String(message.name || 'preset.json').replace(/[\\/:*?"<>|]/g, '_');
    const fileName = rawName.toLowerCase().endsWith('.json') ? rawName : `${rawName}.json`;
    const target = path.join(picked.fsPath, fileName);
    const existed = fs.existsSync(target);
    writeFileAtomic(target, json);
    // A file panel open on this path is now stale — push it the fresh content.
    const openPanel = panels.get(target);
    if (openPanel) sendLoad(openPanel, target);
    if (treeProvider) treeProvider.refresh();
    reply({ ok: true, path: target, fileName });
    vscode.window
      .showInformationMessage(
        `STPresetEditor: ${existed ? 'updated' : 'saved'} ${fileName}`,
        'Open in ST Preset Editor',
      )
      .then((choice) => {
        if (choice) openEditor(extensionContext, target);
      });
  } catch (error) {
    reply({ ok: false, reason: String((error && error.message) || error) });
  }
}

/** Read the preset file and push it to the webview. */
function sendLoad(panel, filePath) {
  try {
    const json = fs.readFileSync(filePath, 'utf8');
    panel.webview.postMessage({
      type: 'load',
      path: filePath,
      name: path.basename(filePath),
      json,
    });
  } catch (error) {
    vscode.window.showErrorMessage(
      `STPresetEditor: failed to read ${path.basename(filePath)} — ${error.message}`,
    );
  }
}

/** Validate and atomically write an edited preset back to disk. */
function handleSave(filePath, json) {
  if (typeof json !== 'string') return;
  try {
    JSON.parse(json); // guard: never write invalid JSON over a real preset
    writeFileAtomic(filePath, json);
    statusBar.text = `$(check) Preset saved ${new Date().toLocaleTimeString()}`;
    statusBar.tooltip = filePath;
    statusBar.show();
  } catch (error) {
    vscode.window.showErrorMessage(
      `STPresetEditor: failed to save ${path.basename(filePath)} — ${error.message}`,
    );
  }
}

/**
 * Write a preset to a NEW .json next to the open file and open it in its own
 * editor tab. Used by the webview's Preset Manager so loading a library preset
 * never overwrites the file being edited. Replies with 'fileCreated'.
 */
function handleCreateFile(panel, basePath, message) {
  try {
    const json = typeof message.json === 'string' ? message.json : '';
    JSON.parse(json); // guard: never create an invalid preset file
    const dir = path.dirname(basePath);
    const rawName = String(message.name || 'preset.json').replace(/[\\/:*?"<>|]/g, '_');
    const base = rawName.toLowerCase().endsWith('.json') ? rawName.slice(0, -5) : rawName;
    let target = path.join(dir, `${base}.json`);
    let n = 2;
    while (fs.existsSync(target)) {
      target = path.join(dir, `${base} (${n}).json`);
      n += 1;
    }
    fs.writeFileSync(target, json, 'utf8');
    panel.webview.postMessage({
      type: 'fileCreated',
      ok: true,
      path: target,
      name: path.basename(target),
    });
    openEditor(extensionContext, target);
  } catch (error) {
    panel.webview.postMessage({
      type: 'fileCreated',
      ok: false,
      reason: String((error && error.message) || error),
    });
  }
}

function writeFileAtomic(filePath, content) {
  const tmp = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
}

// --- Cloud HTTP (account auth) -----------------------------------------------

/** The user's cloud setting, verbatim. There is NO built-in default, so the
 *  extension never talks to anyone else's server. */
function cloudUrlRaw() {
  const cfg = vscode.workspace.getConfiguration('stpe').get('cloudUrl');
  return typeof cfg === 'string' ? cfg.trim() : '';
}

/** Normalise the configured URL to the Worker origin, tolerating either a bare
 *  origin (`https://x.workers.dev`) or a full endpoint pasted by mistake
 *  (`.../api/presets`). Returns '' when unset. */
function apiBase() {
  let raw = cloudUrlRaw();
  if (!raw) return '';
  raw = raw.replace(/\/+$/, '');
  raw = raw.replace(/\/api\/(?:presets|auth(?:\/me)?|keys).*$/i, '');
  return raw;
}

function presetsUrl(name) {
  const base = apiBase();
  if (!base) return '';
  return name == null ? `${base}/api/presets` : `${base}/api/presets/${encodeURIComponent(name)}`;
}

function meUrl() {
  const base = apiBase();
  return base ? `${base}/api/auth/me` : '';
}

function cloudConfigured() {
  return Boolean(cloudKey && apiBase());
}

async function setStoredUrl(url) {
  await vscode.workspace
    .getConfiguration('stpe')
    .update('cloudUrl', url, vscode.ConfigurationTarget.Global);
}

async function setStoredKey(key) {
  cloudKey = key || '';
  if (key) await extensionContext.secrets.store(SECRET_KEY, key);
  else await extensionContext.secrets.delete(SECRET_KEY);
}

/** One-time, actionable nudge when a key is set but no URL yet. */
function nudgeForCloudUrl() {
  if (urlPromptShown) return;
  urlPromptShown = true;
  vscode.window
    .showInformationMessage(
      'STPresetEditor: enter your own Cloudflare Worker URL to turn on the cloud.',
      'Set cloud URL',
    )
    .then((choice) => {
      if (choice === 'Set cloud URL') {
        vscode.commands.executeCommand('workbench.action.openSettings', 'stpe.cloudUrl');
      }
    });
}

/** Minimal promise-based HTTP(S) request (no dependency on global fetch). */
function httpRequest(urlStr, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlStr);
    } catch (error) {
      reject(error);
      return;
    }
    const lib = url.protocol === 'http:' ? require('http') : require('https');
    // Encode the request body as UTF-8 bytes with an explicit length so
    // multi-byte characters cross the wire intact (no chunked-encoding guesswork).
    const payload = body == null ? null : Buffer.from(String(body), 'utf8');
    const finalHeaders = { ...headers };
    if (payload) finalHeaders['content-length'] = String(payload.length);
    const req = lib.request(url, { method, headers: finalHeaders, timeout: 10000 }, (res) => {
      // Collect raw bytes and decode ONCE at the end. Decoding per-chunk
      // (`data += chunk`) corrupts any multi-byte UTF-8 character that straddles
      // a chunk boundary into replacement chars — the "���" corruption bug.
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () =>
        resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }),
      );
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    if (payload) req.write(payload);
    req.end();
  });
}

/** GET the cloud index: [{ name, updatedAt }]. Throws when unreachable. */
async function cloudGetIndex() {
  const res = await httpRequest(presetsUrl(), {
    headers: { accept: 'application/json', 'X-API-Key': cloudKey },
  });
  if (res.status !== 200) throw new Error(`http_${res.status}`);
  const parsed = JSON.parse(res.body);
  return Array.isArray(parsed.presets) ? parsed.presets : [];
}

/** GET one named preset record, or null when it does not exist. */
async function cloudGetOne(name) {
  if (!name) return null;
  const res = await httpRequest(presetsUrl(name), {
    headers: { accept: 'application/json', 'X-API-Key': cloudKey },
  });
  if (res.status === 404) return null;
  if (res.status !== 200) throw new Error(`http_${res.status}`);
  return JSON.parse(res.body);
}

/** PUT one named preset. `snapshot` keeps the replaced cloud version as a
 *  restorable snapshot. Returns { ok, updatedAt?, existed? }. */
async function cloudPutOne(name, body, { snapshot = false } = {}) {
  if (!cloudConfigured() || !name) return { ok: false };
  const res = await httpRequest(`${presetsUrl(name)}${snapshot ? '?snapshot=1' : ''}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'X-API-Key': cloudKey },
    body: JSON.stringify(body),
  });
  if (res.status !== 200) return { ok: false };
  try {
    const parsed = JSON.parse(res.body);
    return { ok: true, updatedAt: parsed.updatedAt, existed: Boolean(parsed.existed) };
  } catch {
    return { ok: true };
  }
}

/** DELETE one named preset. Returns { ok }. */
async function cloudDeleteOne(name) {
  if (!cloudConfigured() || !name) return { ok: false };
  const res = await httpRequest(presetsUrl(name), {
    method: 'DELETE',
    headers: { 'X-API-Key': cloudKey },
  });
  return { ok: res.status === 200 };
}

/** Validate an API key against the worker's /api/auth/me. */
async function validateKey(key) {
  const url = meUrl();
  if (!url) return { ok: false, reason: 'no_url' };
  if (!key) return { ok: false, reason: 'no_key' };
  try {
    const res = await httpRequest(url, {
      headers: { accept: 'application/json', 'X-API-Key': key },
    });
    if (res.status !== 200) {
      return { ok: false, reason: res.status === 401 ? 'invalid_key' : `http_${res.status}` };
    }
    let parsed = {};
    try {
      parsed = JSON.parse(res.body);
    } catch {
      return { ok: false, reason: 'bad_response' };
    }
    if (parsed && parsed.authenticated) return { ok: true, email: parsed.email || '' };
    return { ok: false, reason: 'invalid_key' };
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
}

/** Report the current cloud config (URL to prefill + connection status). The
 *  stored key is never sent back to the webview. */
async function sendCloudState(panel) {
  if (keyLoad) await keyLoad.catch(() => {}); // reflect the stored key, not the race
  const url = cloudUrlRaw();
  if (!cloudKey || !apiBase()) {
    panel.webview.postMessage({ type: 'cloudState', url, connected: false, email: '' });
    return;
  }
  const r = await validateKey(cloudKey);
  panel.webview.postMessage({ type: 'cloudState', url, connected: r.ok, email: r.email || '' });
}

/** Persist a URL + API key from the panel, validate, and report the result. */
async function handleConnect(panel, message) {
  const url = typeof message.url === 'string' ? message.url.trim() : '';
  const key = typeof message.key === 'string' ? message.key.trim() : '';
  if (url) await setStoredUrl(url);

  const candidate = key || cloudKey;
  const r = await validateKey(candidate);
  // Only persist a key that actually authenticates (never clobber a working key
  // with a bad paste).
  if (r.ok) await setStoredKey(candidate);

  panel.webview.postMessage({
    type: 'cloudReady',
    ok: r.ok,
    email: r.email || '',
    reason: r.reason || '',
    url: cloudUrlRaw(),
  });
  if (key && !apiBase()) nudgeForCloudUrl();
}

async function handleDisconnect(panel) {
  await setStoredKey('');
  panel.webview.postMessage({
    type: 'cloudReady',
    ok: false,
    email: '',
    reason: 'disconnected',
    url: cloudUrlRaw(),
  });
}

// --- Webview HTML -------------------------------------------------------------

function getNonce() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i += 1) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}

/**
 * Build the webview HTML from the Vite build (base:'./'): rewrite relative
 * asset URLs to webview-safe URIs, strip `crossorigin`, nonce the scripts, and
 * attach a matching CSP (`'strict-dynamic'` lets the entry module load chunks).
 * The webview makes no outbound network calls (cloud HTTP is host-side), so the
 * CSP keeps connect-src to the webview's own resources only.
 */
function getWebviewHtml(webview, mediaUri, mode = 'file') {
  const indexPath = vscode.Uri.joinPath(mediaUri, 'index.html');
  let html;
  try {
    html = fs.readFileSync(indexPath.fsPath, 'utf8');
  } catch (error) {
    return `<!doctype html><html><body style="font-family:sans-serif;padding:2rem">
      <h2>STPresetEditor UI not built</h2>
      <p>Run <code>npm run build:webview</code> in the repo root, then reopen this preset.</p>
      <pre>${String(error)}</pre></body></html>`;
  }

  const nonce = getNonce();
  html = html
    .replace(/(href|src)="\.\/([^"]+)"/g, (_match, attr, rel) => {
      const assetUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, rel));
      return `${attr}="${assetUri}"`;
    })
    .replace(/\s+crossorigin(?:="[^"]*")?/g, '')
    .replace(/<script\b/g, `<script nonce="${nonce}"`);

  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} https: data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource} data:`,
    `script-src 'nonce-${nonce}' 'strict-dynamic'`,
    `connect-src ${webview.cspSource}`,
  ].join('; ');

  // Inject the editor mode before the app bundle runs (deferred module), so the
  // Vue app knows from first paint whether it is file-backed or the cloud browser.
  const modeScript = `<script nonce="${nonce}">window.__STPE_MODE__=${JSON.stringify(
    mode === 'library' ? 'library' : 'file',
  )};</script>`;

  return html.replace(
    /<head>/i,
    `<head>\n  <meta http-equiv="Content-Security-Policy" content="${csp}">\n  ${modeScript}`,
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
