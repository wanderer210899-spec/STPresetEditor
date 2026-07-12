# Progress / Changelog

**This fork started on 2026-06-15**, branching from the upstream STPresetEditor
at commit `468e7cd` (the static, `localStorage`-only editor by Nativu5 and
contributors). The upstream project's original progress document is preserved
verbatim in [`legacy_progress.md`](./legacy_progress.md); this file tracks the
fork's own work only.

Work on branch `claude/wizardly-mayer-srchqd`. Newest first.

**Intake 2026-07-12 (approved to build; not yet implemented):**
[changes/2026-07-12-webview-perf-and-sync-evaluation.md](./changes/2026-07-12-webview-perf-and-sync-evaluation.md)
— confirms Tailwind/UI libs are pre-fork (not the regression); audits remaining perf items
(F5/F3 deferred, P4 stringify) and the sync gap. User approved all four tiers. Refined scope:
"working memory" = the currently-open preset + its versioning only, NOT VS Code's workspace. ·
[bugs/2026-07-12-same-name-saved-as-duplicate-entries-not-snapshots.md](./bugs/2026-07-12-same-name-saved-as-duplicate-entries-not-snapshots.md)
— same-name saves forked duplicate entries; **FIXED step 1a** (name dedupe in `openFileAsPreset`).
Remaining tiers (S1/S2, F5, L1, QoL) still open.

**Intake 2026-07-10 (all resolved 2026-07-11):**
[bugs/2026-07-10-sync-conflict-data-loss.md](./bugs/2026-07-10-sync-conflict-data-loss.md) ·
[bugs/2026-07-10-extension-drag-reorder-broken.md](./bugs/2026-07-10-extension-drag-reorder-broken.md) ·
[changes/2026-07-10-audit-findings.md](./changes/2026-07-10-audit-findings.md)

## Perf + sync tiers: F5 incremental analysis, S2 forced pull (step 1b)

### 2026-07-12 / Session 2 — F5 + S2 (+ P4 verified)

- **F5 incremental macro analysis** — content typing now re-tokenizes ONLY the edited
  prompt(s) instead of clearing/reassigning `.macros` on every prompt. New store methods
  `queueIncrementalMacroAnalysis` / `_flushIncrementalMacros` / `_retokenizePrompt`; Pass 2/3
  extracted to `_rebuildMacroAggregates` (shared by full + incremental). Dirty prompt-ids
  accumulate in a `markRaw` scratch Set (lodash debounce keeps only the last arg). Structural
  edits keep the full `analyzeAllMacros`. Removes the ~300 ms post-pause list-wide re-render.
  Tests: `presetStore.test.js` "F5 incremental macro analysis" (5, incl. incremental≡full).
- **S2 forced pull** — `pollCloudNow({force})` + exported `syncNow()` bypass the hidden-tab
  guard so remote changes live-apply into the OPEN editor without switching the document.
  Auto-pull already existed; VS Code webviews report hidden/unfocused unreliably. Primitive
  is tested; the toolbar "Sync now" button is left to wire (needs a visual check).
  Test: `reproSaveSync.test.js` "F. syncNow() forces a pull even when the tab reports hidden".
- **S1 confirmed** — open preset + versioning already persist via `PERSIST_PATHS`
  (savedPresets incl. snapshots + currentPresetId), independent of VS Code workspace. No change.
- **P4 VERIFIED real** — persistedstate serializes `pick(state)` (whole library) per mutation
  before the debounced write; a large library still pays an O(size) stringify per keystroke.
  Fix (IndexedDB / change-detected split) deferred — needs deps + migration + profiling.
- Suite 99/99, lint clean. Full status + deferrals in
  [changes/2026-07-12-webview-perf-and-sync-evaluation.md](./changes/2026-07-12-webview-perf-and-sync-evaluation.md).
- **Live-validated** (chrome-devtools MCP, production bundle): F5 in the web SPA (only-edited-prompt
  re-tokenize, multi-prompt window, structural→full-pass; 0 console errors) and S2 with two real
  clients on the local worker (:8787 — cloud round-trip, live-apply without reload, hidden-guard
  reproduced). VS Code webview isn't reliably MCP-drivable; manual checklist + full results in
  [changes/2026-07-12-live-validation.md](./changes/2026-07-12-live-validation.md).
