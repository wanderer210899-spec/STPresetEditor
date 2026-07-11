// Global keyboard shortcuts (F8c). Registered once from App.vue.
//
// Explicitly global (also fire while typing in a field): Ctrl/Cmd+F,
// Ctrl/Cmd+K, Ctrl/Cmd+S. Everything else stays quiet while focus is in an
// editable field, so native text editing — including the browser's own text
// undo — wins inside inputs and textareas.

export function isEditableTarget(target) {
  if (!target || !(target instanceof Element)) return false;
  const tag = target.tagName;
  return (
    tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true
  );
}

export function createShortcutHandler(store) {
  return (event) => {
    const mod = event.ctrlKey || event.metaKey;
    const editable = isEditableTarget(event.target);
    const key = event.key;

    if (mod && !event.altKey) {
      const k = key.toLowerCase();
      if (k === 'z' && !event.shiftKey) {
        if (editable) return; // native text undo applies inside fields
        event.preventDefault();
        store.undo();
        return;
      }
      if ((k === 'z' && event.shiftKey) || k === 'y') {
        if (editable) return;
        event.preventDefault();
        store.redo();
        return;
      }
      if (k === 'f' && !event.shiftKey && !store.isGlobalSearchOpen) {
        event.preventDefault();
        const input = document.getElementById('editor-search-input');
        input?.focus();
        input?.select?.();
        return;
      }
      if (k === 'k') {
        event.preventDefault();
        store.openGlobalSearch();
        return;
      }
      if (k === 's') {
        event.preventDefault(); // never let the browser "save page"
        const snapshotId = store.createSnapshot();
        if (snapshotId) store.showToast(store.t('shortcuts.snapshotSaved'), 'success');
        return;
      }
      if (k === 'e') {
        if (editable) return;
        event.preventDefault();
        store.toggleMacroDisplayMode();
        return;
      }
      return;
    }

    if (event.altKey && (key === 'ArrowUp' || key === 'ArrowDown')) {
      if (editable || !store.selectedPromptId) return;
      event.preventDefault();
      store.moveSelectedPrompt(key === 'ArrowUp' ? -1 : 1);
      return;
    }

    // Single-key shortcuts: only when not typing and nothing modal is open.
    if (!mod && !event.altKey && !editable && !store.isAnyModalOpen) {
      if (key === 'n' || key === 'N') {
        event.preventDefault();
        store.createNewPrompt();
        return;
      }
      if (key === '?') {
        event.preventDefault();
        store.openShortcutsHelp();
      }
    }
  };
}

/** Attach the handler; returns the cleanup function. */
export function registerShortcuts(store) {
  const handler = createShortcutHandler(store);
  window.addEventListener('keydown', handler);
  return () => window.removeEventListener('keydown', handler);
}
