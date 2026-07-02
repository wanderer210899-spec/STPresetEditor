# STPresetEditor Improvement Spec

Status: **agreed scope** (owner questionnaire, 2026-07). This document is the
implementation contract for the next round of work. It has three layers:

- **Part A — Mandatory fixes**: logical inconsistencies found in review; several
  lose user data. These ship regardless of feature order.
- **Part B — Features F1–F8**: the agreed feature set, each with exact
  behaviour, data model, file touchpoints, and acceptance criteria.
- **Part C — Cross-cutting rules and phased delivery plan.**

Owner decisions from the questionnaire:

| Topic | Decision |
| --- | --- |
| Saving model | **Autosave + named snapshots** (F1) |
| Cloud sync | **Automatic**: focus + ~30 s polling, conflict prompt on clobber (F2) |
| Editor look | **Notion-style borderless blocks + hover controls + click-to-edit, desktop only; mobile view must not regress** (F3) |
| Variables | **Hover info cards + live variables panel + variable timeline** (F4) |
| VS Code | **Folder workspace: preset tree, create/duplicate/delete, folder ↔ cloud library sync** (F5) |
| Search | **Title + content, find-next navigation, global search across presets** (F6) |
| Right panel | **Expandable/maximizable; retire the pop-up Expand modal** (F7) |
| QoL | **Undo/redo everywhere, dark mode (incl. VS Code theme), keyboard shortcuts, token counts** (F8) |

---

## Part A — Mandatory fixes

### A1. Save/load data-loss model *(superseded by F1, listed for traceability)*
`savePreset()` (`src/stores/presetStore.js`) always generates a new ID —
saving twice duplicates the preset. `loadPreset()` overwrites the active area
without saving current edits (its comment claims otherwise). Both are replaced
by the F1 autosave model; no standalone fix needed, but F1's acceptance
criteria cover these cases explicitly.

### A2. Variable rename misses `{{if}}` conditions
`renameVariable()` rewrites `{{setvar::name…}}` / `{{.name…}}` forms but not
bare shorthand refs inside control macros (`{{if .flag}}`, `{{if $x > 3}}`),
even though `extractVarRefs()` counts them as references.
**Fix:** extend the rename pass with a third regex that rewrites `[.$]name`
occurrences inside control-macro bodies only (tokenize with `tokenizeMacros`,
apply inside tokens whose classification is `op === 'control'`; never rename
inside plain text).
**Accept:** renaming `flag`→`mood` rewrites `{{if .flag}}`→`{{if .mood}}`;
plain text containing `.flag` outside macros is untouched; Variables panel
shows zero remaining uses of the old name.

### A3. Collapse state persisted but ignored
`promptCollapseStates` is persisted + synced; `globalCollapseState` is not.
After reload the getter short-circuits on the default `'expanded'` and ignores
the saved map.
**Fix:** persist `globalCollapseState` (add to `persist.paths` and
`SYNC_DATA_PATHS` — see C2 rule) so mixed states survive reload.
**Accept:** collapse two prompts, reload → the same two are collapsed.

### A4. System-prompt delete guards are inconsistent
Library multi-delete (`_performDeleteSelectedPrompts`) deletes
`system_prompt` prompts; single delete and editor batch-delete refuse.
`selectAllEditorPrompts()` also selects system prompts whose checkboxes are
disabled, so the batch-bar count lies.
**Fix:** filter `system_prompt` prompts out of library multi-delete (toast the
skipped count, same as editor batch-delete) and out of
`selectAllEditorPrompts()`.
**Accept:** select-all in a preset with 3 system prompts selects N−3; library
multi-delete never removes a system prompt.

### A5. VS Code: loading a library preset overwrites the open file on disk
In extension mode, Preset Manager → Load replaces the active area, and the
debounced file mirror then writes that other preset over the open `.json`.
**Fix (interim, before F5):** in `isVsCodeHost()` mode, the Load action is
replaced by **"Open as new file"** — the host writes the chosen preset to a
new `.json` next to the open file (name-deduped) and opens it in a new editor
tab. The open file's content is never replaced by a library preset.
**Accept:** loading a library preset in VS Code never mutates the currently
open file; a new file appears and opens instead.

### A6. Search robustness
`orderedPrompts` / `libraryPrompts` call `p.name.toLowerCase()`; a prompt
without a `name` throws and blanks the list.
**Fix:** null-guard name/id/content in all search getters (folded into F6).

