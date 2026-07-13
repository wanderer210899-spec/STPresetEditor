// Phase 6 (F8a unified undo/redo + F8c keyboard shortcuts) tests.
//
// Covers: delete/undo/redo round-trip (position + collapse state), text-edit
// coalescing, reorder/toggle undo, the HISTORY_LIMIT cap, history clearing on
// document switches, batch-replace absorption, variable-rename undo, and the
// global shortcut handler's editable-field / modal guards.

import { randomUUID } from 'node:crypto';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HISTORY_LIMIT, usePresetStore } from '../src/stores/presetStore';
import { createShortcutHandler } from '../src/utils/shortcuts';

// happy-dom may not expose crypto.randomUUID; the store relies on it.
if (typeof window.crypto?.randomUUID !== 'function') {
  Object.defineProperty(window, 'crypto', {
    value: { ...(window.crypto || {}), randomUUID },
    configurable: true,
  });
}

let store;

function seedActiveArea() {
  store.rawJson = '{"prompts":[]}';
  store.originalFilename = 'test.json';
  store.prompts = {
    a: { id: 'a', identifier: 'a', name: 'Alpha', content: 'hello', enabled: true },
    b: { id: 'b', identifier: 'b', name: 'Beta', content: 'world', enabled: true },
  };
  store.promptOrder = ['a', 'b'];
}

