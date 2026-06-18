// STPresetEditor — local-files extension host (M0 + M1).
//
// Responsibilities:
//   • Command "stpe.open" opens a .json preset in a webview that hosts the
//     STPresetEditor Vue UI (built into ./media by `npm run build:webview`).
//   • Reads the file and sends it to the webview ({ type: 'load' }).
//   • Receives edits from the webview ({ type: 'save' }) and writes them back
//     to the same file atomically.
//
// Written as plain CommonJS so it runs in the Extension Development Host with no
// compile step. (A TypeScript + esbuild setup can come later — see EXTENSION_PLAN.md.)
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

// The cloud origin (for M2c). Listed in connect-src now so cloud sync can be
// wired without touching CSP later. Not used for I/O in this phase.
const CLOUD_ORIGIN = 'https://stpreseteditor-deploy.wanderer210899.workers.dev';

// One webview per file path, so re-opening a file reveals the existing panel.
const panels = new Map();
let statusBar;

function activate(context) {
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand('stpe.open', (uri) => {
      const filePath = resolveTargetPath(uri);
      if (filePath) openEditor(context, filePath);
    }),
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
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [mediaUri],
    },
  );
  panels.set(filePath, panel);
  panel.onDidDispose(() => panels.delete(filePath), null, context.subscriptions);

  panel.webview.onDidReceiveMessage(
    (message) => {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'ready') {
        sendLoad(panel, filePath);
      } else if (message.type === 'save') {
        handleSave(filePath, message.json);
      }
    },
    undefined,
    context.subscriptions,
  );

  panel.webview.html = getWebviewHtml(panel.webview, mediaUri);
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

function getNonce() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i += 1) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}

/**
 * Build the webview HTML from the Vite build (base:'./'):
 *   • rewrite relative asset URLs to webview-safe URIs,
 *   • strip `crossorigin` (webview resources aren't CORS-fetched),
 *   • add a nonce to scripts and a matching CSP.
 * `script-src 'strict-dynamic'` lets the nonced entry module pull in its
 * code-split chunks (e.g. the dynamic import of example.json).
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
