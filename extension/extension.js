// STPresetEditor — local-files + cloud extension host (M0 + M1 + A4 auth).
//
// Responsibilities:
//   • Open a .json preset in a webview that hosts the STPresetEditor Vue UI.
//   • Read the file → webview ({type:'load'}); write edits back atomically
//     ({type:'save'}).
//   • Cloud sync (opt-in, account auth): the HOST does the Cloudflare HTTP over
//     Node (no browser CORS, no worker change). The webview can't ride the web
//     app's login cookie (different origin), so the extension authenticates with
//     a generated **API key** (`X-API-Key`) the user creates in the web app
//     (Settings → Cloud sync → generate a key). The key lives in VS Code
//     SecretStorage (encrypted), never in the repo and never echoed to the
//     webview. There is NO built-in endpoint: nothing is sent anywhere until the
//     user pastes their own Worker URL + key. The cloud is the central drive for
//     the preset LIBRARY only (savedPresets + prefs) — the open file stays local.
//     The reconcile engine (seed/adopt-newer/flush, conflict dialog) lives in the
//     webview (shared with the web app); this host is just the Node HTTP
//     TRANSPORT: cloudPullRequest -> GET, cloudPush -> read-merge-write PUT. The
//     PUT overlays only the library keys the webview sends, never the open file.
//     When the webview sends baseUpdatedAt, the push is CONDITIONAL: a cloud doc
//     newer than that base returns {conflict:true} instead of overwriting.
//
//   • Folder workspace (F5): an Explorer "ST Presets" tree of the workspace's
//     preset .json files (New/Duplicate/Rename/Delete/Reveal), and an opt-in
//     folder↔cloud-library link driven by a `.stpe-library.json` mapping file
//     ({ files: { "<relative path>": { presetId, lastSyncedHash } } }). Pure
//     conversion/decision logic lives in ./presetFolder.js (unit-tested).
//
// Plain CommonJS so it runs with no compile step.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const folderLib = require('./presetFolder');

const SECRET_KEY = 'stpe.apiKey';

// One webview per file path, so re-opening a file reveals the existing panel.
const panels = new Map();
let extensionContext = null; // for SecretStorage access
let statusBar; // file-save confirmation
let statusBarPull; // clickable "Pull preset from cloud"
let activePanel = null; // last-focused STPE webview (pull target)
let cloudKey = ''; // API key, cached from SecretStorage
let urlPromptShown = false; // one-time nudge to configure the cloud URL

function activate(context) {
  extensionContext = context;
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarPull = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  statusBarPull.command = 'stpe.pullFromCloud';
  statusBarPull.text = '$(cloud-download) Sync library';
  statusBarPull.tooltip = 'Pull the latest preset library from your cloud';
  context.subscriptions.push(statusBar, statusBarPull);

  // Load the stored API key (async) so cloud sync can resume without re-entry.
  context.secrets.get(SECRET_KEY).then((key) => {
    cloudKey = key || '';
    refreshPullStatusBar();
  });

  context.subscriptions.push(
    vscode.commands.registerCommand('stpe.open', (uri) => {
      const filePath = resolveTargetPath(uri);
      if (filePath) openEditor(context, filePath);
    }),
    vscode.commands.registerCommand('stpe.pullFromCloud', pullFromCloud),
  );

  // --- F5a: ST Presets tree + watcher ---
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
    vscode.commands.registerCommand('stpe.linkFolder', linkFolder),
    vscode.commands.registerCommand('stpe.syncFolder', () =>
      reconcileFolder({ interactive: true }),
    ),
    vscode.commands.registerCommand('stpe.downloadMissing', downloadMissingPresets),
    vscode.commands.registerCommand('stpe.downloadPreset', (item) =>
      downloadMissingPresets(item && item.presetId ? item.presetId : undefined),
    ),
  );
  setupWatcher(context);
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('stpe.presetGlob')) setupWatcher(context);
    }),
  );

  // F5b: reconcile on the F2 cadence while a panel is open (and once at start).
  const interval = setInterval(() => {
    if (panels.size > 0) reconcileFolder({ interactive: false });
  }, 30000);
  context.subscriptions.push({ dispose: () => clearInterval(interval) });
  reconcileFolder({ interactive: false });
}

// --- F5a: Presets tree ---------------------------------------------------------

