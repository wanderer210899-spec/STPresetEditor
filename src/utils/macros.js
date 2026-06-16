/**
 * Macro engine — single source of truth for parsing, categorising and
 * autocompleting SillyTavern `{{...}}` macros.
 *
 * Mirrors SillyTavern's current macro set (variables incl. add/inc/dec and
 * global variants, plus identity/chat/time/utility macros). Used by:
 *  - the preset store's analyzeAllMacros() parser
 *  - MacroRenderer.vue for highlight colours + preview
 *  - MacroAutocompleteTextarea.vue for the `{{` autocomplete dropdown
 */

/**
 * Variable macro metadata.
 * kind: 'get' reads a value · 'set' assigns · 'mutate' reads + writes (add/inc/dec)
 * args: number of `::` arguments (1 = name only, 2 = name + value)
 */
export const VAR_MACRO_META = {
  getvar: { kind: 'get', scope: 'local', args: 1 },
  setvar: { kind: 'set', scope: 'local', args: 2 },
  addvar: { kind: 'mutate', scope: 'local', args: 2 },
  incvar: { kind: 'mutate', scope: 'local', args: 1 },
  decvar: { kind: 'mutate', scope: 'local', args: 1 },
  getglobalvar: { kind: 'get', scope: 'global', args: 1 },
  setglobalvar: { kind: 'set', scope: 'global', args: 2 },
  addglobalvar: { kind: 'mutate', scope: 'global', args: 2 },
  incglobalvar: { kind: 'mutate', scope: 'global', args: 1 },
  decglobalvar: { kind: 'mutate', scope: 'global', args: 1 },
};

export const VAR_MACRO_NAMES = Object.keys(VAR_MACRO_META);

const RANDOM_MACROS = new Set(['random', 'pick', 'roll']);
const NOOP_MACROS = new Set(['noop', 'newline', 'trim', 'reverse', 'banned']);
const IDENTITY_MACROS = new Set([
  'user',
  'char',
  'persona',
  'description',
  'personality',
  'scenario',
  'group',
  'model',
  'charprompt',
  'charjailbreak',
  'mesexamples',
  'input',
  'lastmessage',
  'lastusermessage',
  'lastcharmessage',
  'lastmessageid',
  'firstincludedmessageid',
  'currentswipeid',
  'lastswipeid',
  'maxprompt',
  'maxcontext',
  'maxresponse',
]);
const TIME_MACROS = new Set([
  'time',
  'date',
  'weekday',
  'isotime',
  'isodate',
  'datetimeformat',
  'time_utc',
  'timediff',
  'idle_duration',
]);

/**
 * High-level style category for a parsed macro type. Drives the highlight
 * colour in MacroRenderer and the preview hide rules in PromptCard.
 * @returns {'get'|'write'|'random'|'identity'|'time'|'comment'|'noop'|'unknown'}
 */
export function getMacroCategory(type) {
  if (!type) return 'unknown';
  if (type === 'comment') return 'comment';
  const meta = VAR_MACRO_META[type];
  if (meta) return meta.kind === 'get' ? 'get' : 'write';
  if (RANDOM_MACROS.has(type)) return 'random';
  if (IDENTITY_MACROS.has(type)) return 'identity';
  if (TIME_MACROS.has(type)) return 'time';
  if (NOOP_MACROS.has(type)) return 'noop';
  return 'unknown';
}

/**
 * Parse the inner content of a `{{...}}` macro into structured data.
 * @param {string} rawInner - text between the braces (may have whitespace)
 * @returns {{ type: string, varName: string|null, value: string|null, params: string[], scope: 'local'|'global'|null, kind: 'get'|'set'|'mutate'|null }}
 */
export function classifyMacro(rawInner) {
  const inner = (rawInner || '').trim();
  const result = {
    type: 'unknown',
    varName: null,
    value: null,
    params: [],
    scope: null,
    kind: null,
  };

  if (inner.startsWith('//')) {
    result.type = 'comment';
    return result;
  }

  // Leading identifier (macro name): letters/digits/underscore.
  const nameMatch = inner.match(/^([A-Za-z_][\w]*)/);
  const headLower = nameMatch ? nameMatch[1].toLowerCase() : '';
  const meta = VAR_MACRO_META[headLower];

  if (meta) {
    const segments = inner.split('::');
    result.type = headLower;
    result.kind = meta.kind;
    result.scope = meta.scope;
    result.varName = (segments[1] || '').trim() || null;
    if (meta.args === 2) result.value = (segments[2] || '').trim() || null;
    return result;
  }

  result.type = headLower || 'unknown';
  if (inner.includes('::')) {
    result.params = inner
      .split('::')
      .slice(1)
      .map((s) => s.trim());
  }
  return result;
}

