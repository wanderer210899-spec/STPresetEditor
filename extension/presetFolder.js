// Pure helpers for the ST Presets folder workspace (F5): preset detection,
// file<->library-entry conversion, content hashing, and the per-file sync
// decision. No `vscode` imports so everything here is unit-testable; the
// extension host (extension.js) wires these to the tree view, watcher, and
// cloud transport.
//
// The conversions deliberately mirror the web app's store:
//   parsePresetFile  <=> presetStore.parseFromJson  (file -> entry.data)
//   buildPresetJson  <=> presetStore composePresetJson (entry.data -> file)
// so a file round-tripped through the cloud library matches what the web app
// would export for the same entry.

'use strict';

const crypto = require('crypto');

/** Mapping file at the linked folder's root. */
const MAPPING_FILENAME = '.stpe-library.json';

function hashText(text) {
  return crypto
    .createHash('sha256')
    .update(text || '', 'utf8')
    .digest('hex');
}

/** Heuristic: an ST preset is a JSON object with a `prompts` array. */
function isPresetJson(text) {
  if (typeof text !== 'string' || !text.trim()) return false;
  try {
    const parsed = JSON.parse(text);
    return (
      Boolean(parsed) &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      Array.isArray(parsed.prompts)
    );
  } catch {
    return false;
  }
}

function defaultOrder(promptsArray) {
  return promptsArray
    .filter((p) => p.enabled !== false)
    .sort((a, b) => (a.injection_order || 0) - (b.injection_order || 0))
    .map((p) => p.identifier || p.name)
    .filter(Boolean);
}

/**
 * File JSON -> library entry data ({ rawJson, prompts, promptOrder }).
 * Mirrors presetStore.parseFromJson, including the character 100001 priority
 * and the unordered-prompts tail.
 */
function parsePresetFile(jsonText) {
  const parsed = JSON.parse(jsonText);
  const promptsArray = Array.isArray(parsed.prompts) ? parsed.prompts : [];

  const prompts = promptsArray.reduce((acc, prompt) => {
    const id = prompt.identifier || prompt.name;
    if (id) acc[id] = { ...prompt, id };
    return acc;
  }, {});

  let promptOrder = [];
  let characterOrder = null;
  if (Array.isArray(parsed.prompt_order)) {
    characterOrder = parsed.prompt_order.find((item) => item.character_id === 100001);
    if (!characterOrder && parsed.prompt_order.length > 0) {
      characterOrder = parsed.prompt_order[0];
    }
  }

  if (characterOrder && Array.isArray(characterOrder.order)) {
    const orderData = characterOrder.order;
    promptOrder = orderData.map((item) => item.identifier).filter((id) => id in prompts);
    orderData.forEach((item) => {
      if (prompts[item.identifier]) prompts[item.identifier].enabled = item.enabled;
    });
    const orderedIds = new Set(promptOrder);
    const unordered = Object.values(prompts)
      .filter((p) => !orderedIds.has(p.id))
      .sort((a, b) => {
        const orderA = a.injection_order || 0;
        const orderB = b.injection_order || 0;
        if (orderA !== orderB) return orderA - orderB;
        if (a.system_prompt !== b.system_prompt) return b.system_prompt - a.system_prompt;
        return (a.name || '').localeCompare(b.name || '');
      });
    promptOrder.push(...unordered.map((p) => p.id));
  } else {
    promptOrder = defaultOrder(promptsArray);
  }

  return { rawJson: jsonText, prompts, promptOrder };
}

/**
 * Library entry data -> pretty preset JSON. Mirrors the store's
 * composePresetJson: prompts array from the map (minus derived `macros`),
 * prompt_order regenerated for character 100001 only.
 */