let treeProvider = null;
let watcher = null;
let reconcileTimer = null;
/** relPath -> { label, icon, tooltip } from the last reconcile. */
let fileStates = new Map();
/** Cloud entries with no mapped file, from the last reconcile. */
let cloudOnlyEntries = [];

const FILE_STATES = {
  synced: { label: 'synced', icon: 'check' },
  pending: { label: 'pending ↑', icon: 'arrow-up' },
  conflict: { label: 'conflict ⚠', icon: 'warning' },
  localOnly: { label: 'local-only', icon: 'file' },
  cloudOnly: { label: 'cloud-only', icon: 'cloud' },
};

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
    if (path.basename(uri.fsPath) === folderLib.MAPPING_FILENAME) continue;
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
    const items = files.map((fsPath) => ({
      kind: 'file',
      fsPath,
      rel: root ? path.relative(root, fsPath) : path.basename(fsPath),
    }));
    cloudOnlyEntries.forEach((entry) =>
      items.push({ kind: 'cloud', presetId: entry.presetId, name: entry.name }),
    );
    return items;
  }
  getTreeItem(entry) {
    if (entry.kind === 'cloud') {
      const item = new vscode.TreeItem(entry.name || entry.presetId);
      item.description = FILE_STATES.cloudOnly.label;
      item.iconPath = new vscode.ThemeIcon(FILE_STATES.cloudOnly.icon);
      item.contextValue = 'stpeCloudPreset';
      item.tooltip = 'In the cloud library but not in this folder — download to create the file.';
      return item;
    }
    const item = new vscode.TreeItem(path.basename(entry.fsPath));
    item.resourceUri = vscode.Uri.file(entry.fsPath);
    item.contextValue = 'stpePreset';
    item.command = {
      command: 'stpe.open',
      title: 'Open in STPresetEditor',
      arguments: [vscode.Uri.file(entry.fsPath)],
    };
    const state = fileStates.get(entry.rel);
    if (state) {
      item.description = state.label;
      item.iconPath = new vscode.ThemeIcon(state.icon);
    } else {
      item.iconPath = new vscode.ThemeIcon('json');
    }
    return item;
  }
}

function setupWatcher(context) {
  if (watcher) watcher.dispose();
  watcher = vscode.workspace.createFileSystemWatcher(presetGlob());
  const onFsEvent = (uri) => {
    if (uri && path.basename(uri.fsPath) === folderLib.MAPPING_FILENAME) return;
    if (treeProvider) treeProvider.refresh();
    scheduleReconcile();
  };
  watcher.onDidCreate(onFsEvent);
  watcher.onDidChange(onFsEvent);
  watcher.onDidDelete(onFsEvent);
  context.subscriptions.push(watcher);
  if (treeProvider) treeProvider.refresh();
}

/** Debounced follow-up reconcile after file events (save/create/delete). */
function scheduleReconcile() {
  if (!folderLinked() || !cloudConfigured()) return;
  clearTimeout(reconcileTimer);
  reconcileTimer = setTimeout(() => reconcileFolder({ interactive: false }), 2000);
}

// --- F5a: tree file operations --------------------------------------------------

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
  scheduleReconcile();
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
  scheduleReconcile();
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
  // Keep the cloud mapping attached to the renamed file.
  const mapping = readMapping();
  const root = workspaceRoot();
  if (mapping && root) {
    const oldRel = path.relative(root, item.fsPath);
    const newRel = path.relative(root, target);
    if (mapping.files[oldRel]) {
      mapping.files[newRel] = mapping.files[oldRel];
      delete mapping.files[oldRel];
      writeMapping(mapping);
    }
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
  // Deleting a file never deletes the cloud entry without an explicit prompt.
  const mapping = readMapping();
  const root = workspaceRoot();
  if (mapping && root) {
    const rel = path.relative(root, item.fsPath);
    const m = mapping.files[rel];
    if (m) {
      delete mapping.files[rel];
      writeMapping(mapping);
      if (cloudConfigured()) {
        const choice = await vscode.window.showWarningMessage(
          `Also delete "${base}" from the cloud library? (Keep = it stays available as cloud-only.)`,
          'Keep in cloud',
          'Delete from cloud',
        );
        if (choice === 'Delete from cloud') {
          await removeCloudEntry(m.presetId);
        }
      }
    }
  }
  if (treeProvider) treeProvider.refresh();
  scheduleReconcile();
}

