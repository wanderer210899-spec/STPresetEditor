// Phase 4 (F8b theme + F8d token counts) — store-level behaviour.

import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';
import { usePresetStore } from '../src/stores/presetStore';
import { estimateTokens, formatTokenCount } from '../src/utils/tokens';

let store;

beforeEach(() => {
  setActivePinia(createPinia());
  store = usePresetStore();
  document.documentElement.classList.remove('dark');
});

describe('F8d token estimator', () => {
  it('estimates ~1.3 tokens per word plus specials, 0 for empty', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('   ')).toBe(0);
    expect(estimateTokens('one two three four')).toBe(Math.ceil(4 * 1.3));
    expect(estimateTokens('hello, world!')).toBe(Math.ceil(2 * 1.3 + 2));
  });

  it('counts CJK characters individually', () => {
    expect(estimateTokens('你好世界')).toBe(4);
  });

  it('formats large counts compactly', () => {
    expect(formatTokenCount(999)).toBe('999');
    expect(formatTokenCount(1234)).toBe('1.2k');
    expect(formatTokenCount(15600)).toBe('16k');
  });

  it('toolbar total covers enabled in-order prompts only', () => {
    store.prompts = {
      a: { id: 'a', content: 'one two three four', enabled: true },
      b: { id: 'b', content: 'one two three four', enabled: false },
      c: { id: 'c', content: 'one two three four', enabled: true }, // not in order
    };
    store.promptOrder = ['a', 'b'];
    expect(store.enabledTokenTotal).toBe(Math.ceil(4 * 1.3));
    store.prompts.b.enabled = true;
    expect(store.enabledTokenTotal).toBe(Math.ceil(4 * 1.3) * 2);
  });
});

describe('F8b theme', () => {
  it('setThemeMode(dark/light) toggles the .dark root class', () => {
    store.setThemeMode('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    store.setThemeMode('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('rejects unknown modes', () => {
    store.setThemeMode('dark');
    store.setThemeMode('sepia');
    expect(store.themeMode).toBe('dark');
  });

  it('system mode follows prefers-color-scheme', () => {
    const original = window.matchMedia;
    window.matchMedia = (query) => ({
      matches: query.includes('dark'),
      addEventListener: () => {},
    });
    store.setThemeMode('system');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    window.matchMedia = original;
  });
});