/**
 * Autocomplete catalog. `insert` controls how the snippet is expanded:
 *  - 'var1'  → `{{name::` then a variable-name suggestion, closes with `}}`
 *  - 'var2'  → `{{name::` then a variable-name suggestion, then `::` for a value
 *  - 'args'  → `{{name}}` with the caret left inside for free-form arguments
 *  - 'plain' → `{{name}}` with the caret placed after the macro
 */
export const MACRO_CATALOG = [
  // Local variables
  { name: 'getvar', insert: 'var1', hint: 'local variable value' },
  { name: 'setvar', insert: 'var2', hint: 'set local variable' },
  { name: 'addvar', insert: 'var2', hint: 'add to local variable' },
  { name: 'incvar', insert: 'var1', hint: 'increment local variable' },
  { name: 'decvar', insert: 'var1', hint: 'decrement local variable' },
  // Global variables
  { name: 'getglobalvar', insert: 'var1', hint: 'global variable value' },
  { name: 'setglobalvar', insert: 'var2', hint: 'set global variable' },
  { name: 'addglobalvar', insert: 'var2', hint: 'add to global variable' },
  { name: 'incglobalvar', insert: 'var1', hint: 'increment global variable' },
  { name: 'decglobalvar', insert: 'var1', hint: 'decrement global variable' },
  // Randomisation / utility
  { name: 'random', insert: 'args', hint: 'random of ::a::b::c' },
  { name: 'pick', insert: 'args', hint: 'stable random per chat' },
  { name: 'roll', insert: 'args', hint: 'dice roll, e.g. 1d20' },
  { name: 'newline', insert: 'plain', hint: 'line break' },
  { name: 'trim', insert: 'plain', hint: 'trim surrounding newlines' },
  { name: 'noop', insert: 'plain', hint: 'no output' },
  { name: 'reverse', insert: 'args', hint: 'reverse text' },
  { name: 'banned', insert: 'args', hint: 'ban a word from output' },
  { name: '//', insert: 'args', hint: 'comment (not rendered)' },
  // Identity
  { name: 'user', insert: 'plain', hint: 'user/persona name' },
  { name: 'char', insert: 'plain', hint: 'character name' },
  { name: 'persona', insert: 'plain', hint: 'persona description' },
  { name: 'description', insert: 'plain', hint: 'character description' },
  { name: 'personality', insert: 'plain', hint: 'character personality' },
  { name: 'scenario', insert: 'plain', hint: 'scenario text' },
  { name: 'group', insert: 'plain', hint: 'group member names' },
  { name: 'model', insert: 'plain', hint: 'active model name' },
  { name: 'charPrompt', insert: 'plain', hint: "character's main prompt" },
  { name: 'charJailbreak', insert: 'plain', hint: "character's jailbreak" },
  { name: 'mesExamples', insert: 'plain', hint: 'example messages' },
  // Chat
  { name: 'input', insert: 'plain', hint: 'current text box input' },
  { name: 'lastMessage', insert: 'plain', hint: 'last chat message' },
  { name: 'lastUserMessage', insert: 'plain', hint: 'last user message' },
  { name: 'lastCharMessage', insert: 'plain', hint: 'last character message' },
  { name: 'currentSwipeId', insert: 'plain', hint: 'current swipe number' },
  { name: 'lastSwipeId', insert: 'plain', hint: 'total swipe count' },
  // Time / date
  { name: 'time', insert: 'plain', hint: 'current time' },
  { name: 'date', insert: 'plain', hint: 'current date' },
  { name: 'weekday', insert: 'plain', hint: 'day of week' },
  { name: 'isotime', insert: 'plain', hint: 'ISO time HH:mm' },
  { name: 'isodate', insert: 'plain', hint: 'ISO date YYYY-MM-DD' },
  { name: 'datetimeformat', insert: 'args', hint: 'moment.js format' },
  { name: 'time_UTC', insert: 'args', hint: 'UTC time, e.g. +2' },
  { name: 'timeDiff', insert: 'args', hint: '::time1::time2' },
  { name: 'idle_duration', insert: 'plain', hint: 'time since last message' },
  // Context limits
  { name: 'maxPrompt', insert: 'plain', hint: 'max prompt tokens' },
  { name: 'maxContext', insert: 'plain', hint: 'max context tokens' },
  { name: 'maxResponse', insert: 'plain', hint: 'max response tokens' },
];
