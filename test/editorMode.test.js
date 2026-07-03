// Editor-mode detection (web / file / library) and its two load-bearing
// consequences: which paths persist to localStorage, and whether the active
// area autosaves into the library.
//
// The bug this guards against: a file-backed VS Code webview restored a stale
// (or another panel's) open file from the shared webview localStorage before the
// host's `load` arrived — surfacing as an "Untitled preset / wrong file" flash
// on open. In the extension we must NOT persist the per-file active area.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function fakeVsCodeApi() {
  window.acquireVsCodeApi = () => ({ postMessage() {} });
}

describe('getEditorMode() and host helpers', () => {
  afterEach(() => {
    delete window.acquireVsCodeApi;
    delete window.__STPE_MODE__;
    vi.resetModules();
  });

  it('is "web" outside a VS Code webview', async () => {
    const host = await import('../src/utils/host.js');
    expect(host.isVsCodeHost()).toBe(false);
    expect(host.getEditorMode()).toBe('web');
    expect(host.isFileHost()).toBe(false);
    expect(host.isLibraryHost()).toBe(false);
  });

  it('defaults to "file" inside a webview with no injected mode', async () => {
    fakeVsCodeApi();
    const host = await import('../src/utils/host.js');
    expect(host.getEditorMode()).toBe('file');
    expect(host.isFileHost()).toBe(true);
    expect(host.isLibraryHost()).toBe(false);
  });

  it('is "library" when the host injects window.__STPE_MODE__', async () => {
    fakeVsCodeApi();
    window.__STPE_MODE__ = 'library';
    const host = await import('../src/utils/host.js');
    expect(host.getEditorMode()).toBe('library');
    expect(host.isLibraryHost()).toBe(true);
    expect(host.isFileHost()).toBe(false);
  });
});

describe('PERSIST_PATHS gating in the extension', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    delete window.acquireVsCodeApi;
    vi.resetModules();
  });

  it('web persists the active area and the library', async () => {
    const mod = await import('../src/stores/presetStore.js');
    expect(mod.PERSIST_PATHS).toContain('rawJson');
    expect(mod.PERSIST_PATHS).toContain('prompts');
    expect(mod.PERSIST_PATHS).toContain('savedPresets');
  });

  it('the extension drops the per-file active area but keeps the library', async () => {
    fakeVsCodeApi(); // evaluated by the module at import time
    const mod = await import('../src/stores/presetStore.js');
    for (const p of ['rawJson', 'originalFilename', 'prompts', 'promptOrder']) {
      expect(mod.PERSIST_PATHS).not.toContain(p);
    }
    // The library + preferences still persist and sync.
    expect(mod.PERSIST_PATHS).toContain('savedPresets');
    expect(mod.PERSIST_PATHS).toContain('customMacros');
  });
});
