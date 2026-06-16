# Progress / Changelog

**This fork started on 2026-06-15**, branching from the upstream STPresetEditor
at commit `468e7cd` (the static, `localStorage`-only editor by Nativu5 and
contributors). The upstream project's original progress document is preserved
verbatim in [`legacy_progress.md`](./legacy_progress.md); this file tracks the
fork's own work only.

Work on branch `claude/wizardly-mayer-srchqd`. Newest first.

## Fix: nested-macro rendering + full macro coverage + custom autocomplete

Macros whose value contained a nested `{{...}}` (e.g. `{{.genre = …{{char}}…}}`)
or `{{.pov = <pov>…{{user}}…</pov>}}` rendered broken: the old non-greedy
`/{{.*?}}/` tokenizer stopped at the inner macro's `}}`, dumping the rest of the
value as plain text.

- **Brace-balanced tokenizer** (`tokenizeMacros` in `src/utils/macros.js`) now
  captures each `{{...}}` whole — across nesting, multiple lines and XML — treats
  `\{\{`/`\}\}` as literal, and ignores unclosed `{{`. `analyzeAllMacros` and
  `PromptCard` use the returned `start`/`end` offsets (no more `indexOf`).
- **Full macro coverage** vs. the SillyTavern docs: flow-control blocks
  (`{{if}}`/`{{else}}`/`{{/if}}`, new `control` highlight) with variable
  references extracted from conditions; `hasvar`/`deletevar` (+global); block
  flags (`#`/`!`/`?`/`~`/`>`) and scoped closing tags (`{{/setvar}}`); the legacy
  single-colon argument form; and a much larger `MACRO_CATALOG` (instruct/
  reasoning/state/chat macros, `space`, `summary`, …).
- **Custom autocomplete dictionary** (Settings → Autocomplete dictionary):
  additive, persisted **and synced** `customMacros` (`{{name}}` snippets) and
  `customWraps` (paired notations such as `<!-- … -->`, seeded by
  `defaultCustomWraps()`). The `{{` menu includes custom macros; **Ctrl+Space**
  opens a snippet menu (wraps first) that surrounds the selection or drops the
  caret between `open`/`close`.

## Fix: Macros 2.0 variable shorthand

SillyTavern's new shorthand (`{{.name}}` local, `{{$name}}` global) wasn't
recognised — those macros showed as "unknown", never appeared in the Variables
list, and weren't evaluated in preview.

- `classifyMacro` now parses the shorthand and every operator (`=`, `+=`, `-=`,
  `++`, `--`, `??=`, `||=`) into the same `{ kind, op, scope }` shape as the
  `::` macros, so a get/assignment is tracked, highlighted, simulated and
  renamed identically regardless of which syntax is used.
- Variable simulation is now operator-driven (`op`), adding subtract and
  conditional-set (`??=`/`||=`) alongside set/add/inc/dec.
- Highlight + preview use a shared `categoryOf(macro)` (kind-first), so
  shorthand and `::` forms colour the same and assignments (no output) are
  hidden in preview while gets render their value.
- Autocomplete: typing `{{.` or `{{$` now suggests existing variable names.
- `renameVariable` rewrites shorthand occurrences too.

## Editing workflow, macro engine & autocomplete

**Macro engine (`src/utils/macros.js`)** — new single source of truth for the
macro vocabulary, matching SillyTavern's current set:

- Recognises the full variable family: `get/set/add/inc/dec` plus every
  `global` variant (previously only `setvar`/`getvar`/`//` were understood).
- Adds identity (`user`, `char`, `persona`, …), chat, time/date and utility
  (`random`, `pick`, `roll`, `newline`, `trim`, …) macros.
- `classifyMacro()` returns `{ type, varName, value, params, scope, kind }`;
  `getMacroCategory()` drives highlight colours; `MACRO_CATALOG` feeds
  autocomplete.

**Analysis (`presetStore.js → analyzeAllMacros`)**

- `set` + `mutate` now count as variable definitions; `get` + `mutate` as
  references — so vars touched only by `addvar/incvar/decvar` are no longer
  flagged "unresolved".
- Simulation handles `add` (numeric or string concat), `inc`/`dec`, local +
  global.
- `renameVariable` rewrites every variable-macro form via one regex.
- `MacroRenderer` colours by category and previews `getglobalvar` values;
  preview mode hides write/comment/noop macros.

**Macro & variable autocomplete (`MacroAutocompleteTextarea.vue`)**

- Type `{{` for a macro dropdown; after a variable macro's `::`, suggests
  existing variable names. Keyboard nav (↑/↓/Enter/Tab/Esc); dropdown follows
  the caret (`src/utils/caret.js`).
- Used by the inline details textarea and the focus editor.

**Distraction-free focus editor (`FocusEditorModal.vue`)**

- Content-only writing surface (editable name as the title, no identifier) with
  autocomplete and a large text area.
- Opens from a prompt card's expand button or double-click, and from the right
  pane's Expand button — no more scrolling the sidebar to find it
  (`store.focusEditorPromptId` / `openFocusEditor`).

**Other**

- PC header height reduced (smaller title + `btn-sm` toolbar buttons + tighter
  padding).
- `BaseModal` gained a `#title` slot.

## UI consistency & declutter overhaul

- **Shared CSS primitives** in `src/style.css` (`@layer components`):
  `.btn` (+ `-sm`/`-primary`/`-secondary`/`-danger`/`-ghost`), `.btn-icon`
  (+ `-sm`/`-active`/`-danger`), `.input`, `.field-label`, `.section-title`.
  Replaced ~22 ad-hoc button class strings; restrained palette (blue = primary,
  neutral = secondary, red = destructive only).
- **Contextual editor toolbar** — multi-select is off by default; checkboxes and
  the batch bar appear only in select mode, leaving a clean white editor canvas.
- **Modals standardised** on a Headless UI `BaseModal` (transitions, focus-trap,
  Esc): Settings, Preset Manager, Import, Export, Details.
- **In-app dialogs** — `ConfirmDialog` (with optional "don't ask again") and
  `ToastHost` replace native `window.confirm` / `alert`.
- **De-duplication** — removed the ~170-line dead fallback dialog in
  `BatchReplaceModal`; extracted `PromptFields` + `VariableUsageList`; deduped
  the New Prompt action; mobile menu reaches Presets/Settings.
- Editor pane is a white canvas against muted sidebars.
