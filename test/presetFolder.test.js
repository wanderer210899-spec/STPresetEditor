// Phase 7 (F5 VS Code folder workspace) tests for the pure helpers in
// extension/presetFolder.js: preset detection, file<->entry round-trips,
// the per-file sync decision table, and filename/mapping hygiene.

import { describe, expect, it } from 'vitest';
import folderLib from '../extension/presetFolder.js';

const {
  buildPresetJson,
  canonicalHash,
  decideSyncAction,
  fileNameForEntry,
  hashText,
  isPresetJson,
  normalizeMapping,
  parsePresetFile,
  starterPresetJson,
} = folderLib;

const SAMPLE = JSON.stringify(
  {
    temperature: 0.7, // unknown top-level key — must survive round-trips
    prompts: [
      { identifier: 'main', name: 'Main', content: 'hello {{char}}', enabled: true },
      { identifier: 'jb', name: 'JB', content: 'world', enabled: true },
    ],
    prompt_order: [
      { character_id: 100000, order: [{ identifier: 'jb', enabled: true }] },
      {
        character_id: 100001,
        order: [
          { identifier: 'jb', enabled: false },
          { identifier: 'main', enabled: true },
        ],
      },
    ],
  },
  null,
  2,
);

describe('isPresetJson heuristic', () => {
  it('accepts an object with a prompts array', () => {
    expect(isPresetJson(SAMPLE)).toBe(true);
    expect(isPresetJson(starterPresetJson())).toBe(true);
  });
  it('rejects arrays, non-preset objects, and invalid JSON', () => {
    expect(isPresetJson('[1,2]')).toBe(false);
    expect(isPresetJson('{"name":"x"}')).toBe(false);
    expect(isPresetJson('not json')).toBe(false);
    expect(isPresetJson('')).toBe(false);
  });
});

describe('file <-> entry round-trip', () => {
  it('parsePresetFile follows the character 100001 order and enabled flags', () => {
    const data = parsePresetFile(SAMPLE);
    expect(data.promptOrder).toEqual(['jb', 'main']);
    expect(data.prompts.jb.enabled).toBe(false); // from the 100001 order
    expect(data.prompts.main.enabled).toBe(true);
  });

  it('buildPresetJson preserves unknown keys and other characters', () => {
    const data = parsePresetFile(SAMPLE);
    const rebuilt = JSON.parse(buildPresetJson(data));
    expect(rebuilt.temperature).toBe(0.7);
    // The 100000 character's order is untouched.
    const other = rebuilt.prompt_order.find((o) => o.character_id === 100000);
    expect(other.order).toEqual([{ identifier: 'jb', enabled: true }]);
    // The 100001 order reflects the editor state.
    const ours = rebuilt.prompt_order.find((o) => o.character_id === 100001);
    expect(ours.order).toEqual([
      { identifier: 'jb', enabled: false },
      { identifier: 'main', enabled: true },
    ]);
  });

  it('round-trips to a stable document (parse → build → parse → build)', () => {
    const once = buildPresetJson(parsePresetFile(SAMPLE));
    const twice = buildPresetJson(parsePresetFile(once));
    expect(twice).toBe(once);
    expect(hashText(twice)).toBe(hashText(once));
  });

  it('canonicalHash equates a raw file with its cloud round-trip form', () => {
    const roundTripped = buildPresetJson(parsePresetFile(SAMPLE));
    expect(roundTripped).not.toBe(SAMPLE); // re-serialization differs (ids added)
    expect(canonicalHash(roundTripped)).toBe(canonicalHash(SAMPLE)); // same content
    const edited = SAMPLE.replace('hello {{char}}', 'changed');
    expect(canonicalHash(edited)).not.toBe(canonicalHash(SAMPLE));
    // Unparseable text falls back to the raw hash without throwing.
    expect(canonicalHash('not json')).toBe(hashText('not json'));
  });
});

describe('decideSyncAction table', () => {
  const h = (s) => hashText(s);
  it('none when nothing changed', () => {
    expect(decideSyncAction({ localHash: h('a'), cloudHash: h('a'), lastSyncedHash: h('a') })).toBe(
      'none',
    );
  });
  it('push when only the file changed', () => {
    expect(decideSyncAction({ localHash: h('b'), cloudHash: h('a'), lastSyncedHash: h('a') })).toBe(
      'push',
    );
  });
  it('pull when only the cloud changed', () => {
    expect(decideSyncAction({ localHash: h('a'), cloudHash: h('b'), lastSyncedHash: h('a') })).toBe(
      'pull',
    );
  });
  it('conflict when both changed differently, none when they converged', () => {
    expect(decideSyncAction({ localHash: h('b'), cloudHash: h('c'), lastSyncedHash: h('a') })).toBe(
      'conflict',
    );
    expect(decideSyncAction({ localHash: h('b'), cloudHash: h('b'), lastSyncedHash: h('a') })).toBe(
      'none',
    );
  });
  it('first sync of a fresh mapping pushes; a vanished cloud entry is local-only', () => {
    expect(decideSyncAction({ localHash: h('a'), cloudHash: null, lastSyncedHash: '' })).toBe(
      'push',
    );
    expect(decideSyncAction({ localHash: h('a'), cloudHash: null, lastSyncedHash: h('a') })).toBe(
      'local-only',
    );
  });
  it('a missing file is cloud-only (never auto-deletes the entry)', () => {
    expect(decideSyncAction({ localHash: null, cloudHash: h('a'), lastSyncedHash: h('a') })).toBe(
      'cloud-only',
    );
  });
});

describe('filename + mapping hygiene', () => {
  it('sanitises and dedupes filenames', () => {
    expect(fileNameForEntry('My/Pre:set', [])).toBe('My_Pre_set.json');
    expect(fileNameForEntry('Alpha', ['alpha.json'])).toBe('Alpha (2).json');
    expect(fileNameForEntry('Alpha', ['alpha.json', 'alpha (2).json'])).toBe('Alpha (3).json');
  });

  it('normalizeMapping drops malformed entries and tolerates junk', () => {
    const mapping = normalizeMapping({
      files: {
        'good.json': { presetId: 'p1', lastSyncedHash: 'x' },
        'bad.json': { nope: true },
        'null.json': null,
      },
    });
    expect(Object.keys(mapping.files)).toEqual(['good.json']);
    expect(normalizeMapping(null)).toEqual({ files: {} });
    expect(normalizeMapping('junk')).toEqual({ files: {} });
  });
});
