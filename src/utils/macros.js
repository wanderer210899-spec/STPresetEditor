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
  getvar: { kind: 'get', scope: 'local', args: 1, op: 'get' },
  setvar: { kind: 'set', scope: 'local', args: 2, op: 'set' },
  addvar: { kind: 'mutate', scope: 'local', args: 2, op: 'add' },
  incvar: { kind: 'mutate', scope: 'local', args: 1, op: 'inc' },
  decvar: { kind: 'mutate', scope: 'local', args: 1, op: 'dec' },
  hasvar: { kind: 'get', scope: 'local', args: 1, op: 'has' },
  deletevar: { kind: 'set', scope: 'local', args: 1, op: 'delete' },
  getglobalvar: { kind: 'get', scope: 'global', args: 1, op: 'get' },
  setglobalvar: { kind: 'set', scope: 'global', args: 2, op: 'set' },
  addglobalvar: { kind: 'mutate', scope: 'global', args: 2, op: 'add' },
  incglobalvar: { kind: 'mutate', scope: 'global', args: 1, op: 'inc' },
  decglobalvar: { kind: 'mutate', scope: 'global', args: 1, op: 'dec' },
  hasglobalvar: { kind: 'get', scope: 'global', args: 1, op: 'has' },
  deleteglobalvar: { kind: 'set', scope: 'global', args: 1, op: 'delete' },
};

export const VAR_MACRO_NAMES = Object.keys(VAR_MACRO_META);

/**
 * Split a string into top-level `{{...}}` macro spans, balancing nested braces
 * so a macro whose argument contains another macro (or spans multiple lines, or
 * holds XML/HTML) is captured whole. Escaped `\{\{` / `\}\}` are treated as
 * literal text. An unclosed `{{` is not a macro (so a stray opener can't eat the
 * rest of the prompt). This is the single tokenizer used by analysis + render.
 * @param {string} content
 * @returns {{ start: number, end: number, full: string, inner: string }[]}
 */
export function tokenizeMacros(content) {
  const text = content || '';
  const n = text.length;
  const tokens = [];
  const isEscaped = (k) =>
    text[k] === '\\' && (text.startsWith('{{', k + 1) || text.startsWith('}}', k + 1));

  let i = 0;
  while (i < n) {
    if (isEscaped(i)) {
      i += 3;
      continue;
    }
    if (!text.startsWith('{{', i)) {
      i += 1;
      continue;
    }
    // Found an opener — scan for the matching closer, tracking nesting depth.
    const start = i;
    let depth = 1;
    let j = i + 2;
    while (j < n && depth > 0) {
      if (isEscaped(j)) {
        j += 3;
      } else if (text.startsWith('{{', j)) {
        depth += 1;
        j += 2;
      } else if (text.startsWith('}}', j)) {
        depth -= 1;
        j += 2;
      } else {
        j += 1;
      }
    }
    if (depth === 0) {
      const full = text.slice(start, j);
      tokens.push({ start, end: j, full, inner: full.slice(2, -2) });
      i = j;
    } else {
      // Unclosed opener: not a macro. Skip past it and keep scanning.
      i += 2;
    }
  }
  return tokens;
}

const RANDOM_MACROS = new Set(['random', 'pick', 'roll']);
// Flow-control / scoped block keywords. `if`/`else` open or branch; closing
// tags arrive as `/if` (the `/` flag is parsed off in classifyMacro).
const CONTROL_MACROS = new Set(['if', 'else', 'elseif', 'endif']);
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
  // Closing tags (e.g. `/if`, `/setvar`) categorise by their base name.
  const base = type.startsWith('/') ? type.slice(1) : type;
  if (CONTROL_MACROS.has(base)) return 'control';
  const meta = VAR_MACRO_META[base];
  if (meta) return meta.kind === 'get' ? 'get' : 'write';
  if (RANDOM_MACROS.has(base)) return 'random';
  if (IDENTITY_MACROS.has(base)) return 'identity';
  if (TIME_MACROS.has(base)) return 'time';
  if (NOOP_MACROS.has(base)) return 'noop';
  return 'unknown';
}

// Variable-name pattern for the Macros 2.0 shorthand (after `.` or `$`):
// must start with a letter; may contain word chars and hyphens.
const SHORTHAND_VAR = '[A-Za-z](?:[\\w-]*[\\w])?';
const SHORTHAND_RE = new RegExp(`^([.$])\\s*(${SHORTHAND_VAR})\\s*(.*)$`, 's');

