// STPresetEditor — local-files + cloud extension host (M0 + M1 + M2c).
//
// Responsibilities:
//   • Open a .json preset in a webview that hosts the STPresetEditor Vue UI.
//   • Read the file → webview ({type:'load'}); write edits back atomically
//     ({type:'save'}).
//   • Cloud sync (M2c): the HOST does the Cloudflare HTTP over Node (no browser
//     CORS, no worker change). On edit it PUSHES the current preset with a safe
//     read-merge-write that never touches the rest of your cloud library; a
//     "Pull preset from cloud" command brings another device's edits down.
//
// Plain CommonJS so it runs with no compile step.
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

// Default cloud endpoint; override per-user via the `stpe.cloudUrl` setting.
const DEFAULT_CLOUD_URL = 'https://stpreseteditor-deploy.wanderer210899.workers.dev/api/presets';
// Keys of the current preset we mirror to the cloud (a subset of the app's
// SYNC_DATA_PATHS). Merging only these preserves savedPresets/prefs on the cloud.
const CLOUD_ORIGIN = 'https://stpreseteditor-deploy.wanderer210899.workers.dev';

// One webview per file path, so re-opening a file reveals the existing panel.
const panels = new Map();
let statusBar; // file-save confirmation
let statusBarPull; // clickable "Pull preset from cloud"
let activePanel = null; // last-focused STPE webview (pull target)
let cloudKey = ''; // passphrase, relayed from the webview Settings

function activate(context) {
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarPull = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  statusBarPull.command = 'stpe.pullFromCloud';
  statusBarPull.text = '$(cloud-download) Pull preset';
  statusBarPull.tooltip = 'Load the latest version of this preset from your cloud';
  context.subscriptions.push(statusBar, statusBarPull);

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
  if (panel && cloudKey) statusBarPull.show();
  else statusBarPull.hide();
}

function handleMessage(message, panel, filePath) {
  if (!message || typeof message !== 'object') return;
  switch (message.type) {
    case 'ready':
      sendLoad(panel, filePath);
      break;
    case 'save':
      handleSave(filePath, message.json);
      break;
    case 'cloudConfig':
      cloudKey = typeof message.key === 'string' ? message.key : '';
      if (activePanel && cloudKey) statusBarPull.show();
      else statusBarPull.hide();
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

// --- Cloud sync (M2c) ---------------------------------------------------------

function cloudUrl() {
  const cfg = vscode.workspace.getConfiguration('stpe').get('cloudUrl');
  return typeof cfg === 'string' && cfg.trim() ? cfg.trim() : DEFAULT_CLOUD_URL;
}

/** Minimal promise-based HTTPS request (no dependency on global fetch). */
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

async function cloudGet() {
  if (!cloudKey) return null;
  const res = await httpRequest(cloudUrl(), {
    headers: { accept: 'application/json', 'X-Sync-Key': cloudKey },
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
  if (!cloudKey || !data || typeof data !== 'object') return { ok: false };
  let base = {};
  try {
    const doc = await cloudGet();
    if (doc && doc.data && typeof doc.data === 'object') base = doc.data;
  } catch {
    // No existing doc / unreachable on GET — start a fresh document.
  }
  const updatedAt = new Date().toISOString();
  const body = JSON.stringify({ updatedAt, data: { ...base, ...data } });
  const res = await httpRequest(cloudUrl(), {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'X-Sync-Key': cloudKey },
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
  if (!cloudKey) {
    vscode.window.showWarningMessage(
      'STPresetEditor: enter your cloud passphrase in the editor’s Settings (Cloud sync) first.',
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
    `connect-src ${webview.cspSource} ${CLOUD_ORIGIN}`,
  ].join('; ');

  return html.replace(
    /<head>/i,
    `<head>\n  <meta http-equiv="Content-Security-Policy" content="${csp}">`,
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
