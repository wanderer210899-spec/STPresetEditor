# CLAUDE.md

Guidance for working in this repository. Read this first: it maps features to the
files that own them, so changes land in the right place.

## What this is

STPresetEditor is a single-page **Vue 3** app for visually editing SillyTavern
`preset.json` files — managing prompts, ordering them, and analysing the
`{{...}}` macro/variable system. This fork adds **optional private cloud
storage** on Cloudflare: passive, NAME-keyed storage of presets (one record per
preset name — never two records for one name), so the same library is available
across devices without an automatic multi-writer sync engine.

Two runtime shapes from the same code:

- **Static SPA (default):** all data lives in the browser's `localStorage`.
  Works with `npm run dev` or any static host.
- **Cloudflare Worker (this fork):** the same SPA plus a small name-keyed
  `/api/presets` storage API backed by Cloudflare KV. When the API is
  unreachable or the user is not authenticated, it silently falls back to
  local-only.

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
- **Preferences are local-only.** The cloud stores named PRESETS, not settings:
  when you add a persisted field, add it to `PERSIST_PATHS` (in
  `presetStore.js`; wired as `persist.pick`). In the VS Code extension the
  active-area/per-panel keys are excluded via `EXTENSION_LOCAL_ONLY_PATHS`
  (both webview panels share one localStorage — persisting the open file would
  cause "wrong file on open").

### Startup order (`src/main.js`)

1. The persist plugin restores from localStorage.
2. `bootstrap()` branches by `getEditorMode()`:
   - **web** — awaits `initCloudSync()` (adopts the signed-in user's cloud
     library, per name), THEN loads the bundled `src/assets/example.json` only
     if there is still no data.
   - **file** (VS Code file editor) — `initLocalBridge()` only. No cloud engine:
     the host pushes the file content; edits mirror to disk.
   - **library** (VS Code cloud browser) — `initLocalBridge()` +
     `initCloudSync()` (mirrors the cloud list), then opens the Preset Manager
     over a BLANK editor — the cloud library is a list you load from. Never
     loads the example.

`App.vue` deliberately does **not** load the example — that is owned by `main.js`.

## Cloud storage (this fork's addition) — "storage + explicit save"

```
Browser (Pinia preset store)
  └─ src/stores/cloudSync.js     per-preset client (adopt / put / delete by NAME)
       └─ /api/presets[/:name] ──►  worker/index.js
                                      ├─ serves the built SPA (ASSETS binding)
                                      ├─ /api/auth/*, /api/keys → D1 (DB binding)
                                      └─ Cloudflare KV (PRESETS namespace)
                                          one record per preset: user:<id>:p:<name>
```

**The cloud is passive, NAME-keyed storage.** A cloud preset is identified by
its name; there is never more than one record per name (the structural fix for
the old cross-device duplication bug — no ids to diverge, no documents to
merge). Writing an existing name replaces it (newest wins); `PUT ?snapshot=1`
(the explicit send) keeps the replaced version as a restorable snapshot inside
the record. There is NO background reconcile, NO conflict dialog, NO polling.

**Auth model: one deployment = one owner.** Sign in with email + password
(sessions in D1) on the web; the VS Code extension / any client uses a generated
API key (`X-API-Key`). Both resolve to the KV prefix `user:<id>:p:`. Recovery is
the `EMERGENCY_RESET_TOKEN` Worker-var backdoor (no email service). See
`AUTH_PLAN.md`.

Who talks to the cloud, and when:

- **Web app** — keeps its auto-save UX. `initCloudSync()` runs a per-name,
  newest-wins reconcile on load, then subscribes to store changes and pushes
  CHANGED entries (debounced 1.5s / maxWait 4s) under their names; local
  deletes/renames propagate the same way. A small persisted map
  (`stpe:cloud:pushed`, name → last pushed/adopted state) tells "new local
  preset → upload" apart from "deleted in the cloud → remove locally, never
  resurrect". The toolbar dot is an explicit **Refresh from cloud**.
- **VS Code file editor** (Interface A) — NO cloud engine at all. Edits mirror
  to the file on disk. The toolbar's explicit **Send to cloud** uploads the open
  file under its FILE name (`sendActivePresetToCloud`, `?snapshot=1`). There is
  deliberately no load-from-cloud in this interface.