### A7. View preference stored as synced data
`macroDisplayMode` lives in `SYNC_DATA_PATHS` **and** inside each saved
preset's `data`. Flipping raw/preview marks the whole document dirty and
pushes to the cloud.
**Fix:** stop storing `macroDisplayMode` inside `savedPresets[*].data` (ignore
it on load for backward compat). It remains a synced *preference* at top
level. Same rule applies to new prefs (C2).

### A8. Stale collapse-state entries
`_performBatchDelete` and `_performDeleteSelectedPrompts` skip
`cleanupPromptCollapseState`. **Fix:** call it for every removed ID.

---

## Part B — Features

### F1. Autosave + snapshots

**Model.** The active editing area is always a view onto exactly one library
entry (`currentPresetId`). "Unsaved changes" cease to exist in web mode.

Behaviour:

1. **Autosave.** Any change to the active area (prompts, order, names,
   contents, enabled, role, collapse) writes into
   `savedPresets[currentPresetId].data` and bumps `updatedAt`, debounced
   **1000 ms**. Implemented as store-internal hook (not a `$subscribe`, to
   avoid loops with cloud sync): the mutating actions already funnel through a
   small set of methods; add `_touchActivePreset()` calls there, or a single
   debounced watcher over the active-area paths with a re-entrancy guard.
2. **Adoption.** If `currentPresetId` is null when an edit lands (fresh
   import, legacy state, factory reset), auto-create a library entry named
   from `originalFilename` (deduped "Name (2)") and point `currentPresetId`
   at it. Importing a JSON always ends with the active area linked to an
   entry.
3. **Save as copy.** The Preset Manager's "Save" button becomes **Save as
   copy**: duplicates the current entry under a deduped name and switches
   `currentPresetId` to the copy.
4. **Snapshots.** Per-preset named versions:
   ```js
   savedPresets[presetId].snapshots = [{
     id,            // uuid
     name,          // user label; default "Snapshot YYYY-MM-DD HH:mm"
     createdAt,     // ISO
     data: { rawJson, originalFilename, prompts, promptOrder }
   }, …]
   ```
   Actions: `createSnapshot(presetId, name?)`, `restoreSnapshot(presetId,
   snapshotId)`, `renameSnapshot`, `deleteSnapshot`. Restore first
   auto-creates a snapshot named `Before restore: <name>` so a restore is
   itself reversible. Cap **20 snapshots per preset**; creating the 21st
   deletes the oldest (toast informs). Snapshots live inside `savedPresets`,
   so they persist and cloud-sync with no new path.
5. **UI.** Preset Manager rows gain a snapshot count + expandable snapshot
   list (restore / rename / delete); toolbar gains a camera/snapshot button
   for the active preset. Keyboard: `Ctrl/Cmd+S` = create snapshot (F8-C).
6. **Extension mode.** The open file is not a library entry (until F5 links
   it); autosave-to-library is a **web-mode behaviour** — guard with
   `isVsCodeHost()`. The existing debounced file mirror is the extension's
   autosave.
7. `loadPreset()` no longer needs a warning path — there is nothing unsaved
   to lose. Remove the misleading comment.

**Files.** `presetStore.js` (model + actions), `PresetManagerModal.vue`,
`AppToolbar.vue`, `languages.json`.

**Accept:**
- Edit a loaded preset, wait 1 s, reload the page → edits are in the library
  entry; no duplicate entries exist.
- Repeatedly clicking Save-as-copy creates "Name (2)", "Name (3)", never two
  entries silently sharing a name and ID history.
- Restore an older snapshot → active area matches it; a "Before restore"
  snapshot exists; sync pushes the result.
- Snapshot list capped at 20 with oldest pruned.

### F2. Automatic cloud sync

**Pull triggers** (web and extension webview):
- `visibilitychange` → visible, and `window.focus`;
- every **30 s** while the document is visible (skip while hidden);
- after sign-in / key connect (existing `reconnectCloudSync`).

Poll = `GET /api/presets`; if `updatedAt` differs from `sync.lastSyncedAt`
and there are **no pending local edits**, adopt silently (existing
`applyCloudData` path). If both sides changed → conflict flow below.

**Conflict-safe push.** Worker `PUT /api/presets` gains an optional
`baseUpdatedAt` field in the body:
- If present and ≠ stored doc's `updatedAt` → **409**
  `{ error: 'conflict', updatedAt: <stored> }` (one extra KV read per PUT).
- If absent → current blind-write behaviour (backward compatible with old
  clients, and used for the explicit "keep mine" override).