/** Read-merge-write removal of one library entry. */
async function removeCloudEntry(presetId) {
  try {
    const doc = await cloudGet();
    const base = doc && doc.data && typeof doc.data === 'object' ? doc.data : {};
    const savedPresets = { ...(base.savedPresets || {}) };
    if (!(presetId in savedPresets)) return;
    delete savedPresets[presetId];
    await cloudPush({ savedPresets }, (doc && doc.updatedAt) || null);
  } catch {
    vscode.window.showWarningMessage(
      'STPresetEditor: could not update the cloud library (it will re-appear as cloud-only).',
    );
  }
}

// --- F5b: folder <-> cloud library sync ------------------------------------------

function mappingFilePath() {
  const root = workspaceRoot();
  return root ? path.join(root, folderLib.MAPPING_FILENAME) : null;
}

function folderLinked() {
  const p = mappingFilePath();
  return Boolean(p && fs.existsSync(p));
}

function readMapping() {
  const p = mappingFilePath();
  if (!p || !fs.existsSync(p)) return null;
  try {
    return folderLib.normalizeMapping(JSON.parse(fs.readFileSync(p, 'utf8')));
  } catch {
    return folderLib.normalizeMapping(null);
  }
}

function writeMapping(mapping) {
  const p = mappingFilePath();
  if (p) writeFileAtomic(p, JSON.stringify(mapping, null, 2) + '\n');
}

/** Command: create the mapping file and run a first interactive reconcile. */
async function linkFolder() {
  const root = workspaceRoot();
  if (!root) {
    vscode.window.showErrorMessage('STPresetEditor: open a folder first.');
    return;
  }
  if (!cloudConfigured()) {
    if (!apiBase()) nudgeForCloudUrl();
    else {
      vscode.window.showWarningMessage(
        'STPresetEditor: connect cloud sync first (paste an API key in the editor’s Settings → Cloud sync).',
      );
    }
    return;
  }
  if (!folderLinked()) writeMapping({ files: {} });
  await reconcileFolder({ interactive: true });
  vscode.window.showInformationMessage(
    'STPresetEditor: folder linked to your cloud library. ".stpe-library.json" records the mapping — commit it to share the link across machines, or gitignore it to keep it per-machine.',
  );
}

let reconciling = false;

/**
 * Folder <-> cloud library reconcile (F5b): one GET, per-file decisions via
 * content hashes (see presetFolder.decideSyncAction), pulls applied
 * immediately, pushes batched into one conditional PUT, mapping hashes
 * committed only after the PUT lands. Interactive mode prompts per conflicted
 * file (keep local / keep cloud); the background cadence just badges ⚠.
 */