- **"Sync now" button wired + live-validated** — both AppToolbar sync dots are click-to-`syncNow()`
  (en+zh + toast). A real click on a hidden client forced a pull the auto-sync skips, updating the
  open editor; no-op click → "already up to date"; 0 console errors. Files: `AppToolbar.vue`,
  `languages.json`. Resolves the deferred QoL S2 wiring.

## Same-name presets — duplicate entries → deduped (step 1a)

### 2026-07-12 / Session 1 — bug fix (openFileAsPreset name dedupe)

Opening two DIFFERENT files that share a basename created two library entries with
identical names, because `openFileAsPreset` skipped the display-name dedupe that the
web/adopt path (`_adoptActivePreset` → `_dedupedPresetName`) already applies.

- **Fix** — `presetStore.js` `openFileAsPreset`: a genuinely-new entry's `displayName`
  now runs through `_dedupedPresetName` (known ids keep their name; distinct files
  become "MyPreset" / "MyPreset (2)"). Decided semantics: distinct stable ids are
  NEVER merged by name, only disambiguated (option "snapshot the OPEN lineage only").
- **Tests** — `test/presetStore.test.js` → "openFileAsPreset same-name handling"
  (dedupe-not-merge; same-file re-open keeps a stable name). Full suite 93/93, lint clean.
- **Deferred to S3 (identity unification):** cross-panel / post-cloud-merge name
  collisions, and same-file-different-id (workspace link vs unlink) lineage.
- Bug: [bugs/2026-07-12-same-name-saved-as-duplicate-entries-not-snapshots.md](./bugs/2026-07-12-same-name-saved-as-duplicate-entries-not-snapshots.md).
  Remaining tiers (S1/S2 working memory, F5 perf, L1 IndexedDB, QoL) in the
  [evaluation doc](./changes/2026-07-12-webview-perf-and-sync-evaluation.md).

## Perf: extension typing lag — fixed (extension 0.8.1)

### 2026-07-11 / Session 3 — implementation (F1, F2, F4, F6)

Fixed the reported webview typing lag. Full write-up + measured before/after in
[bugs/2026-07-11-extension-typing-lag.md](./bugs/2026-07-11-extension-typing-lag.md).
Per-keystroke main-thread time dropped **~90 ms → ~20 ms with zero long tasks**
(was one long task per keystroke), and per-keystroke cost no longer scales with
library size (22 ms at a 2.5 MB library vs 67 ms before F4).

- **F1** — `MacroAutocompleteTextarea.vue` uses native CSS `field-sizing: content`
  (rAF-coalesced JS fallback) → no forced reflow, and the per-keystroke double
  `scrollHeight` read is gone.
- **F2** — the persist config used v3 `paths`/`beforeRestore`/`afterRestore`,
  which **pinia-plugin-persistedstate v4 ignores**: the plugin was serializing the
  ENTIRE store (undo stacks, macros, snapshots, modal flags) every keystroke and
  the extension's active-area exclusion was void (latent stale-file-on-open bug).
  Migrated presetStore + syncStore to `pick`/`afterHydrate`, added a debounced
  localStorage adapter (`src/utils/persistStorage.js`, flush-on-hide).
- **F4** — saved-preset (and snapshot) `.data` is `markRaw`'d at every write site
  + `afterHydrate`/`applyCloudData` normalizers, keeping the whole saved library
  out of deep traversal + serialize. This is the structural win (size-independent
  typing).
- **F6** — the host no longer reconciles on the webview's OWN saves (self-write
  suppression in the FS watcher); external edits still reconcile. Removes the
  mid-typing 409/merge churn against the KV doc.
- **Deferred:** F3 (merge deep watchers — marginal after F4, would touch the
  just-shipped sync engine's `flush:'sync'` guard) and F5 (incremental analysis —
  targets the post-pause hitch, not per-keystroke; touches analysis core).
