/**
 * Cloud-library hooks — a tiny registry that lets the preset store notify the
 * cloud layer about EXPLICIT library-management actions (delete, rename)
 * without importing it (cloudSync imports the store, so a direct import would
 * be a cycle).
 *
 * Only the VS Code "cloud browser" (library-mode webview) registers hooks:
 * there the saved-preset list mirrors the cloud, so deleting or renaming an
 * entry is an explicit operation ON the cloud and must reach it immediately.
 * The web app leaves this unset — its change-subscription diff engine already
 * propagates deletes and renames. Content edits never flow through hooks
 * anywhere: in the extension they only reach the cloud via the explicit
 * "Send to cloud" action.
 */

let hooks = null;

/** Register (or clear, with null) the active hook set:
 *  `{ onDeleted(name), onRenamed(oldName, newName) }`. */
export function setCloudLibraryHooks(next) {
  hooks = next || null;
}

/** The registered hook set, or null when no runtime needs them. */
export function cloudLibraryHooks() {
  return hooks;
}