// op → canonical type (used only for highlight fallback / debugging).
function shorthandType(op, scope) {
  const g = scope === 'global';
  switch (op) {
    case 'set':
    case 'setIfNull':
    case 'setIfFalsy':
      return g ? 'setglobalvar' : 'setvar';
    case 'add':
      return g ? 'addglobalvar' : 'addvar';
    case 'sub':
      return g ? 'subglobalvar' : 'subvar';
    case 'inc':
      return g ? 'incglobalvar' : 'incvar';
    case 'dec':
      return g ? 'decglobalvar' : 'decvar';
    default:
      return g ? 'getglobalvar' : 'getvar';
  }
}

/**
 * Pull the names of variables referenced inside an arbitrary macro body — used
 * for conditionals (`{{if .flag}}`, `{{if {{getvar::x}}}}`) so the variables
 * they read are counted as references in analysis. Matches both the Macros 2.0
 * shorthand (`.name` / `$name`) and the classic `getvar::name` forms.
 * @param {string} text
 * @returns {string[]} unique variable names
 */
export function extractVarRefs(text) {
  if (!text) return [];
  const refs = new Set();
  let m;
  // Shorthand `.name` / `$name`, not preceded by a word char (avoids file.ext).
  const shRe = /(?<![A-Za-z0-9_])[.$]\s*([A-Za-z][\w-]*)/g;
  while ((m = shRe.exec(text)) !== null) refs.add(m[1]);
  // Classic `getvar::name`, `setglobalvar::name`, …
  const clRe = new RegExp(`(?:${VAR_MACRO_NAMES.join('|')})\\s*::\\s*([A-Za-z][\\w-]*)`, 'gi');
  while ((m = clRe.exec(text)) !== null) refs.add(m[1]);
  return [...refs];
}

/**
 * Parse the inner content of a `{{...}}` macro into structured data. Handles the
 * classic `::` variable macros, the Macros 2.0 shorthand (`{{.name = v}}`,
 * `{{$name += v}}`, `{{.name++}}`, …), flow-control blocks (`{{if}}`/`{{else}}`/
 * `{{/if}}`), scoped closing tags (`{{/setvar}}`), block flags (`#`/`!`/`?`/…),
 * comments, and the legacy single-colon argument form (`{{getvar:name}}`).
 * @param {string} rawInner - text between the braces (may have whitespace)
 * @returns {{ type: string, varName: string|null, value: string|null, params: string[], scope: 'local'|'global'|null, kind: 'get'|'set'|'mutate'|null, op: string|null, flag: string|null, refs: string[] }}
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
    op: null,
    flag: null,
    refs: [],
  };

  // Comments first: `{{// ...}}` and the block-comment open/close `{{/// }}`.
  if (inner.startsWith('//')) {
    result.type = 'comment';
    return result;
  }

  // Macros 2.0 variable shorthand: `.local` / `$global`.
  const sh = inner.match(SHORTHAND_RE);
  if (sh) {
    const scope = sh[1] === '$' ? 'global' : 'local';
    const rest = sh[3].trim();
    let op = 'get';
    let value = null;
    if (rest === '') op = 'get';
    else if (rest === '++') op = 'inc';
    else if (rest === '--') op = 'dec';
    else if (rest.startsWith('??=')) ((op = 'setIfNull'), (value = rest.slice(3).trim()));
    else if (rest.startsWith('||=')) ((op = 'setIfFalsy'), (value = rest.slice(3).trim()));
    else if (rest.startsWith('+=')) ((op = 'add'), (value = rest.slice(2).trim()));
    else if (rest.startsWith('-=')) ((op = 'sub'), (value = rest.slice(2).trim()));
    else if (/^(==|!=|>=|<=|>|<)/.test(rest))
      op = 'get'; // read inside an expression
    else if (rest.startsWith('=')) ((op = 'set'), (value = rest.slice(1).trim()));

    result.scope = scope;
    result.varName = sh[2];
    result.value = value;
    result.op = op;
    result.kind = op === 'get' ? 'get' : op === 'set' ? 'set' : 'mutate';
    result.type = shorthandType(op, scope);
    return result;
  }

  // Strip a leading block flag: `/` closing, `#` preserve-whitespace, and the
  // planned `! ? ~ >` flags. (The `//` comment case is handled above.)
  let body = inner;
  if (/^[/#!?~>]/.test(body)) {
    result.flag = body[0];
    body = body.slice(1).trim();
  }

  // Leading identifier (macro name): letters/digits/underscore.
  const nameMatch = body.match(/^([A-Za-z_][\w]*)/);
  const headLower = nameMatch ? nameMatch[1].toLowerCase() : '';

  // Flow-control blocks: `{{if cond}}`, `{{else}}`, `{{/if}}`. Conditions can
  // reference variables, so capture those as references.
  if (CONTROL_MACROS.has(headLower)) {
    result.type = result.flag === '/' ? `/${headLower}` : headLower;
    result.op = 'control';
    result.refs = extractVarRefs(body.slice(nameMatch[1].length));
    return result;
  }

  // Closing tag of any scoped macro, e.g. `{{/setvar}}`. Categorise by its base.
  if (result.flag === '/') {
    result.type = headLower ? `/${headLower}` : 'unknown';
    return result;
  }

  const meta = VAR_MACRO_META[headLower];
  if (meta) {
    // Prefer the modern `::` separator; fall back to the legacy single `:`.
    const sep = body.includes('::') ? '::' : body.includes(':') ? ':' : '::';
    const segments = body.split(sep);
    result.type = headLower;
    result.kind = meta.kind;
    result.scope = meta.scope;
    result.op = meta.op;
    result.varName = (segments[1] || '').trim() || null;
    if (meta.args === 2) result.value = (segments[2] || '').trim() || null;
    return result;
  }

  result.type = headLower || 'unknown';
  if (body.includes('::')) {
    result.params = body
      .split('::')
      .slice(1)
      .map((s) => s.trim());
  }
  return result;
}

/**
 * Style category for a parsed macro, preferring its variable `kind` (so the
 * shorthand and `::` forms share colours) and falling back to its type.
 * @returns {'get'|'write'|'random'|'identity'|'time'|'comment'|'noop'|'unknown'}
 */