async function reconcileFolder({ interactive = false } = {}) {
  if (reconciling || !folderLinked() || !cloudConfigured()) return;
  const root = workspaceRoot();
  if (!root) return;
  reconciling = true;
  try {
    const doc = await cloudGet();
    const cloudAt = (doc && doc.updatedAt) || null;
    const base = doc && doc.data && typeof doc.data === 'object' ? doc.data : {};
    const savedPresets = { ...(base.savedPresets || {}) };
    const mapping = readMapping() || folderLib.normalizeMapping(null);
    const newStates = new Map();
    const pendingHashUpdates = []; // [rel, hash] — applied only if the PUT lands
    let cloudDirty = false;
    let mappingDirty = false;

    // Auto-map local preset files that are not linked yet (first sync = push).
    const files = await findPresetFiles();
    for (const fsPath of files) {
      const rel = path.relative(root, fsPath);
      if (!mapping.files[rel]) {
        mapping.files[rel] = { presetId: crypto.randomUUID(), lastSyncedHash: '' };
        mappingDirty = true;
      }
    }

    for (const [rel, m] of Object.entries(mapping.files)) {
      const abs = path.join(root, rel);
      let localText = null;
      try {
        localText = fs.readFileSync(abs, 'utf8');
      } catch {
        // file missing — decideSyncAction handles it
      }
      const entry = savedPresets[m.presetId];
      let cloudText = null;
      if (entry && entry.data) {
        try {
          cloudText = folderLib.buildPresetJson(entry.data);
        } catch {
          cloudText = null;
        }
      }
      // Canonical hashes on both sides: the cloud round-trip re-serializes
      // files, so raw-text hashing would flag every synced file as changed.
      const localHash = localText == null ? null : folderLib.canonicalHash(localText);
      const cloudHash = cloudText == null ? null : folderLib.canonicalHash(cloudText);
      let action = folderLib.decideSyncAction({
        localHash,
        cloudHash,
        lastSyncedHash: m.lastSyncedHash,
      });

      if (action === 'conflict' && interactive) {
        const choice = await vscode.window.showWarningMessage(
          `STPresetEditor: "${rel}" changed both locally and in the cloud.`,
          'Keep local',
          'Keep cloud',
        );
        if (choice === 'Keep local') action = 'push';
        else if (choice === 'Keep cloud') action = 'pull';
      }

      if (action === 'push') {
        let parsedData = null;
        try {
          parsedData = folderLib.parsePresetFile(localText);
        } catch {
          // unparseable file — leave it pending, try again next cycle
        }
        if (parsedData) {
          const now = new Date().toISOString();
          const name = (entry && entry.name) || path.basename(rel, '.json');
          savedPresets[m.presetId] = {
            ...(entry || { id: m.presetId, createdAt: now, snapshots: [] }),
            id: m.presetId,
            name,
            updatedAt: now,
            data: {
              ...((entry && entry.data) || {}),
              rawJson: localText,
              originalFilename: path.basename(rel),
              prompts: parsedData.prompts,
              promptOrder: parsedData.promptOrder,
            },
          };
          pendingHashUpdates.push([rel, localHash]);
          cloudDirty = true;
          newStates.set(rel, FILE_STATES.synced);
        } else {
          newStates.set(rel, FILE_STATES.pending);
        }
      } else if (action === 'pull') {
        writeFileAtomic(abs, cloudText);
        m.lastSyncedHash = cloudHash;
        mappingDirty = true;
        newStates.set(rel, FILE_STATES.synced);
      } else if (action === 'conflict') {
        newStates.set(rel, FILE_STATES.conflict);
      } else if (action === 'local-only') {
        newStates.set(rel, FILE_STATES.localOnly);
      } else if (action === 'cloud-only') {
        newStates.set(rel, FILE_STATES.cloudOnly);
      } else {
        // 'none': both sides may have converged — keep hashes current.
        if (localHash && m.lastSyncedHash !== localHash) {
          m.lastSyncedHash = localHash;
          mappingDirty = true;
        }
        newStates.set(rel, FILE_STATES.synced);
      }
    }

    if (cloudDirty) {
      const res = await cloudPush({ savedPresets }, cloudAt);
      if (res && res.ok) {
        pendingHashUpdates.forEach(([rel, hash]) => {
          if (mapping.files[rel]) mapping.files[rel].lastSyncedHash = hash;
        });
        mappingDirty = mappingDirty || pendingHashUpdates.length > 0;
      } else {
        // PUT lost a race or failed — the pushed files stay "pending" and the
        // next cycle retries against the fresh cloud document.
        pendingHashUpdates.forEach(([rel]) => newStates.set(rel, FILE_STATES.pending));
      }
    }

    if (mappingDirty) writeMapping(mapping);

    // Cloud entries with no mapped file → listed as cloud-only tree items.
    const mappedIds = new Set(Object.values(mapping.files).map((m) => m.presetId));
    cloudOnlyEntries = Object.entries(savedPresets)
      .filter(([presetId]) => !mappedIds.has(presetId))
      .map(([presetId, entry]) => ({ presetId, name: (entry && entry.name) || presetId }));

    fileStates = newStates;
    if (treeProvider) treeProvider.refresh();
  } catch (error) {
    if (interactive) {
      vscode.window.showErrorMessage(`STPresetEditor: folder sync failed — ${error.message}`);
    }
  } finally {
    reconciling = false;
  }
}

/**
 * Command: write cloud-only library entries into the folder as `<name>.json`
 * and map them. With a presetId argument, downloads just that entry.
 */
