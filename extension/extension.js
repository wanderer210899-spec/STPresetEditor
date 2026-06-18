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
//     user pastes their own Worker URL + key. On edit it PUSHES the current
//     preset with a safe read-merge-write that never touches the rest of the
//     cloud library; "Pull preset from cloud" brings another device's edits down.
//
// Plain CommonJS so it runs with no compile step.
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

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
  statusBarPull.text = '$(cloud-download) Pull preset';
  statusBarPull.tooltip = 'Load the latest version of this preset from your cloud';
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
  if (activePanel && cloudConfigured()) statusBarPull.show();
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
      cloudPush(message.data)
        .then((r) =>
          panel.webview.postMessage({ type: 'cloudAck', ok: r.ok, updatedAt: r.updatedAt }),
        )
        .catch(() => panel.webview.postMessage({ type: 'cloudAck', ok: false }));
      break;
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
 * Push the current preset to the cloud with a read-merge-write: fetch the
 * existing document and overlay ONLY the current-preset fields, so the rest of
 * the cloud library (savedPresets, prefs) is preserved untouched.
 */
async function cloudPush(data) {
  if (!cloudConfigured() || !data || typeof data !== 'object') return { ok: false };
  let base = {};
  try {
    const doc = await cloudGet();
    if (doc && doc.data && typeof doc.data === 'object') base = doc.data;
  } catch {
    // No existing doc / unreachable on GET — start a fresh document.
  }
  const updatedAt = new Date().toISOString();
  const body = JSON.stringify({ updatedAt, data: { ...base, ...data } });
  const res = await httpRequest(presetsUrl(), {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'X-API-Key': cloudKey },
    body,
  });
  return { ok: res.status === 200, updatedAt };
}

/** Command: fetch the cloud preset and load it into the active editor. */
async function pullFromCloud() {
  if (!activePanel) {
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
  try {
    const doc = await cloudGet();
    if (!doc || !doc.data || typeof doc.data.rawJson !== 'string') {
      vscode.window.showInformationMessage('STPresetEditor: nothing saved in the cloud yet.');
      return;
    }
    activePanel.webview.postMessage({
      type: 'cloudPulled',
      data: doc.data,
      updatedAt: doc.updatedAt,
    });
    vscode.window.showInformationMessage(
      'STPresetEditor: pulled the latest preset from your cloud.',
    );
  } catch (error) {
    vscode.window.showErrorMessage(`STPresetEditor: cloud pull failed — ${error.message}`);
  }
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
