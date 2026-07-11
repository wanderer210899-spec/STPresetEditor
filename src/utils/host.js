/**
 * Host-environment detection, dependency-free so any store/component can use it
 * without import cycles (localBridge imports presetStore, which needs this).
 */

/** True when running inside a Cursor/VSCode webview (extension host mode). */
export function isVsCodeHost() {
  return typeof window !== 'undefined' && typeof window.acquireVsCodeApi === 'function';
}

/**
 * Which kind of editor this webview is:
 *   'web'     — the browser SPA (or dev server); no host bridge.
 *   'file'    — an extension webview mirroring ONE local .json (the open file
 *               is the active editing area; it is never a library entry).
 *   'library' — a standalone extension editor with no file attached; the active
 *               area IS a library preset, autosaved + cloud-synced like the web
 *               app (the difference is only that cloud rides the host bridge).
 *
 * The host injects `window.__STPE_MODE__` before the app bundle runs, so this is
 * synchronous and race-free from first paint. A webview with no injected mode
 * defaults to 'file' — that is the historical behaviour of `stpe.open`.
 */
export function getEditorMode() {
  if (!isVsCodeHost()) return 'web';
  return typeof window !== 'undefined' && window.__STPE_MODE__ === 'library' ? 'library' : 'file';
}

/** True only for a file-backed extension webview (the open file is the document). */
export function isFileHost() {
  return getEditorMode() === 'file';
}

/** True for the standalone, file-less extension editor (behaves like the web app). */
export function isLibraryHost() {
  return getEditorMode() === 'library';
}