- **VS Code cloud browser** (Interface B, `stpe.openEditor`) — mirrors the cloud
  list into `savedPresets` on init/refresh (adopt-only; local unsent edits are
  never clobbered, and never auto-pushed). Explicit actions map to cloud calls:
  Preset Manager delete/rename → `cloudLibraryHooks` (registered by cloudSync in
  library mode; see `src/stores/cloudHooks.js`) → host `cloudDelete`/`cloudRename`;
  **Send to cloud** uploads the open preset; the normal **Save** button routes to
  `saveActiveToWorkspace` — the host shows a workspace-folder QuickPick and
  OVERWRITES a same-named file (name = identity, never a "(2)" copy).

File responsibilities:

- **`src/stores/cloudSync.js`** — the client: transports (web `fetch` vs host
  bridge), the pushed-map bookkeeping, `initCloudSync()` / `refreshCloudLibrary()`
  / `sendActivePresetToCloud()` / `reconnectCloudSync()` (clears the pushed map on
  credential changes). Store side: `adoptCloudEntry` (upsert by name, keeps local
  id links) and `removeLibraryEntryByName` live in `presetStore.js`.
- **`src/stores/cloudHooks.js`** — tiny registry so `presetStore` actions
  (deletePreset / updatePreset / batch delete) can notify the cloud layer of
  EXPLICIT management actions without an import cycle. Only the cloud browser
  registers hooks; the web app's diff push covers these itself.
- **`src/stores/localBridge.js`** — the extension's host seam. (a) File: mirrors
  the OPEN preset to a local `.json` over the webview↔host postMessage bridge
  (`parseFromJson` in, `finalJson` out); the open file is linked to a stable
  LOCAL library entry (`openFileAsPreset`, id `file:<path>`) so autosave and
  snapshots work — that entry never reaches the cloud by itself. (b) Explicit
  cloud requests: connect/validate an API key (held in VS Code SecretStorage,
  never in the webview) and one-shot wrappers `hostCloudList/Load/Send/Delete/
Rename` + `saveActiveToWorkspace`. `isVsCodeHost()` / `getEditorMode()` select
  the runtime everywhere.
- **`src/stores/authStore.js`** — account/session state + API-key management over
  `/api/auth/*` and `/api/keys`. **`src/components/SyncSetup.vue`** — the shared
  sync panel (sign in / create account / recovery / generate-key), shown in
  `SettingsModal.vue`.
- **`src/stores/syncStore.js`** — cloud status only (`cloudEnabled`, `status`,
  `lastSyncedAt`, `pendingSync`). Kept separate from the data store so status
  updates never look like editable-data changes. Persists `lastSyncedAt`,
  `pendingSync`.
- **`worker/index.js` + `worker/auth.js`** — the Worker. `identify()` resolves a
  session cookie or `X-API-Key` → identity; no identity ⇒ **401, fail closed**.
  Routes: `GET /api/presets` (index from KV metadata), `GET/PUT/DELETE
/api/presets/:name`. `auth.js` is dependency-free (Web Crypto PBKDF2 + D1);
  passwords, sessions, and API keys are stored only as hashes. No secrets in the
  repo.
- **`extension/extension.js`** — the host: file read/write, the plain ST Presets
  tree (file ops + per-file "Send to cloud"), the webview panels (file / cloud
  browser), API-key storage, and the explicit cloud HTTP handlers. No watchers
  push to the cloud; nothing cloud-side happens without a user action.
- **`wrangler.jsonc`** — Worker config. KV `PRESETS` has **no id** (auto-provisioned
  per deployer). D1 binding `DB` holds accounts; forkers run `wrangler d1 create`
  - `migrations apply`. Optional Worker vars: `OWNER_EMAIL`, `EMERGENCY_RESET_TOKEN`.

Wire format per preset: `{ name, updatedAt, data, snapshots }`, where `data` is
one library entry's `.data` (`rawJson`, `originalFilename`, `prompts` sans
derived `macros`, `promptOrder`, `promptCollapseStates`) and `snapshots` matches
the local snapshot shape (`{ id, name, createdAt, data }`).

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
- Top toolbar (import/export/presets/settings buttons, mobile menu, **cloud
  status dot / refresh**, **Send to cloud** + Save routing per editor mode) →
  `src/components/AppToolbar.vue`

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
- Cloud client (adopt/refresh/send/delete by name, pushed-map) → `src/stores/cloudSync.js`
- Explicit-action hooks between store and cloud layer → `src/stores/cloudHooks.js`
- Cloud status (`cloudEnabled`/`status`/`lastSyncedAt`/`pendingSync`) → `src/stores/syncStore.js`
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
