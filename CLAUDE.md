# CLAUDE.md

Guidance for working in this repository. Read this first: it maps features to the
files that own them, so changes land in the right place.

## What this is

STPresetEditor is a single-page **Vue 3** app for visually editing SillyTavern
`preset.json` files — managing prompts, ordering them, and analysing the
`{{...}}` macro/variable system. This fork adds **optional private cloud sync** on
Cloudflare so the same library is available across devices.

Two runtime shapes from the same code:

- **Static SPA (default):** all data lives in the browser's `localStorage`.
  Works with `npm run dev` or any static host.
- **Cloudflare Worker (this fork):** the same SPA plus a small `/api/presets`
  sync API backed by Cloudflare KV. When the API is unreachable or the user is
  not authenticated, it silently falls back to local-only.

## Tech stack

- Vue 3 (Composition API, `<script setup>`)
- Pinia + `pinia-plugin-persistedstate` **v4** (state + localStorage; use
  `pick`/`afterHydrate`, and a debounced storage adapter — see Architecture)
- Vite 7 (build), Tailwind CSS v4 (`@tailwindcss/vite`)
- Headless UI + Heroicons (accessible dialogs/menus/tabs/icons)
- floating-vue (tooltips), lodash-es (debounce)
- Auto-grow textareas use native CSS `field-sizing: content` (rAF-coalesced JS
  fallback) — no per-keystroke layout reads (`MacroAutocompleteTextarea.vue`)
- Desktop 3-pane = collapsible columns in `AppLayout.vue` (no splitter lib);
  drag-reorder = native HTML5 DnD in `PromptCard.vue`, armed from the ⋮⋮
  handle on desktop/host (no drag lib)
- Cloudflare Workers + KV + Wrangler (deploy)

## Architecture: one store, derive everything

The single source of truth is the Pinia **preset** store
(`src/stores/presetStore.js`). Components dispatch actions → state changes →
getters/computed re-render. Components hold almost no business logic.