beforeEach(() => {
  vi.useFakeTimers();
  setActivePinia(createPinia());
  store = usePresetStore();
  seedActiveArea();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe('F8a unified undo/redo', () => {
  it('restores a deleted prompt at its position with its collapse state, then redoes', () => {
    store.promptCollapseStates.a = true;
    store.removePrompt('a');
    expect(store.prompts.a).toBeUndefined();
    expect(store.promptOrder).toEqual(['b']);
    expect(store.canUndo).toBe(true);

    expect(store.undo()).toBe(true);
    expect(store.prompts.a.content).toBe('hello');
    expect(store.promptOrder).toEqual(['a', 'b']); // same position
    expect(store.promptCollapseStates.a).toBe(true);

    expect(store.redo()).toBe(true);
    expect(store.prompts.a).toBeUndefined();
    expect(store.promptOrder).toEqual(['b']);
  });

  it('coalesces rapid text edits into one step, splits after the window', () => {
    store.updatePromptDetail({ promptId: 'a', field: 'content', value: 'h1' });
    store.updatePromptDetail({ promptId: 'a', field: 'content', value: 'h2' });
    expect(store.undoStack).toHaveLength(1);

    vi.advanceTimersByTime(1500);
    store.updatePromptDetail({ promptId: 'a', field: 'content', value: 'h3' });
    expect(store.undoStack).toHaveLength(2);

    store.undo();
    expect(store.prompts.a.content).toBe('h2');
    store.undo();
    expect(store.prompts.a.content).toBe('hello');
    store.redo();
    expect(store.prompts.a.content).toBe('h2');
  });

  it('undoes reordering and enable toggles', () => {
    store.movePromptBottom('a');
    expect(store.promptOrder).toEqual(['b', 'a']);
    store.undo();
    expect(store.promptOrder).toEqual(['a', 'b']);

    store.togglePromptEnabled('a');
    expect(store.prompts.a.enabled).toBe(false);
    store.undo();
    expect(store.prompts.a.enabled).toBe(true);
  });

  it(`caps the stack at ${HISTORY_LIMIT} steps`, () => {
    for (let i = 0; i < HISTORY_LIMIT + 10; i += 1) {
      store.togglePromptEnabled('a');
    }
    expect(store.undoStack).toHaveLength(HISTORY_LIMIT);
  });

  it('clears history when a cloud copy of the OPEN preset is adopted', () => {
    store.saveActivePreset(); // link the active area to a library entry
    store.togglePromptEnabled('a');
    expect(store.canUndo).toBe(true);
    const name = store.savedPresets[store.currentPresetId].name;
    store.adoptCloudEntry({
      name,
      updatedAt: '2099-01-01T00:00:00.000Z',
      data: {
        rawJson: '{"prompts":[]}',
        originalFilename: 'test.json',
        prompts: {
          a: { id: 'a', identifier: 'a', name: 'Alpha', content: 'cloud', enabled: true },
        },
        promptOrder: ['a'],
      },
    });
    expect(store.prompts.a.content).toBe('cloud'); // the open editor reloaded
    expect(store.canUndo).toBe(false);
    expect(store.canRedo).toBe(false);
  });

  it('absorbs batch replace into the unified stack (modal buttons still work)', () => {
    store.prompts.a.content = 'foo bar';
    const result = store.batchReplaceText({
      find: 'foo',
      replace: 'baz',
      targetFields: { content: true },
      scope: 'all',
    });
    expect(result.matches).toBe(1);
    expect(store.canUndoBatchReplace).toBe(true);

    const undone = store.undoLastBatchChange();
    expect(undone.prompts).toBe(1);
    expect(store.prompts.a.content).toBe('foo bar');
    expect(store.canRedoBatchReplace).toBe(true);

    store.redoLastBatchChange();
    expect(store.prompts.a.content).toBe('baz bar');
  });

  it('undoes and redoes a variable rename', () => {
    store.prompts.a.content = '{{setvar::x::1}} {{getvar::x}}';
    store.analyzeAllMacros();
    expect(store.renameVariable({ oldName: 'x', newName: 'y' })).toBe(true);
    expect(store.prompts.a.content).toContain('{{getvar::y}}');

    store.undo();
    expect(store.prompts.a.content).toContain('{{getvar::x}}');
    store.redo();
    expect(store.prompts.a.content).toContain('{{getvar::y}}');
  });
});

describe('F8c shortcut handler', () => {
  const makeEvent = (props) => ({
    key: '',
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    target: document.body,
    preventDefault: vi.fn(),
    ...props,
  });

  it('Ctrl+Z undoes outside editable fields but stays quiet inside them', () => {
    store.togglePromptEnabled('a');
    const handler = createShortcutHandler(store);

    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    handler(makeEvent({ key: 'z', ctrlKey: true, target: textarea }));
    expect(store.prompts.a.enabled).toBe(false); // untouched — native undo wins

    handler(makeEvent({ key: 'z', ctrlKey: true }));
    expect(store.prompts.a.enabled).toBe(true); // undone
    textarea.remove();
  });

  it('Ctrl+Shift+Z and Ctrl+Y both redo', () => {
    store.togglePromptEnabled('a');
    const handler = createShortcutHandler(store);

    handler(makeEvent({ key: 'z', ctrlKey: true }));
    handler(makeEvent({ key: 'z', ctrlKey: true, shiftKey: true }));
    expect(store.prompts.a.enabled).toBe(false);

    handler(makeEvent({ key: 'z', ctrlKey: true }));
    handler(makeEvent({ key: 'y', ctrlKey: true }));
    expect(store.prompts.a.enabled).toBe(false);
  });

  it('N creates a prompt only when no modal is open and not typing', () => {
    const initialCount = Object.keys(store.prompts).length;
    const handler = createShortcutHandler(store);

    store.isSettingsModalOpen = true;
    handler(makeEvent({ key: 'n' }));
    expect(Object.keys(store.prompts)).toHaveLength(initialCount);

    store.isSettingsModalOpen = false;
    handler(makeEvent({ key: 'n' }));
    expect(Object.keys(store.prompts)).toHaveLength(initialCount + 1);
  });

  it('Ctrl+E toggles display mode and ? opens the help modal', () => {
    const handler = createShortcutHandler(store);
    expect(store.macroDisplayMode).toBe('raw');
    handler(makeEvent({ key: 'e', ctrlKey: true }));
    expect(store.macroDisplayMode).toBe('preview');

    handler(makeEvent({ key: '?' }));
    expect(store.isShortcutsHelpOpen).toBe(true);
  });

  it('Alt+ArrowDown moves the selected prompt one step (undoable)', () => {
    store.selectPrompt('a');
    const handler = createShortcutHandler(store);
    handler(makeEvent({ key: 'ArrowDown', altKey: true }));
    expect(store.promptOrder).toEqual(['b', 'a']);
    store.undo();
    expect(store.promptOrder).toEqual(['a', 'b']);
  });
});