export function categoryOf(macro) {
  if (!macro) return 'unknown';
  if (macro.op === 'control') return 'control';
  if (macro.kind === 'get') return 'get';
  if (macro.kind === 'set' || macro.kind === 'mutate') return 'write';
  return getMacroCategory(macro.type);
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
  { name: 'hasvar', insert: 'var1', hint: 'local variable exists?' },
  { name: 'deletevar', insert: 'var1', hint: 'delete local variable' },
  // Global variables
  { name: 'getglobalvar', insert: 'var1', hint: 'global variable value' },
  { name: 'setglobalvar', insert: 'var2', hint: 'set global variable' },
  { name: 'addglobalvar', insert: 'var2', hint: 'add to global variable' },
  { name: 'incglobalvar', insert: 'var1', hint: 'increment global variable' },
  { name: 'decglobalvar', insert: 'var1', hint: 'decrement global variable' },
  { name: 'hasglobalvar', insert: 'var1', hint: 'global variable exists?' },
  { name: 'deleteglobalvar', insert: 'var1', hint: 'delete global variable' },
  // Flow control / blocks
  { name: 'if', insert: 'args', hint: 'conditional block; pair with {{/if}}' },
  { name: 'else', insert: 'plain', hint: 'else branch inside {{if}}' },
  { name: '/if', insert: 'plain', hint: 'close an {{if}} block' },
  { name: '//', insert: 'args', hint: 'comment (not rendered)' },
  // Randomisation / utility
  { name: 'random', insert: 'args', hint: 'random of ::a::b::c' },
  { name: 'pick', insert: 'args', hint: 'stable random per chat' },
  { name: 'roll', insert: 'args', hint: 'dice roll, e.g. 1d20' },
  { name: 'newline', insert: 'plain', hint: 'line break' },
  { name: 'space', insert: 'plain', hint: 'space character' },
  { name: 'trim', insert: 'plain', hint: 'trim surrounding newlines' },
  { name: 'noop', insert: 'plain', hint: 'no output' },
  { name: 'reverse', insert: 'args', hint: 'reverse text' },
  { name: 'banned', insert: 'args', hint: 'ban a word from output' },
  // Identity / participants
  { name: 'user', insert: 'plain', hint: 'user/persona name' },
  { name: 'char', insert: 'plain', hint: 'character name' },
  { name: 'group', insert: 'plain', hint: 'group member names' },
  { name: 'groupNotMuted', insert: 'plain', hint: 'group members, not muted' },
  { name: 'charIfNotGroup', insert: 'plain', hint: 'char name (empty in groups)' },
  { name: 'notChar', insert: 'plain', hint: 'participants except speaker' },
  { name: 'persona', insert: 'plain', hint: 'persona description' },
  { name: 'description', insert: 'plain', hint: 'character description' },
  { name: 'personality', insert: 'plain', hint: 'character personality' },
  { name: 'scenario', insert: 'plain', hint: 'scenario text' },
  { name: 'model', insert: 'plain', hint: 'active model name' },
  { name: 'charPrompt', insert: 'plain', hint: "character's main prompt" },
  { name: 'charInstruction', insert: 'plain', hint: 'post-history instructions' },
  { name: 'charJailbreak', insert: 'plain', hint: "character's jailbreak" },
  { name: 'charDepthPrompt', insert: 'plain', hint: '@ depth note' },
  { name: 'charVersion', insert: 'plain', hint: 'character card version' },
  { name: 'mesExamples', insert: 'plain', hint: 'example messages' },
  { name: 'mesExamplesRaw', insert: 'plain', hint: 'unformatted examples' },
  { name: 'charFirstMessage', insert: 'plain', hint: 'first message/greeting' },
  { name: 'original', insert: 'plain', hint: 'original (override substitution)' },
  // Chat history
  { name: 'input', insert: 'plain', hint: 'current text box input' },
  { name: 'lastMessage', insert: 'plain', hint: 'last chat message' },
  { name: 'lastMessageId', insert: 'plain', hint: 'index of last message' },
  { name: 'lastUserMessage', insert: 'plain', hint: 'last user message' },
  { name: 'lastCharMessage', insert: 'plain', hint: 'last character message' },
  { name: 'firstIncludedMessageId', insert: 'plain', hint: 'first in-context message id' },
  { name: 'firstDisplayedMessageId', insert: 'plain', hint: 'first displayed message id' },
  { name: 'currentSwipeId', insert: 'plain', hint: 'current swipe number' },
  { name: 'lastSwipeId', insert: 'plain', hint: 'total swipe count' },
  { name: 'allChatRange', insert: 'plain', hint: 'range of the whole chat' },
  { name: 'summary', insert: 'plain', hint: 'latest chat summary' },
  // Time / date
  { name: 'time', insert: 'plain', hint: 'current time' },
  { name: 'date', insert: 'plain', hint: 'current date' },
  { name: 'weekday', insert: 'plain', hint: 'day of week' },
  { name: 'isotime', insert: 'plain', hint: 'ISO time HH:mm' },
  { name: 'isodate', insert: 'plain', hint: 'ISO date YYYY-MM-DD' },
  { name: 'datetimeformat', insert: 'args', hint: 'moment.js format' },
  { name: 'time_UTC', insert: 'args', hint: 'UTC time, e.g. +2' },
  { name: 'timeDiff', insert: 'args', hint: '::time1::time2' },
  { name: 'idleDuration', insert: 'plain', hint: 'time since last message' },
  // Runtime state
  { name: 'isMobile', insert: 'plain', hint: '"true" on mobile' },
  { name: 'lastGenerationType', insert: 'plain', hint: 'type of last generation' },
  { name: 'hasExtension', insert: 'args', hint: 'is an extension active?' },
  { name: 'maxPrompt', insert: 'plain', hint: 'max prompt context size' },
  { name: 'maxContextTokens', insert: 'plain', hint: 'max context tokens' },
  { name: 'maxResponseTokens', insert: 'plain', hint: 'max response tokens' },
  // Prompt templates / instruct
  { name: 'systemPrompt', insert: 'plain', hint: 'active system prompt' },
  { name: 'defaultSystemPrompt', insert: 'plain', hint: 'default system prompt' },
  { name: 'authorsNote', insert: 'plain', hint: "author's note contents" },
  { name: 'charAuthorsNote', insert: 'plain', hint: "character author's note" },
  { name: 'defaultAuthorsNote', insert: 'plain', hint: "default author's note" },
  { name: 'chatStart', insert: 'plain', hint: 'chat start marker' },
  { name: 'chatSeparator', insert: 'plain', hint: 'example chat separator' },
  { name: 'instructStoryStringPrefix', insert: 'plain', hint: 'instruct story prefix' },
  { name: 'instructStoryStringSuffix', insert: 'plain', hint: 'instruct story suffix' },
  { name: 'instructUserPrefix', insert: 'plain', hint: 'instruct user prefix' },
  { name: 'instructUserSuffix', insert: 'plain', hint: 'instruct user suffix' },
  { name: 'instructAssistantPrefix', insert: 'plain', hint: 'instruct assistant prefix' },
  { name: 'instructAssistantSuffix', insert: 'plain', hint: 'instruct assistant suffix' },
  { name: 'instructSystemPrefix', insert: 'plain', hint: 'instruct system prefix' },
  { name: 'instructSystemSuffix', insert: 'plain', hint: 'instruct system suffix' },
  { name: 'instructSeparator', insert: 'plain', hint: 'instruct separator' },
  { name: 'instructStop', insert: 'plain', hint: 'instruct stop sequence' },
  { name: 'reasoningPrefix', insert: 'plain', hint: 'prefix before reasoning' },
  { name: 'reasoningSuffix', insert: 'plain', hint: 'suffix after reasoning' },
  { name: 'reasoningSeparator', insert: 'plain', hint: 'reasoning separator' },
];
