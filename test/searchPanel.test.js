// Phase 3 (F6 + F7) — content search, find-next navigation, global search
// across presets, and the maximizable right pane.

import { randomUUID } from 'node:crypto';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePresetStore } from '../src/stores/presetStore';

if (typeof window.crypto?.randomUUID !== 'function') {
  Object.defineProperty(window, 'crypto', {
    value: { ...(window.crypto || {}), randomUUID },
    configurable: true,
  });
}

let store;

beforeEach(() => {
  vi.useFakeTimers();
  setActivePinia(createPinia());
  store = usePresetStore();
  store.rawJson = '{"prompts":[]}';
  store.originalFilename = 'test.json';
  store.prompts = {
    a: {
      id: 'a',
      identifier: 'a',
      name: 'Alpha',
      content: 'needle one, needle two',
      enabled: true,
    },
    b: { id: 'b', identifier: 'b', name: 'needle title', content: 'plain text', enabled: true },
    c: { id: 'c', identifier: 'c', name: 'Gamma', content: 'no match here', enabled: true },
    d: { id: 'd', identifier: 'd', name: 'Delta', content: 'a needle', enabled: true },
  };
  store.promptOrder = ['a', 'b', 'c', 'd'];
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe('F6a title + content search', () => {
  it('orderedPrompts matches content, not just name/id', () => {
    store.setEditorSearch('needle');
    expect(store.orderedPrompts.map((p) => p.id)).toEqual(['a', 'b', 'd']);
  });

  it('libraryPrompts matches content too', () => {
    store.librarySearchTerm = 'needle';
    expect(store.libraryPrompts.map((p) => p.id).sort()).toEqual(['a', 'b', 'd']);
  });

  it('counts occurrences per prompt for the stats line', () => {
    store.setEditorSearch('needle');
    // a: 2 in content, b: 1 in name, d: 1 in content = 4 matches in 3 prompts
    expect(store.editorSearchMatches).toEqual(['a', 'a', 'b', 'd']);
    expect(store.editorSearchStats).toEqual({ matches: 4, prompts: 3 });
  });
});

describe('F6b find & navigate', () => {
  it('Enter cycles through matches and wraps around', () => {
    store.setEditorSearch('needle');
    const visited = [];
    for (let i = 0; i < 5; i += 1) {
      store.editorSearchNext();
      visited.push(store.scrollToPromptId);
    }
    expect(visited).toEqual(['a', 'a', 'b', 'd', 'a']); // wrapped
    expect(store.editorSearchActiveIndex).toBe(0);
  });

  it('Shift+Enter from the start goes to the last match', () => {
    store.setEditorSearch('needle');
    store.editorSearchPrev();
    expect(store.editorSearchActiveIndex).toBe(3);
    expect(store.scrollToPromptId).toBe('d');
  });

  it('temporarily expands a collapsed prompt while visiting it', () => {
    store.globalCollapseState = 'collapsed';
    store.setEditorSearch('needle');
    store.editorSearchNext(); // visit 'a'
    expect(store.getPromptCollapseState('a')).toBe(false); // presentational expand
    expect(store.getPromptCollapseState('b')).toBe(true);
    store.editorSearchNext();
    store.editorSearchNext(); // move on to 'b'
    expect(store.getPromptCollapseState('a')).toBe(true); // re-collapsed, state untouched
    expect(store.getPromptCollapseState('b')).toBe(false);
    store.setEditorSearch(''); // clearing the search clears the visit
    expect(store.searchVisitPromptId).toBeNull();
  });

  it('re-setting the same term keeps the find position', () => {
    store.setEditorSearch('needle');
    store.editorSearchNext();
    store.editorSearchNext();
    store.setEditorSearch('needle'); // e.g. Enter pressed again in the box
    expect(store.editorSearchActiveIndex).toBe(1);
  });
});

describe('F6c global search', () => {
  beforeEach(() => {
    store.savedPresets.p2 = {
      name: 'Other preset',
      data: {
        rawJson: '{"prompts":[]}',
        originalFilename: 'other.json',
        prompts: {
          z: {
            id: 'z',
            identifier: 'z',
            name: 'Zeta',
            content: 'hidden treasure inside',
            enabled: true,
          },
        },
        promptOrder: ['z'],
        promptCollapseStates: {},
      },
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
  });

  it('finds prompts inside non-loaded saved presets, grouped by preset', () => {
    const groups = store.searchAllPresets('treasure');
    expect(groups).toHaveLength(1);
    expect(groups[0].presetId).toBe('p2');
    expect(groups[0].hits[0].promptId).toBe('z');
    expect(groups[0].hits[0].snippet.match).toBe('treasure');
  });

  it('groups active-preset hits first and matches preset names', () => {
    const groups = store.searchAllPresets('needle');
    expect(groups[0].isActive).toBe(true);
    expect(groups[0].hits.map((h) => h.promptId)).toEqual(['a', 'b', 'd']);
    const byName = store.searchAllPresets('other preset');
    expect(byName[0].presetId).toBe('p2');
    expect(byName[0].nameMatch).toBe(true);
  });

  it('opening a result in another preset loads it and jumps to the prompt', () => {
    store.isGlobalSearchOpen = true;
    store.openGlobalSearchResult('p2', 'z');
    expect(store.isGlobalSearchOpen).toBe(false);
    expect(store.currentPresetId).toBe('p2');
    expect(store.prompts.z.content).toBe('hidden treasure inside');
    vi.advanceTimersByTime(200); // navigation happens after re-render
    expect(store.scrollToPromptId).toBe('z');
  });
});

describe('F7 maximizable right pane', () => {
  // The collapsible-columns layout only reads the boolean; the splitpanes-era
  // pixel sizes (paneSizes/setPaneSizes) were removed with the library.
  it('toggles the maximized flag', () => {
    expect(store.isRightPaneMaximized).toBe(false);
    store.toggleRightPaneMaximize();
    expect(store.isRightPaneMaximized).toBe(true);
    store.toggleRightPaneMaximize();
    expect(store.isRightPaneMaximized).toBe(false);
  });
});
