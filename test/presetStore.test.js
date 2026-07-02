// Phase 1 (autosave + snapshots + mandatory fixes) regression tests.
//
// Covers: F1 autosave into the current library entry (with adoption and
// save-as-copy), snapshots (cap + restore-creates-a-snapshot), A2 variable
// rename inside {{if}} conditions, A4 system-prompt delete guards, and the
// no-aliasing guarantee of loadPreset.

import { randomUUID } from 'node:crypto';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_SNAPSHOTS_PER_PRESET, usePresetStore } from '../src/stores/presetStore';

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
    b: {
      id: 'b',
      identifier: 'b',
      name: 'Beta',
      content: 'world',
      enabled: true,
      system_prompt: true,
    },
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

describe('F1 autosave', () => {
  it('adopts the active area into a new library entry on first save', () => {
    expect(store.currentPresetId).toBeNull();
    store._touchActivePreset();
    expect(store.currentPresetId).not.toBeNull();
    const entry = store.savedPresets[store.currentPresetId];
    expect(entry.name).toBe('test');
    expect(entry.data.prompts.a.content).toBe('hello');
    // Derived macros and preference fields must not be stored.
    expect('macros' in entry.data.prompts.a).toBe(false);
    expect('macroDisplayMode' in entry.data).toBe(false);
  });

  it('writes edits into the current entry via the debounced trigger', () => {
    store._touchActivePreset();
    const id = store.currentPresetId;
    store.updatePromptDetail({ promptId: 'a', field: 'content', value: 'edited' });
    expect(store.savedPresets[id].data.prompts.a.content).toBe('hello'); // not yet
    vi.advanceTimersByTime(1100);
    expect(store.savedPresets[id].data.prompts.a.content).toBe('edited');
  });

  it('does not duplicate entries on repeated saves', () => {
    store._touchActivePreset();
    store.updatePromptDetail({ promptId: 'a', field: 'content', value: 'x' });
    store._touchActivePreset();
    store._touchActivePreset();
    expect(Object.keys(store.savedPresets)).toHaveLength(1);
  });

  it('saveActivePresetAsCopy creates a deduped copy and switches to it', () => {
    store._touchActivePreset();
    const firstId = store.currentPresetId;
    const copyId = store.saveActivePresetAsCopy();
    expect(copyId).not.toBe(firstId);
    expect(store.currentPresetId).toBe(copyId);
    expect(store.savedPresets[copyId].name).toBe('test (2)');
    expect(Object.keys(store.savedPresets)).toHaveLength(2);
  });

  it('loadPreset does not alias the entry, and flushes pending edits first', () => {
    store._touchActivePreset();
    const firstId = store.currentPresetId;
    const copyId = store.saveActivePresetAsCopy();

    // Edit the copy, then switch back without waiting for the debounce.
    store.updatePromptDetail({ promptId: 'a', field: 'content', value: 'pending-edit' });
    store.loadPreset(firstId);
    expect(store.savedPresets[copyId].data.prompts.a.content).toBe('pending-edit');

    // The loaded active area must not alias the stored entry.
    store.prompts.a.content = 'direct-mutation';
    expect(store.savedPresets[firstId].data.prompts.a.content).toBe('hello');
  });
});

describe('F1 snapshots', () => {
  it('restore snapshots the current state first, then rolls back', () => {
    store._touchActivePreset();
    const presetId = store.currentPresetId;
    const snapId = store.createSnapshot(); // captures "hello"

    store.updatePromptDetail({ promptId: 'a', field: 'content', value: 'v2' });
    store._touchActivePreset();

    expect(store.restoreSnapshot(presetId, snapId)).toBe(true);
    expect(store.prompts.a.content).toBe('hello'); // active area rolled back
    const snapshots = store.savedPresets[presetId].snapshots;
    expect(snapshots).toHaveLength(2); // original + auto "before restore"
    expect(snapshots[0].data.prompts.a.content).toBe('v2'); // pre-restore capture
  });

  it(`caps snapshots at ${MAX_SNAPSHOTS_PER_PRESET} per preset`, () => {
    store._touchActivePreset();
    const presetId = store.currentPresetId;
    for (let i = 0; i < MAX_SNAPSHOTS_PER_PRESET + 3; i += 1) {
      store.createSnapshot(presetId, `s${i}`);
    }
    const snapshots = store.savedPresets[presetId].snapshots;
    expect(snapshots).toHaveLength(MAX_SNAPSHOTS_PER_PRESET);
    // Newest first; the oldest were pruned.
    expect(snapshots[0].name).toBe(`s${MAX_SNAPSHOTS_PER_PRESET + 2}`);
  });

  it('rename and delete work by id', () => {
    store._touchActivePreset();
    const presetId = store.currentPresetId;
    const snapId = store.createSnapshot(presetId, 'first');
    expect(store.renameSnapshot(presetId, snapId, 'renamed')).toBe(true);
    expect(store.savedPresets[presetId].snapshots[0].name).toBe('renamed');
    expect(store.deleteSnapshot(presetId, snapId)).toBe(true);
    expect(store.savedPresets[presetId].snapshots).toHaveLength(0);
  });
});

describe('A2 renameVariable reaches {{if}} conditions', () => {
  it('rewrites shorthand and classic refs inside control macros only', () => {
    store.prompts.a.content =
      '{{setvar::flag::1}} {{if .flag}}yes{{/if}} {{if getvar::flag}}y{{/if}} ' +
      'plain .flag text {{getvar::flag}} {{.flag}}';
    store.analyzeAllMacros();

    expect(store.renameVariable({ oldName: 'flag', newName: 'mood' })).toBe(true);
    const content = store.prompts.a.content;
    expect(content).toContain('{{setvar::mood::1}}');
    expect(content).toContain('{{if .mood}}');
    expect(content).toContain('{{if getvar::mood}}');
    expect(content).toContain('{{getvar::mood}}');
    expect(content).toContain('{{.mood}}');
    // Plain text outside macros is never rewritten.
    expect(content).toContain('plain .flag text');
  });

  it('does not rename longer names sharing a prefix', () => {
    store.prompts.a.content = '{{if .flagship}}x{{/if}} {{setvar::flag::1}}';
    store.analyzeAllMacros();
    store.renameVariable({ oldName: 'flag', newName: 'mood' });
    expect(store.prompts.a.content).toContain('{{if .flagship}}');
    expect(store.prompts.a.content).toContain('{{setvar::mood::1}}');
  });
});

describe('A4 system-prompt guards', () => {
  it('selectAllEditorPrompts skips system prompts', () => {
    store.selectAllEditorPrompts();
    expect(store.selectedEditorPrompts).toEqual(['a']);
  });

  it('library multi-delete never removes system prompts', () => {
    store.selectedLibraryPrompts = ['a', 'b'];
    store.deleteSelectedPrompts();
    expect(store.confirmState.open).toBe(true);
    store.resolveConfirm();
    expect(store.prompts.a).toBeUndefined();
    expect(store.prompts.b).toBeDefined(); // system prompt survives
  });
});
