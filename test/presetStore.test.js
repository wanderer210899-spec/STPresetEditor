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

  it('loadPresetIntoFile swaps the content but keeps the open file name', () => {
    // A library preset whose content differs from the open file.
    store.savedPresets.lib = {
      name: 'Lib',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      data: {
        rawJson: '{"prompts":[{"identifier":"x","name":"X","content":"XX","enabled":true}]}',
        prompts: { x: { id: 'x', identifier: 'x', name: 'X', content: 'XX', enabled: true } },
        promptOrder: ['x'],
      },
    };
    store.originalFilename = 'myfile.json';

    const ok = store.loadPresetIntoFile('lib');

    expect(ok).toBe(true);
    // Content is replaced by the preset…
    expect(store.prompts.x).toBeTruthy();
    expect(store.prompts.a).toBeUndefined();
    expect(store.promptOrder).toEqual(['x']);
    // …but the file keeps its on-disk name (so it saves back to the same file).
    expect(store.originalFilename).toBe('myfile.json');
    // currentPresetId is not repurposed — the file is not a library entry.
    expect(store.currentPresetId).toBeNull();
  });

  it('loadPresetIntoFile returns false for an unknown preset', () => {
    expect(store.loadPresetIntoFile('nope')).toBe(false);
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

describe('F4 variable timelines + end values', () => {
  it('records set → add → get with intermediate values in execution order', () => {
    store.prompts.a.content = '{{setvar::x::5}}';
    store.prompts.b.content = '{{addvar::x::3}} then {{getvar::x}}';
    store.analyzeAllMacros();

    const timeline = store.variableTimelines.x;
    expect(timeline.map((e) => e.kind)).toEqual(['set', 'mutate', 'get']);
    expect(timeline.map((e) => e.valueAfter)).toEqual(['5', '8', '8']);
    expect(timeline[0].promptId).toBe('a');
    expect(timeline[1].op).toBe('add');
    expect(store.variableEndValues.x).toBe('8');
  });

  it('records disabled writes as skipped without mutating the simulation', () => {
    store.prompts.a.content = '{{setvar::x::1}}';
    store.prompts.b.content = '{{setvar::x::99}}';
    store.prompts.b.enabled = false;
    store.prompts.c = {
      id: 'c',
      identifier: 'c',
      name: 'Gamma',
      content: '{{getvar::x}}',
      enabled: true,
    };
    store.promptOrder = ['a', 'b', 'c'];
    store.analyzeAllMacros();

    const timeline = store.variableTimelines.x;
    expect(timeline).toHaveLength(3);
    expect(timeline[1].enabled).toBe(false);
    expect(timeline[1].valueAfter).toBe('1'); // the disabled write left the state untouched
    expect(timeline[2].valueAfter).toBe('1'); // the read sees the enabled value
    expect(store.variableEndValues.x).toBe('1');
  });

  it('lists a deleted variable with an undefined end value', () => {
    store.prompts.a.content = '{{setvar::x::5}} {{deletevar::x}}';
    store.analyzeAllMacros();
    expect('x' in store.variableEndValues).toBe(true);
    expect(store.variableEndValues.x).toBeUndefined();
  });
});

// F5: content typing runs INCREMENTAL analysis — re-tokenize only the edited
// prompt(s) on the 300ms debounce, then rebuild aggregates from every ordered
// prompt's already-attached macros. Guards the "no list-wide invalidation" win
// and the cross-prompt correctness the full pass used to give.
describe('F5 incremental macro analysis', () => {
  it('re-tokenizes only the edited prompt, leaving other prompts’ macros untouched', () => {
    store.prompts.a.content = '{{setvar::x::1}}';
    store.prompts.b.content = '{{getvar::x}}';
    store.analyzeAllMacros();
    const bMacros = store.prompts.b.macros; // reference must survive (no re-render)

    store.updatePromptDetail({ promptId: 'a', field: 'content', value: '{{setvar::x::2}}' });
    vi.advanceTimersByTime(300);

    expect(store.prompts.b.macros).toBe(bMacros); // same array reference
    expect(store.prompts.a.macros).toHaveLength(1);
    expect(store.prompts.a.macros[0].value).toBe('2'); // re-tokenized to new content
  });

  it('re-tokenizes every prompt edited within one debounce window', () => {
    store.prompts.a.content = 'x';
    store.prompts.b.content = 'y';
    store.analyzeAllMacros();

    store.updatePromptDetail({ promptId: 'a', field: 'content', value: '{{setvar::y::1}}' });
    store.updatePromptDetail({ promptId: 'b', field: 'content', value: '{{getvar::y}}' });
    vi.advanceTimersByTime(300);

    expect(store.prompts.a.macros[0].varName).toBe('y');
    expect(store.prompts.b.macros[0].varName).toBe('y');
    expect(store.variables.y).toBeDefined();
    expect(store.unresolvedVariables.map((v) => v.varName)).not.toContain('y');
  });

  it('rebuilds cross-prompt aggregates so an edit elsewhere resolves a variable', () => {
    store.prompts.a.content = '{{getvar::z}}';
    store.prompts.b.content = '';
    store.analyzeAllMacros();
    expect(store.unresolvedVariables.map((v) => v.varName)).toContain('z');

    store.updatePromptDetail({ promptId: 'b', field: 'content', value: '{{setvar::z::1}}' });
    vi.advanceTimersByTime(300);

    expect(store.unresolvedVariables.map((v) => v.varName)).not.toContain('z');
    expect(store.variableEndValues.z).toBe('1');
  });

  it('falls back to a full pass before the first analysis', () => {
    store.prompts.a.content = '{{setvar::x::1}}';
    store.prompts.b.content = '{{getvar::x}}';
    expect(store._macrosInitialized).toBe(false);

    store.queueIncrementalMacroAnalysis('a');
    vi.advanceTimersByTime(300);

    expect(store._macrosInitialized).toBe(true);
    expect(store.prompts.a.macros).toHaveLength(1);
    expect(store.prompts.b.macros).toHaveLength(1); // full pass tokenized b too
    expect(store.variables.x).toBeDefined();
  });

  it('produces the same aggregates as a full re-analysis (incremental ≡ full)', () => {
    store.prompts.a.content = '{{setvar::x::5}}';
    store.prompts.b.content = '{{addvar::x::3}} {{getvar::x}}';
    store.analyzeAllMacros();

    store.updatePromptDetail({ promptId: 'a', field: 'content', value: '{{setvar::x::10}}' });
    vi.advanceTimersByTime(300);
    const incremental = JSON.stringify({
      vars: store.variables,
      end: store.variableEndValues,
      timelines: store.variableTimelines,
    });

    store.analyzeAllMacros(); // authoritative full recompute over the same state
    const full = JSON.stringify({
      vars: store.variables,
      end: store.variableEndValues,
      timelines: store.variableTimelines,
    });
    expect(incremental).toBe(full);
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

// Bug 2026-07-12: two DIFFERENT files sharing a basename created two library
// entries with identical names (openFileAsPreset skipped the name-dedupe the
// web/adopt path already applied). Decided fix: disambiguate the display name of
// a genuinely-new entry, and NEVER merge distinct presets (distinct stable id).
describe('openFileAsPreset same-name handling', () => {
  const fileJson = (content) =>
    JSON.stringify({
      prompts: [{ identifier: 'p', name: 'P', content, enabled: true }],
      prompt_order: [{ character_id: 100001, order: [{ identifier: 'p', enabled: true }] }],
    });

  it('dedupes display names for different files, without merging them', () => {
    store.openFileAsPreset(fileJson('A'), 'MyPreset.json', 'file:/a/MyPreset.json');
    store.openFileAsPreset(fileJson('B'), 'MyPreset.json', 'file:/b/MyPreset.json');

    // Two SEPARATE entries survive (distinct stable ids → never merged).
    expect(store.savedPresets['file:/a/MyPreset.json']).toBeDefined();
    expect(store.savedPresets['file:/b/MyPreset.json']).toBeDefined();

    // …but their display names are disambiguated, not identical.
    const names = [
      store.savedPresets['file:/a/MyPreset.json'].name,
      store.savedPresets['file:/b/MyPreset.json'].name,
    ];
    expect(names).toContain('MyPreset');
    expect(names).toContain('MyPreset (2)');
    expect(new Set(names).size).toBe(2);
  });

  it('re-opening the SAME file keeps its name stable (no runaway "(2)")', () => {
    store.openFileAsPreset(fileJson('A'), 'MyPreset.json', 'file:/a/MyPreset.json');
    const firstName = store.savedPresets['file:/a/MyPreset.json'].name;
    // Re-open the same path (same stable id) — must not re-dedupe.
    store.openFileAsPreset(fileJson('A2'), 'MyPreset.json', 'file:/a/MyPreset.json');
    expect(store.savedPresets['file:/a/MyPreset.json'].name).toBe(firstName);
    expect(Object.keys(store.savedPresets)).toHaveLength(1);
  });
});