Client (`cloudSync.js` `pushNow`): always send
`baseUpdatedAt = sync.lastSyncedAt`. On 409 → fetch cloud doc, open a confirm
dialog (existing `requestConfirm` service):
> "Another device updated this library at *time*. Keep **this device's**
> version, or use the **cloud** version?"
Keep-mine → force PUT (no `baseUpdatedAt`). Use-cloud → `applyCloudData` and
discard the local push. Either way `lastSyncedAt` converges.

**Extension.** The webview runs the same poll cadence (webviews receive
visibility events; poll only while the panel is visible) through
`hostCloudGet`/`hostCloudPut`; `hostCloudPut` forwards `baseUpdatedAt` and the
host's read-merge-write compares before writing. Status bar continues to show
sync state.

**Known limit (documented, not fixed):** Cloudflare KV is eventually
consistent (~60 s worst-case cross-edge). For a single owner switching
devices this is acceptable; true instant sync (Durable Objects) is explicitly
out of scope per questionnaire.

**Files.** `worker/index.js`, `src/stores/cloudSync.js`,
`src/stores/localBridge.js`, `extension/extension.js`, `syncStore.js`
(expose `conflict` status), `languages.json`. Tests in
`test/` for 409/reconcile paths.

**Accept:**
- Device A edits; device B (tab already open) shows the change within ~30 s
  or on refocus, with no reload.
- A and B both edit offline → the second pusher gets the conflict dialog; no
  silent overwrite in either direction.
- Old extension builds (no `baseUpdatedAt`) still push successfully.

### F3. Notion-style editor (desktop), mobile preserved

**Hard constraint:** mobile (< `md`) keeps the current card UI and all
controls; nothing hover-dependent on touch. Gate all hover-reveal styling
behind the `md:` breakpoint **and** `@media (hover: hover) and (pointer:
fine)`. Side panels and the toolbar remain.

**Desktop block design** (`PromptCard.vue`, `EditorView.vue`, `style.css`):
- Remove card chrome: no border, shadow, or filled background per prompt;
  blocks separated by whitespace (`space-y-4` → ~`space-y-1` + block
  `py-1.5`); drop the `px-8` content indent (align content with the title);
  cap content at a comfortable reading width (`max-w-[85ch]`) centred in the
  pane.
- **Hover controls:** a left gutter drag-handle (⋮⋮) and the right-side
  control row (role, enable, delete, overflow, expand) render at `opacity-0`
  and fade in on block hover/focus-within. The enable state must stay legible
  when idle: disabled blocks keep reduced text opacity + a small "off" chip.
- **Selection:** selected block gets a subtle tinted background or 2 px left
  accent bar (replaces the blue ring).
- **Collapsed block:** one line — chevron, name, token count (F8-D), and a
  dimmed first-line preview.
- **Click-to-edit in place:** clicking the rendered content swaps it for
  `MacroAutocompleteTextarea` inline, auto-grown to content height with
  identical font metrics/padding so the page does not jump. Exit on blur or
  `Escape` (both commit; text changes already debounce through
  `updatePromptDetail`). Macro highlighting/preview returns on exit. The
  title becomes click-to-edit inline the same way. Single click on a macro
  chip still selects the variable (chips stop click-through to edit; clicking
  non-macro text enters edit mode with the caret placed via the existing
  caret utility).
- The focus editor (expand button) and right-panel editing remain unchanged.
- Editor search/em-multi-select toolbar stays; raw/preview switch stays.

**Files.** `PromptCard.vue` (largest change), `MacroRenderer.vue` (chip
styling), `EditorView.vue`, `AppLayout.vue` (pane padding), `style.css`
(new `.block`/`.block-controls` primitives), `languages.json`.

**Accept:**
- Desktop: idle editor shows only text blocks + titles; controls appear on
  hover; clicking text places a caret and edits in place; screen fits ≈2×
  the prompts it does today at default zoom.
- Mobile: pixel-behaviour equivalent to today (cards, always-visible
  controls, drawers); no interaction requires hover.
- Raw/preview mode, drag-reorder, multi-select, collapse all still work.

### F4. Variable tracking (hover cards + live panel + timeline)

**Analysis additions** (`analyzeAllMacros`, derived — never persisted):
- `variableEndValues[varName]` — simulated value after the full pass.
- `variableTimelines[varName]` — ordered events:
  `{ macroId, promptId, promptName, op, kind, valueAfter, enabled }` for every
  def/ref in execution order (`valueAfter` = snapshot after the event; for
  pure reads, the value read).

