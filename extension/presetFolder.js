// Pure helpers for the extension host: preset detection, file → library-entry
// conversion, and filename utilities. No `vscode` imports so everything here is
// unit-testable; the extension host (extension.js) wires these to the tree
// view and the explicit "Send to cloud" action.
//
// `parsePresetFile` deliberately mirrors the web app's store
// (presetStore.parseFromJson), so a file sent to the cloud from the tree opens
// identically in the editor.

'use strict';

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

module.exports = {
  isPresetJson,
  parsePresetFile,
  fileNameForEntry,
  starterPresetJson,
};