- **Validation:** vitest 91/91, eslint clean, web + webview builds, MCP-backed
  before/after typing measurement, extension repacked as **0.8.1** (0.7.1/0.8.0
  VSIX archived).

### 2026-07-11 / Session 2 — investigation only (superseded by Session 3)

Reproduced and attributed the lag (~90 ms/keystroke) via shimmed build +
chrome-devtools MCP + JS self-profiler; proposed F1–F6. See the bug file.

## Fix release: sync merge engine, webview drag, cleanup (extension 0.8.0)

### 2026-07-11 / Session 1 — implementation (all intake items fixed)

- **Sync (RC1–RC5 + C2)** — `cloudSync.js` refactored around a **persisted
  merge base** (`stpe:sync:base` in localStorage): restarts merge instead of
  clobbering; init routes local-changed-since-base through the merge rather
  than blind-adopting over the just-linked disk file; "already in sync" now
  verifies before sealing (offline edits push instead of orphaning); conflicts
  are merge-first with the web dialog scoped to genuine open-document forks
  ("keep mine" = merged conditional push, `forcePush` removed); push debounce
  gained `maxWait: 3000`; `buildSyncSnapshot` strips derived `prompt.macros`.
  One cloud identity per file (host `load` carries the folder-mapping id;
  auto-map reuses legacy `file:` entries). Details + residual risks in the bug
  file.
- **Webview drag reorder** — the handle is width-gated only in the browser;
  host mode renders it at every panel width (`PromptCard.vue`). Verified via
  shimmed-host MCP repro @701px (arm → draggable → dragstart) with an
  unshimmed browser control.
- **Cleanup (audit)** — splitpanes + paneSizes state, @vueuse/core,
  autoprefixer, postcss removed; NUL byte in `extension.js` → `'\0'` escape;
  `utils/clone.js` consolidation; unexported internal-only symbols; 0.3.1 VSIX
  archived; CLAUDE.md + stale sync comments rewritten. B7 skipped
  (engines < 1.82 ⇒ no guaranteed host `fetch`).
- **Validation:** vitest **91/91** (3 new restart-safety regression tests;
  the pre-existing dismissal-reprompt failure now passes), eslint clean, web +
  webview builds, **stpreseteditor-local-0.8.0.vsix** packaged with the fresh
  bundle.
- **Install step for the user:** install `extension/stpreseteditor-local-0.8.0.vsix`
  and redeploy the web app (`npm run deploy`) so both sides run the new engine.

### 2026-07-10 / Session 1 — investigation only (no code changes)

Diagnosed the three intake items; all findings are in the intake files above.

- **Sync data loss (both directions)** — five ranked root causes in
  `bugs/2026-07-10-sync-conflict-data-loss.md`. Headliners: extension startup
  blind-adopts the cloud over the just-linked open file (`cloudSync.js:407` +
  `openFileAsPreset` running before the sync subscription attaches), and
  `autoRebaseAndPush` merges against an EMPTY base when `syncedSerialized` is
  null while `pendingSync` persisted true (`cloudSync.js:163`) — local then
  wins everywhere, clobbering newer web edits. `npm test`: 88/89, the one
  failure (conflict-dialog re-prompt timing) is regression marker RC5.
- **Extension drag reorder dead** — reproduced via shimmed
  `acquireVsCodeApi` + Chrome DevTools MCP: host mode forces `isMobile=false`
  (drag needs the handle) but the handle is `hidden md:inline-flex`, i.e.
  `display:none` in any webview panel < 768 px. Details + repro data in
  `bugs/2026-07-10-extension-drag-reorder-broken.md`.
- **Dead-code / redundancy audit (report-only)** —
  `changes/2026-07-10-audit-findings.md`: `splitpanes` unused,
  lodash-es/@vueuse one-function overlap, autoprefixer+postcss residual,
  stale `extension/media` bundle (2026-06-18) vs 0.7.1 VSIX (2026-07-04),
  literal NUL byte makes `extension.js` grep-invisible (binary), CLAUDE.md
  drift (vuedraggable/splitpanes/DetailsModal/passphrase/“open file never
  synced”). Nothing deleted.

Next session: user picks fixes → change request(s) → grounded-coder.

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
