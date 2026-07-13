// Tests for the pure helpers in extension/presetFolder.js: preset detection,
// file → entry parsing (used by the tree's explicit "Send to cloud"), and
// filename hygiene. The folder↔cloud sync decision table is gone with the
// automatic sync engine.

import { describe, expect, it } from 'vitest';
import folderLib from '../extension/presetFolder.js';

const { fileNameForEntry, isPresetJson, parsePresetFile, starterPresetJson } = folderLib;

const SAMPLE = JSON.stringify(
  {
    temperature: 0.7, // unknown top-level key — must survive in rawJson
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

describe('file → entry parsing', () => {
  it('follows the character 100001 order and enabled flags', () => {
    const data = parsePresetFile(SAMPLE);
    expect(data.promptOrder).toEqual(['jb', 'main']);
    expect(data.prompts.jb.enabled).toBe(false); // from the 100001 order
    expect(data.prompts.main.enabled).toBe(true);
    expect(data.rawJson).toBe(SAMPLE); // the file text rides along verbatim
  });

  it('appends prompts missing from the order and defaults without one', () => {
    const noOrder = JSON.stringify({
      prompts: [
        { identifier: 'b', name: 'B', injection_order: 2, enabled: true },
        { identifier: 'a', name: 'A', injection_order: 1, enabled: true },
      ],
    });
    expect(parsePresetFile(noOrder).promptOrder).toEqual(['a', 'b']);
  });
});

describe('filename hygiene', () => {
  it('sanitises and dedupes filenames', () => {
    expect(fileNameForEntry('My/Pre:set', [])).toBe('My_Pre_set.json');
    expect(fileNameForEntry('Alpha', ['alpha.json'])).toBe('Alpha (2).json');
    expect(fileNameForEntry('Alpha', ['alpha.json', 'alpha (2).json'])).toBe('Alpha (3).json');
  });
});
