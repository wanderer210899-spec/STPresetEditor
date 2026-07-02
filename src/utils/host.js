/**
 * Host-environment detection, dependency-free so any store/component can use it
 * without import cycles (localBridge imports presetStore, which needs this).
 */

/** True when running inside a Cursor/VSCode webview (extension host mode). */
export function isVsCodeHost() {
  return typeof window !== 'undefined' && typeof window.acquireVsCodeApi === 'function';
}
