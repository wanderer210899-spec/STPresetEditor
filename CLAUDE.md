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
- Pinia + `pinia-plugin-persistedstate` (state + localStorage)
- Vite 7 (build), Tailwind CSS v4 (`@tailwindcss/vite`)
- Headless UI + Heroicons (accessible dialogs/menus/tabs/icons)
- Splitpanes (desktop 3-pane), vuedraggable (drag-reorder), floating-vue
  (tooltips), lodash-es (debounce)
- Cloudflare Workers + KV + Wrangler (deploy)

## Architecture: one store, derive everything

The single source of truth is the Pinia **preset** store
(`src/stores/presetStore.js`). Components dispatch actions → state changes →
getters/computed re-render. Components hold almost no business logic.

- **Persisted to localStorage** = portable data only (the `persist.paths` list):
  `rawJson`, `originalFilename`, `prompts`, `promptOrder`, `macroDisplayMode`,
  `currentLanguage`, `promptCollapseStates`, `skipDeleteConfirmation`,
  `savedPresets`, `currentPresetId`, `defaultPresetId`.
- **Derived / NOT persisted:** macro analysis (`variables`,
  `unresolvedVariables`, `macroStateSnapshots`), selection, search, modal flags,
  mobile flags. Recomputed after a restore by `analyzeAllMacros()`.
- That **same path list is also exported as `SYNC_DATA_PATHS`** and is exactly
  what gets synced to the cloud. **When you add a persisted field, update BOTH
  `persist.paths` and `SYNC_DATA_PATHS`** (both live in `presetStore.js`).

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
                                         └─ Cloudflare KV (PRESETS namespace)
```

- **`src/stores/cloudSync.js`** — orchestration. `initCloudSync()` reconciles
  once (seed an empty cloud, adopt a newer cloud copy, or flush pending local
  edits), then subscribes to store changes and pushes (debounced ~1.5s).
  `reconnectCloudSync()` re-runs after the passphrase changes. Last-write-wins,
  with `pendingSync` guarding un-pushed local edits. Any failure ⇒ local-only.
- **`src/stores/syncStore.js`** — sync status only (`cloudEnabled`, `status`,
  `lastSyncedAt`, `pendingSync`, `syncKey`). Kept separate from the data store so
  status updates never look like editable-data changes (which would loop).
  Persists `lastSyncedAt`, `pendingSync`, `syncKey`.
- **`worker/index.js`** — the Worker. Serves the SPA and the `/api/presets` API.
  Identity is resolved from **Cloudflare Access**
  (`Cf-Access-Authenticated-User-Email` → KV key `user:<email>`) **OR a passphrase**
  (`X-Sync-Key` constant-time-compared to the `SYNC_PASSWORD` secret → KV key
  `shared`). No identity ⇒ **401, fail closed**. No secrets in the repo.
- **`wrangler.jsonc`** — Worker config. The KV namespace `PRESETS` has **no id**,
  so Cloudflare auto-provisions a fresh one per deployer. `SYNC_PASSWORD` is set
  out-of-band as a Worker secret, never committed.

Wire format between store and Worker: `{ updatedAt, data }`, where `data` is a
`SYNC_DATA_PATHS` snapshot produced by `buildSyncSnapshot()` and applied by
`applyCloudData()` (both in `presetStore.js`).

## Macro system (the core editor feature)

`analyzeAllMacros()` in `presetStore.js` is the engine. Guiding rule: **only
prompts currently in `promptOrder` are analysed** (hidden prompts are ignored).
Passes:

1. Clear stale `prompt.macros`.
2. Parse `{{...}}` in each ordered prompt into a `MacroData`
   (`{ id, full, type, varName, value, params }`); `id = \`${promptId}-${matchIndex}\``.
3. Walk the flattened execution flow: build definition/reference maps (static
   analysis) **and** simulate values — a `setvar` only mutates the simulated
   state when its prompt is `enabled`.
4. Aggregate into `variables`, `unresolvedVariables` (referenced-but-undefined),
   and `macroStateSnapshots` (each getvar's value at its execution point).

Runs on every structural edit; debounced (300ms) for content typing via
`analyzeAllMacrosDebounced`. Two display modes via `macroDisplayMode`: `raw`
(highlighted source) and `preview` (getvar → value; setvar/comments hidden).

## File routing — "to change X, edit Y"

**Entry / shell**

- App bootstrap + cloud-first load order → `src/main.js`
- Root component, mounts global modals → `src/App.vue`
- Desktop 3-pane vs mobile drawers, mobile breakpoint → `src/components/AppLayout.vue`
- Top toolbar (import/export/presets/settings buttons, mobile menu, **sync status
  dot**) → `src/components/AppToolbar.vue`

**State / logic (most business changes go here)**

- All preset data, prompt CRUD, ordering, macro analysis, saved presets,
  batch-replace, i18n `t()`, persistence → `src/stores/presetStore.js`
- Cloud-sync behaviour → `src/stores/cloudSync.js`
- Sync status + passphrase state → `src/stores/syncStore.js`
- Worker API / auth / KV access → `worker/index.js`
- Worker config + bindings → `wrangler.jsonc`

**Left pane — prompt library**

- Library list, search, multi-select, add-to-editor → `src/components/LeftSidebar/PromptLibrary.vue`
- A single library row → `src/components/LeftSidebar/PromptLibraryItem.vue`

**Middle pane — editor**

- Ordered draggable list, editor search, batch toolbar → `src/components/MainEditor/EditorView.vue`
- A single prompt card (role select, enable switch, menu, renders content) → `src/components/MainEditor/PromptCard.vue`
- Rendering one macro (raw vs preview, highlight, click-to-find) → `src/components/MainEditor/MacroRenderer.vue`
- Batch find/replace + prefix/suffix/serial UI (calls `batchReplaceText`) → `src/components/MainEditor/BatchReplaceModal.vue`

**Right pane — details / variables**

- Tab shell (Details ⇄ Variables) + batch-replace overlay → `src/components/RightSidebar/RightSidebar.vue`
- Routes to prompt-details or macro-details by selection → `src/components/RightSidebar/DetailsView.vue`
- Edit the selected prompt's fields → `src/components/RightSidebar/PromptDetails.vue`
- A variable's definition/reference lists → `src/components/RightSidebar/MacroDetails.vue`
- Variables tab: list, status icons, safe rename → `src/components/RightSidebar/VariableManager.vue`

**Modals**

- Import JSON → `src/components/JsonImportModal.vue`
- Export JSON → `src/components/JsonExportModal.vue`
- Settings (language, **cloud-sync passphrase**, delete-confirm, factory reset,
  build stamp) → `src/components/SettingsModal.vue`
- Saved-preset manager (search/sort/multi-select CRUD) → `src/components/PresetManagerModal.vue`
- Reusable dialog shell bound to `isDetailsModalOpen` → `src/components/DetailsModal.vue`

**Assets / config**

- Default/example preset → `src/assets/example.json`
- UI strings (en/zh), consumed by the `t()` getter → `src/assets/languages.json`
- Global styles → `src/style.css`
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

Cloud-sync setup (passphrase or Cloudflare Access) and one-click deploy are
documented in **README.md → Private cloud sync (Cloudflare)**.