async function downloadMissingPresets(onlyPresetId) {
  const root = workspaceRoot();
  if (!root || !cloudConfigured()) {
    vscode.window.showWarningMessage(
      'STPresetEditor: link the folder and connect cloud sync first.',
    );
    return;
  }
  if (!folderLinked()) writeMapping({ files: {} });
  try {
    const doc = await cloudGet();
    const base = doc && doc.data && typeof doc.data === 'object' ? doc.data : {};
    const savedPresets = base.savedPresets || {};
    const mapping = readMapping() || folderLib.normalizeMapping(null);
    const mappedIds = new Set(Object.values(mapping.files).map((m) => m.presetId));
    const existingNames = fs.readdirSync(root).filter((f) => f.toLowerCase().endsWith('.json'));
    let count = 0;
    for (const [presetId, entry] of Object.entries(savedPresets)) {
      if (mappedIds.has(presetId)) continue;
      if (onlyPresetId && presetId !== onlyPresetId) continue;
      let text;
      try {
        text = folderLib.buildPresetJson((entry && entry.data) || {});
      } catch {
        continue;
      }
      const fileName = folderLib.fileNameForEntry((entry && entry.name) || presetId, existingNames);
      existingNames.push(fileName);
      writeFileAtomic(path.join(root, fileName), text);
      mapping.files[fileName] = { presetId, lastSyncedHash: folderLib.canonicalHash(text) };
      count += 1;
    }
    writeMapping(mapping);
    if (treeProvider) treeProvider.refresh();
    vscode.window.showInformationMessage(
      count > 0
        ? `STPresetEditor: downloaded ${count} preset${count === 1 ? '' : 's'}.`
        : 'STPresetEditor: nothing to download — every cloud preset is already mapped.',
    );
    reconcileFolder({ interactive: false });
  } catch (error) {
    vscode.window.showErrorMessage(`STPresetEditor: download failed — ${error.message}`);
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

function openEditor(context, filePath) {
  const existing = panels.get(filePath);
  if (existing) {
    existing.reveal(vscode.ViewColumn.One);
    return;
  }

  const mediaUri = vscode.Uri.joinPath(context.extensionUri, 'media');
  const panel = vscode.window.createWebviewPanel(
    'stpeEditor',
    path.basename(filePath),
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [mediaUri] },
  );
  panels.set(filePath, panel);
  setActivePanel(panel);

  panel.onDidChangeViewState(
    (e) => {
      if (e.webviewPanel.active) setActivePanel(e.webviewPanel);
    },
    null,
    context.subscriptions,
  );
  panel.onDidDispose(
    () => {
      panels.delete(filePath);
      if (activePanel === panel) setActivePanel(null);
    },
    null,
    context.subscriptions,
  );

  panel.webview.onDidReceiveMessage(
    (message) => handleMessage(message, panel, filePath),
    undefined,
    context.subscriptions,
  );

  panel.webview.html = getWebviewHtml(panel.webview, mediaUri);
}

function setActivePanel(panel) {
  activePanel = panel;
  refreshPullStatusBar();
}

function refreshPullStatusBar() {
  if ((activePanel || folderLinked()) && cloudConfigured()) statusBarPull.show();
  else statusBarPull.hide();
}

function handleMessage(message, panel, filePath) {
  if (!message || typeof message !== 'object') return;
  switch (message.type) {
    case 'ready':
      sendLoad(panel, filePath);
      sendCloudState(panel);
      break;
    case 'save':
      handleSave(filePath, message.json);
      break;
    case 'createFile':
      handleCreateFile(panel, filePath, message);
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
    case 'cloudPush':
      cloudPush(message.data, message.baseUpdatedAt)
        .then((r) =>
          panel.webview.postMessage({
            type: 'cloudAck',
            ok: r.ok,
            conflict: Boolean(r.conflict),
            updatedAt: r.updatedAt,
          }),
        )
        .catch(() => panel.webview.postMessage({ type: 'cloudAck', ok: false }));
      break;
    case 'cloudPullRequest':
      handleCloudGet(panel);
      break;
  }
}

/** Cloud GET transport for the webview's reconcile engine. Always replies with a
 *  'cloudPulled' message: { connected:false } when no key / unreachable (⇒ the
 *  engine stays local-only), or { connected:true, data, updatedAt } otherwise
 *  (data is null for an empty cloud). */
async function handleCloudGet(panel) {
  if (!cloudConfigured()) {
    panel.webview.postMessage({ type: 'cloudPulled', connected: false });
    return;
  }
  try {
    const doc = await cloudGet();
    panel.webview.postMessage({
      type: 'cloudPulled',
      connected: true,
      data: (doc && doc.data) || null,
      updatedAt: (doc && doc.updatedAt) || null,
    });
  } catch {
    // Connected but the GET failed (network) — treat as local-only this round.
    panel.webview.postMessage({ type: 'cloudPulled', connected: false });
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

// --- Cloud sync (account auth) -----------------------------------------------

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

function presetsUrl() {
  const base = apiBase();
  return base ? `${base}/api/presets` : '';
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
      'STPresetEditor: enter your own Cloudflare Worker URL to turn on cloud sync.',
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
    const req = lib.request(url, { method, headers, timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    if (body) req.write(body);
    req.end();
  });
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
  refreshPullStatusBar();
  // The webview's reconcile engine re-runs after this resolves (SyncSetup calls
  // reconnectCloudSync on a successful connect), which pulls the library down.
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
  refreshPullStatusBar();
}

async function cloudGet() {
  if (!cloudConfigured()) return null;
  const res = await httpRequest(presetsUrl(), {
    headers: { accept: 'application/json', 'X-API-Key': cloudKey },
  });
  if (res.status !== 200) return null;
  try {
    return JSON.parse(res.body);
  } catch {
    return null;
  }
}

/**
 * Push the preset library to the cloud with a read-merge-write: fetch the
 * existing document and overlay ONLY the library fields the webview sent
 * (savedPresets + prefs), so the rest of the cloud document — e.g. the web app's
 * active-area fields like rawJson — is preserved untouched.
 *
 * Conflict detection (F2): when the webview passes `baseUpdatedAt` (the cloud
 * timestamp its edits are based on), compare it with the freshly fetched doc
 * BEFORE merging — a mismatch means another device pushed in between, so we
 * return `{ conflict: true }` and let the webview's dialog decide. The PUT then
 * forwards the fetched doc's timestamp as its own `baseUpdatedAt`, so the
 * Worker also rejects a write racing into the GET→PUT window. Calls without
 * `baseUpdatedAt` (old builds, or the "keep mine" override) blind-write.
 */
async function cloudPush(data, baseUpdatedAt) {
  if (!cloudConfigured() || !data || typeof data !== 'object') return { ok: false };
  const conditional = baseUpdatedAt !== undefined;
  let base = {};
  let cloudAt = null;
  try {
    const doc = await cloudGet();
    if (doc && typeof doc === 'object') {
      if (doc.data && typeof doc.data === 'object') base = doc.data;
      cloudAt = doc.updatedAt || null;
    }
  } catch {
    // No existing doc / unreachable on GET — start a fresh document.
  }
  if (conditional && cloudAt !== null && baseUpdatedAt !== cloudAt) {
    return { ok: false, conflict: true, updatedAt: cloudAt };
  }
  const updatedAt = new Date().toISOString();
  const payload = { updatedAt, data: { ...base, ...data } };
  if (conditional) payload.baseUpdatedAt = cloudAt;
  const res = await httpRequest(presetsUrl(), {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'X-API-Key': cloudKey },
    body: JSON.stringify(payload),
  });
  if (res.status === 409) {
    let at = null;
    try {
      at = JSON.parse(res.body).updatedAt || null;
    } catch {
      // Conflict without a readable body — still a conflict.
    }
    return { ok: false, conflict: true, updatedAt: at };
  }
  return { ok: res.status === 200, updatedAt };
}

/** Command (status-bar "Sync library"): ask the active editor to re-reconcile its
 *  library with the cloud, and reconcile the linked folder (F5b). The library
 *  reconcile engine lives in the webview; the host is just the transport, so we
 *  nudge the webview rather than pull directly. */
function pullFromCloud() {
  if (!activePanel && !folderLinked()) {
    vscode.window.showInformationMessage('STPresetEditor: open a preset first.');
    return;
  }
  if (!apiBase()) {
    nudgeForCloudUrl();
    return;
  }
  if (!cloudKey) {
    vscode.window.showWarningMessage(
      'STPresetEditor: connect cloud sync first — paste an API key in the editor’s Settings (Cloud sync).',
    );
    return;
  }
  if (activePanel) activePanel.webview.postMessage({ type: 'cloudReconcile' });
  reconcileFolder({ interactive: true });
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
function getWebviewHtml(webview, mediaUri) {
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

  return html.replace(
    /<head>/i,
    `<head>\n  <meta http-equiv="Content-Security-Policy" content="${csp}">`,
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