function buildPresetJson({ rawJson, prompts, promptOrder }) {
  const preset = JSON.parse(rawJson || '{}');

  const cleanedPrompts = Object.values(prompts || {}).map((p) => {
    const { macros: _macros, ...rest } = p;
    return rest;
  });
  preset.prompts = cleanedPrompts;

  const editorPrompts = (promptOrder || [])
    .map((id) => ({
      identifier: id,
      enabled: (prompts || {})[id]?.enabled !== false,
    }))
    .filter((item) => (prompts || {})[item.identifier]);

  if (Array.isArray(preset.prompt_order)) {
    let characterOrderIndex = preset.prompt_order.findIndex((item) => item.character_id === 100001);
    if (characterOrderIndex === -1 && preset.prompt_order.length > 0) characterOrderIndex = 0;
    if (characterOrderIndex !== -1) {
      preset.prompt_order[characterOrderIndex].order = editorPrompts;
    } else {
      preset.prompt_order.push({ character_id: 100001, order: editorPrompts });
    }
  } else {
    preset.prompt_order = [{ character_id: 100001, order: editorPrompts }];
  }

  return JSON.stringify(preset, null, 2);
}

/**
 * Hash a preset file by its CANONICAL form (parse -> build), not its raw
 * text. The cloud round-trip re-serializes files (adds prompt `id`s, may
 * reorder keys — same as the web app's export), so raw-text hashes would
 * flag every synced file as changed. Canonical hashing makes "unchanged"
 * mean "same content", ignoring formatting. Unparseable text falls back to
 * the raw hash (it can't be pushed anyway).
 */
function canonicalHash(text) {
  try {
    return hashText(buildPresetJson(parsePresetFile(text)));
  } catch {
    return hashText(text);
  }
}

/**
 * Per-file sync decision (5b), given content hashes:
 *  - `localHash`  — hash of the file on disk (null when the file is gone)
 *  - `cloudHash`  — hash of buildPresetJson(cloud entry) (null when no entry)
 *  - `lastSyncedHash` — hash recorded at the last successful sync
 *
 * Returns 'none' | 'push' | 'pull' | 'conflict' | 'local-only' | 'cloud-only'.
 */
function decideSyncAction({ localHash, cloudHash, lastSyncedHash }) {
  if (localHash == null && cloudHash == null) return 'none';
  if (localHash == null) return 'cloud-only'; // file deleted/missing locally
  // No cloud entry: first sync of a freshly-mapped file pushes; an entry that
  // vanished after a successful sync leaves the file local-only (never delete).
  if (cloudHash == null) return lastSyncedHash ? 'local-only' : 'push';
  const localChanged = localHash !== lastSyncedHash;
  const cloudChanged = cloudHash !== lastSyncedHash;
  if (!localChanged && !cloudChanged) return 'none';
  if (localChanged && !cloudChanged) return 'push';
  if (!localChanged && cloudChanged) return 'pull';
  if (localHash === cloudHash) return 'none'; // both moved to the same content
  return 'conflict';
}

/** Sanitize a preset name into a fresh `.json` filename (deduped). */
function fileNameForEntry(name, existingNames) {
  const taken = new Set((existingNames || []).map((n) => n.toLowerCase()));
  const base =
    String(name || 'preset')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\.json$/i, '')
      .trim() || 'preset';
  let candidate = `${base}.json`;
  let n = 2;
  while (taken.has(candidate.toLowerCase())) {
    candidate = `${base} (${n}).json`;
    n += 1;
  }
  return candidate;
}

/** Starter preset written by the "New preset" tree action. */
function starterPresetJson() {
  const main = {
    identifier: 'main',
    name: 'Main Prompt',
    system_prompt: true,
    role: 'system',
    content: 'Write the next reply in this fictional chat.',
    enabled: true,
  };
  return JSON.stringify(
    {
      prompts: [main],
      prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }] }],
    },
    null,
    2,
  );
}

/** Parse a mapping document, tolerating missing/invalid input. */
function normalizeMapping(raw) {
  const mapping = raw && typeof raw === 'object' ? raw : {};
  const files = mapping.files && typeof mapping.files === 'object' ? mapping.files : {};
  const cleaned = {};
  Object.entries(files).forEach(([rel, m]) => {
    if (m && typeof m === 'object' && typeof m.presetId === 'string') {
      cleaned[rel] = { presetId: m.presetId, lastSyncedHash: m.lastSyncedHash || '' };
    }
  });
  return { files: cleaned };
}

module.exports = {
  MAPPING_FILENAME,
  canonicalHash,
  hashText,
  isPresetJson,
  parsePresetFile,
  buildPresetJson,
  decideSyncAction,
  fileNameForEntry,
  starterPresetJson,
  normalizeMapping,
};