**4a. Hover info cards** (`MacroRenderer.vue`, floating-vue): hovering any
variable macro (~150 ms delay) shows: name + scope badge, operation
(`set/add/read/…`), **simulated value at that point** (already in
`macroStateSnapshots`), defined-in prompt links, use count. Links call
`navigateToPrompt`. Replaces today's plain-string tooltip.

**4b. Live variables panel** (`VariableManager.vue`): each row shows the
variable, status icons (existing), and its **end value** (`variableEndValues`,
mono, `<undefined>`/`<empty>` styled dimmed). Reactivity is free — analysis
re-runs on reorder/toggle. Clicking a row (not the jump icon) sets
`selectedMacro` so every occurrence in the editor gets the existing ring
highlight, and adds **next/prev use** arrows in the panel header that walk
`variableTimelines[name]` with `navigateToPrompt`.

**4c. Timeline** (`MacroDetails.vue` + new `VariableTimeline.vue`): the
variable details view gains a third section: vertical step list in execution
order — prompt name, op badge (colour by kind: write/mutate/read), value
after the step, disabled prompts greyed with a "skipped" tag (their writes
don't affect simulation — matches engine behaviour). Clicking a step jumps to
that prompt/macro. This replaces the mental work of cross-referencing the
defined-in / referenced-in lists.

**Files.** `presetStore.js`, `MacroRenderer.vue`, `VariableManager.vue`,
`MacroDetails.vue`, new `RightSidebar/VariableTimeline.vue`,
`languages.json`.

**Accept:**
- Hover a `{{getvar::x}}` mid-preset → card shows the value x holds at that
  exact point (not the end value) with working jump links.
- Toggle a prompt containing `{{setvar::x::5}}` off → panel end value and
  timeline update immediately; the timeline row shows "skipped".
- Timeline of a variable with set → add → get shows three steps with correct
  intermediate values.

### F5. VS Code folder workspace

**5a. Presets tree.** New Explorer view **"ST Presets"** (TreeView,
`extension/extension.js` + `package.json` contributions):
- Lists workspace `.json` files matching `stpe.presetGlob` (default
  `**/*.json`, excluding `node_modules`) that parse as ST presets (heuristic:
  object with a `prompts` array). Badge non-presets out silently.
- Item actions (context menu + inline icons): **Open in STPE** (existing
  webview-per-file), **New preset** (writes a starter file from the bundled
  example template, name prompt, opens it), **Duplicate**, **Rename**,
  **Delete** (confirm; `workspace.fs`), **Reveal in Explorer**.
- The tree refreshes on a `FileSystemWatcher` over the glob.

**5b. Folder ↔ cloud library sync (opt-in).** Command **"STPE: Link folder to
cloud library"**:
- Mapping file `.stpe-library.json` at the folder root:
  `{ files: { "<relative path>": { presetId, lastSyncedHash } } }` (committed
  or gitignored at the user's choice; document both).
- **Push:** on file save/change, parse the file, write it into
  `savedPresets[presetId].data` (create the entry on first sync, named from
  the filename) through the existing library push
  (`EXTENSION_LIBRARY_PATHS` engine, read-merge-write preserved).
- **Pull:** cloud entries with no mapped file are offered by a **"Download
  missing presets"** command (writes `<name>.json`, adds mapping). Changed
  cloud entries update mapped files **only when the local file is unchanged
  since `lastSyncedHash`**; if both changed → per-file conflict prompt (keep
  local / keep cloud), mirroring F2.
- Tree shows per-file state: synced ✓ / pending ↑ / conflict ⚠ /
  local-only / cloud-only.
- Reconcile runs on the F2 cadence while a panel is open, plus the existing
  status-bar button.

**5c. In-webview fixes.** "New preset" inside the extension webview asks the
host to create a file (5a flow) instead of mutating the open one; Preset
Manager "Load" follows A5 ("Open as new file").

**Files.** `extension/extension.js` (tree, watcher, mapping, commands),
`extension/package.json` (views, commands, menus, `stpe.presetGlob`),
`localBridge.js` (new messages: `createPresetFile`, per-file sync state),
`EXTENSION_PLAN.md` update.

**Accept:**
- A folder of 5 preset JSONs shows 5 tree items; New/Duplicate/Rename/Delete
  work and refresh the tree; each opens in its own tab.
- Link the folder, edit a file → the same preset appears/updates in the web
  app's library within one sync cycle; edit it on the web → the file updates
  after "Download/refresh" or the next reconcile, or prompts on conflict.
- Deleting a file never deletes the cloud entry without an explicit prompt.

### F6. Search (content + navigate + global)

**6a. Title + content.** `orderedPrompts` / `libraryPrompts` match
case-insensitive against `name`, `id`, **and `content`** (null-guarded, A6).
Editor cards highlight matches: content match spans get a shared `<mark>`
style (integrated into `contentParts` splitting so macro chips are never
split mid-token); title matches highlight in the header. The search box shows
**"N matches in M prompts"**.

**6b. Find & navigate.** While the editor search has a term: ↑/↓ buttons +
"x / N" counter beside the box; `Enter` / `Shift+Enter` in the box cycle
matches; navigation scrolls to the prompt (existing flash), auto-expanding a
collapsed prompt for the duration of the visit. `Ctrl/Cmd+F` focuses the
editor search (preventDefault) (F8-C).

**6c. Global search.** `Ctrl/Cmd+K` opens a palette modal (new
`GlobalSearchModal.vue`, on `BaseModal`): one input searching, debounced
250 ms — the active preset's prompts **and every saved preset's** names +
prompt names + contents. Results grouped by preset with snippet + highlight.
Selecting a result in another preset loads that preset (safe under F1
autosave — nothing to lose) and jumps to the prompt. Plain substring search;
no regex (batch-replace already owns regex).

**Files.** `presetStore.js` (getters + `searchAllPresets` action),
`EditorView.vue`, `PromptCard.vue` (mark rendering), `PromptLibrary.vue`,
new `GlobalSearchModal.vue`, `App.vue` (mount), `languages.json`.

**Accept:**
- Searching a word that appears only inside prompt text filters correctly in
  both panes and highlights the hits.
- Enter cycles through 7 matches across 4 prompts, expanding collapsed ones.
- `Ctrl+K` + phrase finds a prompt inside a non-loaded saved preset; choosing
  it loads that preset and lands on the prompt.

### F7. Expandable right panel

- Persist Splitpanes sizes (`paneSizes`, localStorage-only — **not** synced)
  via `@resized`; restore on mount.
- Add a **maximize toggle** in the right pane's tab bar: expands the right
  pane to 60 % (left pane collapses to icons-width or hides; editor keeps the
  rest); toggling back restores the previous sizes.
- Retire `DetailsModal` + the "Expand" button in `MacroDetails.vue`
  (`VariableUsageList` keeps its dense/roomy variants — roomy renders when
  maximized). Delete `isDetailsModalOpen` state.
- Mobile drawers unchanged.

**Files.** `AppLayout.vue`, `RightSidebar.vue`, `MacroDetails.vue`, remove
`DetailsModal.vue`, `presetStore.js` (drop modal state, add `paneSizes`,
`isRightPaneMaximized`), `languages.json`.

**Accept:** drag-resize survives reload; maximize gives the Variables tab
(incl. F4 timeline) ≥60 % width; no pop-up modal remains.

### F8. Quality of life

**8a. Undo/redo everywhere.** Store-level history (not persisted, cap 100):
- Command pattern over mutating actions: add/delete/hide prompt, reorder,
  enable/role changes, rename variable, batch ops (absorb the existing
  batch-replace stacks into the unified history), snapshot restore.
- Text edits: coalesce per prompt+field — a burst of `updatePromptDetail`
  calls within 1 s = one undo step storing before/after.
- While focus is inside a textarea/input, the browser's native text undo
  applies; the store-level `Ctrl/Cmd+Z` / `Ctrl/Cmd+Shift+Z` (and `Ctrl+Y`)
  handler only fires when focus is outside editable fields.
- Loading/importing a preset and applying cloud data **clear** the stack
  (cross-document undo is out of scope).
- Toolbar undo/redo buttons with tooltips describing the step ("Undo delete
  prompt 'X'").

**8b. Dark mode.** Tailwind `dark:` variants keyed on a `.dark` root class.
Setting: light / dark / system (persisted + synced pref → `persist.paths` +
`SYNC_DATA_PATHS`, per C2). In the extension webview, ignore the app setting
and follow VS Code (`body` class `vscode-dark`/`vscode-high-contrast` +
`onDidChangeActiveColorTheme` forwarded over the bridge). Deliverables: dark
values for the `style.css` primitives, pane backgrounds, macro chip palette
(`MacroRenderer` CATEGORY_STYLES), modals, tooltips, scrollbars.

**8c. Keyboard shortcuts.** Global handler (skips editable-field focus where
noted): `Ctrl/Cmd+Z` / `Ctrl/Cmd+Shift+Z` undo/redo (8a) · `Ctrl/Cmd+F`
focus editor search (6b) · `Ctrl/Cmd+K` global search (6c) · `Ctrl/Cmd+S`
snapshot (F1; preventDefault) · `Ctrl/Cmd+E` toggle raw/preview ·
`Alt+↑/↓` move selected prompt · `N` new prompt (only when not typing) ·
`?` opens a shortcuts help modal (also linked from Settings). All shortcuts
listed in `languages.json` for the help modal.

**8d. Token counts.** Lightweight estimator (no tokenizer dependency):
`estimateTokens(text)` ≈ `ceil(words × 1.3 + specials)` — implemented in
`src/utils/tokens.js`, documented as approximate, always displayed with "≈".
Cached per prompt keyed on content hash, recomputed with the debounced
analysis. Display: per-block count in the header/collapsed row (F3), and a
toolbar total for **enabled, in-order** prompts. Upgrade path (out of scope):
optional real tokenizer via lazy-loaded chunk.

**Accept:**
- Delete a prompt, `Ctrl+Z` → it returns in the same position with its
  collapse state; redo removes it again. Reordering and role changes undo.
- OS dark mode → app follows in "system"; VS Code dark theme → extension
  webview dark regardless of app setting.
- Every shortcut above works and appears in the `?` modal; none fire while
  typing in a field (except the explicitly global ones: S, F, K, Z on the
  documented terms).
- Token totals change when a prompt is disabled; per-prompt counts visible
  on collapsed rows.

---

## Part C — Cross-cutting rules

### C1. i18n
Every new user-facing string gets a key in `languages.json` under **both**
`en` and `zh`, consumed via `store.t()`. No hard-coded strings (existing
convention, CLAUDE.md).

### C2. Persistence & sync paths
New persisted fields go to `persist.paths` **and** `SYNC_DATA_PATHS`
(CLAUDE.md rule) with these exceptions:
- Local-only UI state (`paneSizes`, `isRightPaneMaximized`, undo stacks,
  search terms): neither list.
- Prefs that must not live inside preset `data`: `globalCollapseState` (A3),
  `theme` (8b) — top-level synced prefs, never written into
  `savedPresets[*].data` (A7 rule).
- Extension: new library-relevant fields ride `EXTENSION_LIBRARY_PATHS`
  automatically; anything active-area goes in `EXTENSION_LOCAL_ONLY_PATHS`.

### C3. Backward compatibility / migration
- Old cloud docs and localStorage restore cleanly: missing `snapshots` ⇒
  treated as `[]`; presets whose `data` still contains `macroDisplayMode` /
  `promptCollapseStates` load but no longer write those keys (A7).
- Worker PUT without `baseUpdatedAt` keeps blind-write semantics (old
  clients keep working).
- `.stpe-library.json` is additive; unlinked folders behave exactly as today.

### C4. Testing (vitest, existing setup)
Minimum new coverage: F2 conflict matrix (409 → keep-mine / keep-cloud;
silent adopt; poll no-op), F1 autosave + snapshot cap + restore-creates-
snapshot, A2 rename-in-conditionals, F6 getters (content match, null name),
8a undo/redo round-trips, 8d estimator sanity. Extension sync tests extend
`test/extensionSync.test.js` for the mapping/merge rules.

### C5. Lint/format
`npx eslint .` and `npx prettier --write .` clean before each commit.

---

## Delivery phases

Ordered so data-safety lands first and visual churn lands together:

| Phase | Contents | Rationale |
| --- | --- | --- |
| **1** | F1 autosave + snapshots; fixes A2–A8 | Stops all data loss; unblocks F2 |
| **2** | F2 automatic sync + Worker conditional PUT | The "seamless" ask; needs F1 |
| **3** | F6 search (a+b+c); F7 expandable panel | High value, low risk, independent |
| **4** | F3 Notion restyle + 8b dark mode + 8d token counts | One visual overhaul, one review |
| **5** | F4 variables (hover cards, live panel, timeline) | Builds on restyled chips |
| **6** | 8a undo/redo + 8c shortcuts | Touches many actions; after churn settles |
| **7** | F5 VS Code folder workspace (+ A5 interim ships in Phase 1) | Largest extension work; uses F2 conflict flow |

Each phase is independently shippable and ends green on lint + tests.