- **Persisted to localStorage** = portable data only (`PERSIST_PATHS`, wired as
  the plugin's `persist.pick`): `rawJson`, `originalFilename`, `prompts`,
  `promptOrder`, `macroDisplayMode`, `currentLanguage`, `promptCollapseStates`,
  `skipDeleteConfirmation`, `savedPresets`, `currentPresetId`, `defaultPresetId`.
  **pinia-plugin-persistedstate is v4** — use `pick`/`beforeHydrate`/`afterHydrate`,
  NOT the v3 `paths`/`beforeRestore`/`afterRestore` (v4 silently ignores those and
  persists the WHOLE store — a real perf + wrong-file-on-open bug). Writes go
  through a debounced localStorage adapter (`src/utils/persistStorage.js`,
  ~400 ms, flush on hide/unload) so a burst of edits serializes once, not per
  keystroke.
- **Saved library `.data` is `markRaw`'d (non-reactive).** `savedPresets[*].data`
  (and each snapshot's `.data`) is an opaque snapshot — components read
  `entry.name`/`updatedAt`, never `.data` internals, and every writer REPLACES
  `.data` wholesale. `markRaw` keeps the whole library out of deep-watcher
  traversal + the persist serializer's proxy walk, so typing cost doesn't scale
  with library size. Helpers `rawData()` / `markRawLibrary()` in `presetStore.js`;
  keep the invariant when adding a new `savedPresets[id].data = …` site, and never
  mutate `.data` in place.
- **Derived / NOT persisted:** macro analysis (`variables`,
  `unresolvedVariables`, `macroStateSnapshots`), selection, search, modal flags,
  mobile flags, undo/redo stacks. Recomputed after a restore by `analyzeAllMacros()`
  (in `afterHydrate`).
- That **same path list is also exported as `SYNC_DATA_PATHS`** and is exactly
  what gets synced to the cloud. **When you add a persisted field, update BOTH
  `persist.pick` (via `PERSIST_PATHS`) and `SYNC_DATA_PATHS`** (both live in
  `presetStore.js`). If the field belongs to the saved-preset library (not the
  active editing area), it is picked up by `EXTENSION_LIBRARY_PATHS` automatically
  (it's `SYNC_DATA_PATHS` minus the active-area/per-file paths); add it to
  `EXTENSION_LOCAL_ONLY_PATHS` instead if it should stay local to the VS Code
  extension.

### Startup order (`src/main.js`)

1. The persist plugin restores from localStorage.
2. `bootstrap()` awaits `initCloudSync()` — reconciles local vs cloud and adopts
   the user's cloud library if they are authenticated.
3. Only if there is still no data, it loads the bundled `src/assets/example.json`.

This order prevents briefly flashing the example over a real cloud library.
`App.vue` deliberately does **not** load the example — that is owned by `main.js`.

## Cloud sync (this fork's addition)

```
Browser (Pinia preset store)
  └─ src/stores/cloudSync.js        pull on load, debounced push on change
       └─ /api/presets (GET/PUT)  ──►  worker/index.js
                                         ├─ serves the built SPA (ASSETS binding)
                                         ├─ /api/auth/*, /api/keys → D1 (DB binding)
                                         └─ Cloudflare KV (PRESETS namespace)
```

**Auth model: one deployment = one owner.** Sign in with email + password
(sessions in D1) on the web; the VS Code extension / any client uses a generated
API key (`X-API-Key`). Both resolve to the KV key `user:<id>`. Recovery is the
`EMERGENCY_RESET_TOKEN` Worker-var backdoor (no email service). See `AUTH_PLAN.md`.

- **`src/stores/cloudSync.js`** — orchestration. `initCloudSync()` reconciles
  once, then subscribes to store changes and pushes (debounced ~1.5s, hard
  upper bound `maxWait` 3s — the store's own derived mutations re-arm the
  trailing edge). **Merge-first conflict handling:** the last-synced snapshot
  persists in localStorage (`stpe:sync:base`) as a 3-way merge BASE across
  restarts; divergence resolves through `resolveDivergence()` — per-entry
  merge of `savedPresets` (base-aware; `updatedAt`-newer wins when the base is
  unknown), local-wins-since-base for prefs. Only a genuine fork of the OPEN
  document (both sides changed `rawJson`/`prompts`/`promptOrder`) asks the
  user (web): "keep mine" pushes the MERGE with my document (conditional PUT,
  other devices' entries survive), "use cloud" adopts wholesale, dismissal
  defers. `reconnectCloudSync()` (sign-in/out, key connect/disconnect) clears
  the persisted base first. Any failure ⇒ local-only. **Transport is
  pluggable:** the web app uses `fetch('/api/presets',{credentials:'include'})`
  and syncs the full `SYNC_DATA_PATHS`; the VS Code extension routes the _same_
  reconcile through the host bridge (`hostCloudGet`/`hostCloudPut`) and syncs
  `EXTENSION_LIBRARY_PATHS` only. `buildSyncSnapshot()` strips derived
  `prompt.macros` (recomputed after apply) so analysis never causes diffs.
- **`src/stores/localBridge.js`** — the extension's host seam. (a) File: mirrors
  the OPEN preset to a local `.json` over the webview↔host postMessage bridge
  (`parseFromJson` in, `finalJson` out); the open file is ALSO linked to a
  stable library entry (`openFileAsPreset` — the host's `load` supplies the
  folder-mapping id when the workspace is linked, else `file:<path>`), so it
  cloud-syncs two-way INSIDE `savedPresets`, never as top-level active-area
  keys. (b) Cloud transport: connect/validate an API key (held in VS Code
  SecretStorage, never in the webview) and expose `hostCloudGet`/`hostCloudPut`
  for cloudSync.js. `isVsCodeHost()` selects host vs web mode everywhere.
- **`src/stores/authStore.js`** — account/session state + API-key management over
  `/api/auth/*` and `/api/keys`. **`src/components/SyncSetup.vue`** — the shared
  sync panel (sign in / create account / recovery / generate-key), shown in
  `SettingsModal.vue`.
- **`src/stores/syncStore.js`** — sync status only (`cloudEnabled`, `status`,
  `lastSyncedAt`, `pendingSync`, `fileLink`). Kept separate from the data store
  so status updates never look like editable-data changes. Persists
  `lastSyncedAt`, `pendingSync`.
- **`worker/index.js` + `worker/auth.js`** — the Worker. `identify()` resolves a
  session cookie or `X-API-Key` → KV key `user:<id>`; no identity ⇒ **401, fail
  closed**. `auth.js` is dependency-free (Web Crypto PBKDF2 + D1); passwords,
  sessions, and API keys are stored only as hashes. No secrets in the repo.
- **`wrangler.jsonc`** — Worker config. KV `PRESETS` has **no id** (auto-provisioned
  per deployer). D1 binding `DB` holds accounts; forkers run `wrangler d1 create`
  - `migrations apply`. Optional Worker vars: `OWNER_EMAIL`, `EMERGENCY_RESET_TOKEN`.

Wire format between store and Worker: `{ updatedAt, data }`, where `data` is a
`SYNC_DATA_PATHS` snapshot produced by `buildSyncSnapshot()` and applied by
`applyCloudData()` (both in `presetStore.js`).

## Macro system (the core editor feature)

The macro vocabulary lives in **`src/utils/macros.js`** — the single source of
truth for **tokenizing** (`tokenizeMacros`), parsing (`classifyMacro`), highlight
categories (`getMacroCategory` / `categoryOf`), and the autocomplete catalog
(`MACRO_CATALOG` / `VAR_MACRO_META`). It mirrors SillyTavern's current set:
variable macros `get/set/add/inc/dec/has/delete` **and** their `global` variants,
flow-control blocks (`{{if}}`/`{{else}}`/`{{/if}}`, category `control`), plus
identity/chat/time/utility macros. It also parses the **Macros 2.0 shorthand** —
`{{.name}}` (local) / `{{$name}}` (global) with `=` `+=` `-=` `++` `--` `??=`
`||=` — into the same `{ kind, op, scope }` shape, so analysis/preview/highlight/
rename treat shorthand and `::` forms identically. **Add new macros here**, not
inline in components.

**Tokenizing is brace-balanced** (`tokenizeMacros`): a macro whose value contains
a nested `{{...}}` (e.g. `{{.genre = …{{char}}…}}`), spans multiple lines, or
holds XML is captured whole; escaped `\{\{`/`\}\}` are literal; an unclosed `{{`
is not a macro. It returns `{ start, end, full, inner }` and is the only `{{...}}`
scanner — never re-introduce a `/{{.*?}}/` regex (it stops at the first inner
`}}`). Each `MacroData` carries `start`/`end` so `PromptCard` slices content by
offset rather than `indexOf`.

`analyzeAllMacros()` in `presetStore.js` is the analysis engine. Guiding rule:
**only prompts currently in `promptOrder` are analysed** (hidden prompts are
ignored). Passes:

1. Clear stale `prompt.macros`.
2. Parse each `{{...}}` via `classifyMacro` into a `MacroData`
   (`{ id, full, type, varName, value, params, scope, kind, op }`);
   `id = \`${promptId}-${matchIndex}\``. `kind`is`get`(reads) /`set`(assigns) /`mutate`(add/sub/inc/dec/cond — reads **and** writes);`op` is
   the normalised operation that drives the value simulation.
3. Walk the flattened execution flow: build definition/reference maps (`set` +
   `mutate` define; `get` + `mutate` reference) **and** simulate values (by `op`)
   — writes only mutate the simulated state when the prompt is `enabled`.
4. Aggregate into `variables`, `unresolvedVariables` (referenced-but-undefined),
   and `macroStateSnapshots` (each getvar's value at its execution point).

Variables are tracked **by name** (local and global share a name bucket; each
macro still carries its `scope` for highlighting/autocomplete). `renameVariable`
rewrites every variable-macro form in one regex.

Runs on every structural edit; debounced (300ms) for content typing via
`analyzeAllMacrosDebounced`. Two display modes via `macroDisplayMode`: `raw`
(highlighted source) and `preview` (get → value; write/comment/noop hidden).

**Custom autocomplete dictionary:** users extend the catalog from Settings —
`customMacros` (`{{name}}` snippets) and `customWraps` (paired notations like
`<!-- … -->`, seeded by `defaultCustomWraps()`). Both are **additive**, persisted,
**and synced** (added to `persist.pick` via `PERSIST_PATHS` + `SYNC_DATA_PATHS`); store actions live
in `presetStore.js`, the editing UI in `SettingsModal.vue`. The textarea merges
`customMacros` into the `{{` menu and exposes **Ctrl+Space** to open a snippet
menu (wraps first) that wraps the current selection or drops the caret between
`open`/`close`.

**Writing prompts:** `MacroAutocompleteTextarea.vue` provides the `{{`
autocomplete (macro names, then variable names after a variable macro's `::`).
It backs both the inline details textarea and the distraction-free **focus
editor** (`FocusEditorModal.vue`, content-only, opened from a prompt card's
expand button / double-click, or the right pane's Expand; state:
`focusEditorPromptId`).

## File routing — "to change X, edit Y"

**Entry / shell**

- App bootstrap + cloud-first load order → `src/main.js`
- Root component, mounts global modals → `src/App.vue`
- Desktop 3-pane vs mobile drawers, mobile breakpoint → `src/components/AppLayout.vue`
- Top toolbar (import/export/presets/settings buttons, mobile menu, **sync status
  dot**) → `src/components/AppToolbar.vue`

**State / logic (most business changes go here)**

- All preset data, prompt CRUD, ordering, macro analysis, saved presets,
  batch-replace, i18n `t()`, persistence, confirm/toast services, focus-editor
  state → `src/stores/presetStore.js`
- Macro vocabulary: brace-balanced `tokenizeMacros`, parse/classify
  (incl. conditionals + shorthand), highlight categories, autocomplete catalog,
  `defaultCustomWraps()` → `src/utils/macros.js`
- Caret pixel coordinates (for the autocomplete dropdown) → `src/utils/caret.js`
- Host/webview detection + editor mode (`web`/`file`/`library`) → `src/utils/host.js`
- Search-term highlight splitting → `src/utils/highlight.js`
- Keyboard shortcut registration/handling → `src/utils/shortcuts.js`
- Token estimate + formatting → `src/utils/tokens.js`
- Plain deep-clone (proxy-safe) → `src/utils/clone.js`
- Debounced localStorage adapter for the persist plugin → `src/utils/persistStorage.js`
- Cloud-sync behaviour (reconcile, merge, conflict flow) → `src/stores/cloudSync.js`
- Sync status (`cloudEnabled`/`status`/`lastSyncedAt`/`pendingSync`/`fileLink`) → `src/stores/syncStore.js`
- Account/session + API-key state → `src/stores/authStore.js`
- Worker API / auth / KV access → `worker/index.js`
- Worker config + bindings → `wrangler.jsonc`

**Left pane — prompt library**

- Library list, search, multi-select, add-to-editor → `src/components/LeftSidebar/PromptLibrary.vue`
- A single library row → `src/components/LeftSidebar/PromptLibraryItem.vue`

**Middle pane — editor**

- Ordered draggable list, editor search, contextual batch toolbar, multi-select
  toggle → `src/components/MainEditor/EditorView.vue`
- A single prompt card (role select, enable switch, menus, expand/focus button,
  double-click-to-edit, renders content) → `src/components/MainEditor/PromptCard.vue`
- Rendering one macro (raw vs preview, category highlight, click-to-find) → `src/components/MainEditor/MacroRenderer.vue`
- Batch find/replace + prefix/suffix/serial UI (calls `batchReplaceText`) → `src/components/MainEditor/BatchReplaceModal.vue`
- `{{` macro + variable autocomplete `<textarea>` (incl. custom macros and the
  **Ctrl+Space** wrap/snippet menu; used here and in modals) → `src/components/MacroAutocompleteTextarea.vue`
- Distraction-free content-only writer (autocomplete, editable name, no identifier) → `src/components/FocusEditorModal.vue`

**Right pane — details / variables**

- Tab shell (Details ⇄ Variables) + batch-replace overlay → `src/components/RightSidebar/RightSidebar.vue`
- Routes to prompt-details or macro-details by selection → `src/components/RightSidebar/DetailsView.vue`
- Edit the selected prompt's fields (Expand opens the focus editor) → `src/components/RightSidebar/PromptDetails.vue`
- Shared name/identifier/content fields (uses the autocomplete textarea) → `src/components/RightSidebar/PromptFields.vue`
- A variable's definition/reference lists → `src/components/RightSidebar/MacroDetails.vue`
- One defined/referenced list, shared by inline + modal → `src/components/RightSidebar/VariableUsageList.vue`
- Variables tab: list, status icons, safe rename → `src/components/RightSidebar/VariableManager.vue`
- A variable's execution timeline (writes/reads in order) → `src/components/RightSidebar/VariableTimeline.vue`

**Modals** (all build on the shared shell)

- Shared modal shell (Headless UI: transitions, focus-trap, Esc, title/footer
  slots, `size`) → `src/components/BaseModal.vue`
- In-app confirm dialog, store-driven (replaces `window.confirm`) → `src/components/ConfirmDialog.vue`
- Toast notifications, store-driven (replaces `alert`) → `src/components/ToastHost.vue`
- Import JSON → `src/components/JsonImportModal.vue`
- Export JSON → `src/components/JsonExportModal.vue`
- Settings (language, **cloud sync/account**, delete-confirm, **autocomplete
  dictionary**, factory reset, build stamp) → `src/components/SettingsModal.vue`
- Shared sync panel (sign in / create account / recovery / API keys; web +
  extension modes) → `src/components/SyncSetup.vue`
- Saved-preset manager (search/sort/multi-select CRUD, snapshots) → `src/components/PresetManagerModal.vue`
- Global search palette (Ctrl+K, cross-preset) → `src/components/GlobalSearchModal.vue`
- Keyboard-shortcuts help → `src/components/ShortcutsHelpModal.vue`

**Assets / config**

- Default/example preset → `src/assets/example.json`
- UI strings (en/zh), consumed by the `t()` getter → `src/assets/languages.json`
- Global styles **+ shared UI primitives** (`.btn`/`.btn-icon`/`.input`/
  `.field-label`/`.section-title` in `@layer components`) → `src/style.css`
- Build + version stamp (`VITE_APP_VERSION` from the git commit) → `vite.config.js`

## Conventions

- Vue 3 `<script setup>`, Composition API. Keep business logic in the store, not
  in components.
- Lint/format before committing: `npx eslint .` and `npx prettier --write .`
  (config: `eslint.config.js`, `.prettierrc`).
- **i18n:** never hard-code user-facing strings. Add a key to `languages.json`
  under **both** `en` and `zh`, then use `store.t('path.key')`. Keep both
  languages in sync.
- The editor targets `character_id: 100001` inside `prompt_order`. Import/export
  only touch that character's `order` and never clobber the rest of the file.

## Commands

```bash
npm install
npm run dev          # local dev (http://localhost:5173); always local-only
npm run build        # production build → dist/
npm run deploy       # build + wrangler deploy (Cloudflare Worker)
npm run cf-preview   # build + wrangler dev (test the Worker + API locally)
```

Cloud-sync setup (account sign-in + API keys for the extension) and one-click
deploy are documented in **README.md → Private cloud sync (Cloudflare)**.
