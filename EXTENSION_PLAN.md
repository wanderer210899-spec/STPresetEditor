# STPresetEditor → Cursor/VSCode Extension — Implementation Plan

Goal: edit SillyTavern presets **directly from local files** (like the
`Simamiemie` extension) using **STPresetEditor's feature-rich UI** (this fork),
all inside Cursor/VSCode, and **auto-notify SillyTavern to reload** after a save.

Milestones below are the build order. **Status: M0 + M1 + M2c are implemented and
verified** — open a `.json` preset in a Cursor webview, edit in the full UI,
autosave back to the file, and — once you opt in by setting **your own** Worker
URL + passphrase — mirror the current preset to your Cloudflare deployment for the
PC↔cloud↔mobile loop. The cloud HTTP runs host-side (Node), so there's **no worker
change and no CORS** to set up. Cloud is **off by default with no built-in
endpoint** (the extension contacts no server until configured), so the build is
safe to distribute. M2 (preset sidebar) and M3 (live SillyTavern reload) are pending.

---

## 1. Chosen direction (from the direction Q&A)

| Decision             | Choice                                                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Delivery shape       | **Cursor/VSCode extension** — webview hosting the existing Vue SPA                                                                                           |
| This session         | **Implementation plan** (this document)                                                                                                                      |
| ST integration depth | **Auto-notify SillyTavern** to reload the preset after save                                                                                                  |
| SillyTavern location | **Same computer** as the editor — extension writes the preset file directly; no network bridge needed                                                        |
| Cloud sync           | **Keep both** — Cloudflare sync (cross-device library) and the extension (local files) coexist; one UI, the data provider is chosen automatically at startup |

Why a cloud-hosted web app can't do this on its own (the question that drove the
shape): a Cloudflare worker runs on a server in a data center, not on your
machine, so it can never reach your local SillyTavern files. A normal browser tab
is sandboxed away from your disk too (the one narrow exception, the File System
Access API, is Chromium-only, re-prompts every session, can't watch files, and
can't run in the IDE). Only a program running **locally with file permission** —
the extension's Node.js "extension host" — can read/write the preset folder and
sit inside Cursor next to the logs. The cloud deployment stays useful for a
different job: syncing your library across devices.

## 2. Core idea: a third runtime shape from one codebase

The README already frames STPresetEditor as _"two runtime shapes from the same
code"_ (static SPA on `localStorage`; Cloudflare Worker with cloud sync). This
adds a **third shape** without forking the UI:

```
Shape 1  Static SPA      → data in browser localStorage
Shape 2  Cloudflare      → data in Cloudflare KV via /api/presets   (cloudSync.js)
Shape 3  Cursor extension → data in local FILES via postMessage      (localBridge.js)  ← NEW
```

The Vue `src/` stays the single UI for all three. The only new front-end code is
one provider module (`localBridge.js`) that mirrors `cloudSync.js` but talks to
the extension host over `postMessage` instead of HTTP.

### Why this is low-risk: the seams already exist

The store is already built for an external data provider. We reuse, not rewrite:

| Need                                                                                          | Existing seam             | File:line                       |
| --------------------------------------------------------------------------------------------- | ------------------------- | ------------------------------- |
| Load a preset from a file's JSON text                                                         | `parseFromJson(str)`      | `src/stores/presetStore.js:462` |
| Produce save-ready JSON (preserves the rest of the file, only rewrites char `100001`'s order) | `finalJson` getter        | `src/stores/presetStore.js:257` |
| Pull-on-load + debounced-push-on-change + echo-guard + fail-soft                              | `cloudSync.js` (template) | `src/stores/cloudSync.js`       |
| Status/flags kept out of the data store so they don't loop                                    | `syncStore.js` (template) | `src/stores/syncStore.js`       |
| Re-run analysis after external data change                                                    | `analyzeAllMacros()`      | `src/stores/presetStore.js`     |
| Same target convention as ST + the old extension                                              | `character_id: 100001`    | both codebases                  |

**Important precision:** host mode uses **`parseFromJson` / `finalJson`** (a
single preset file in, a single preset file out). It does **not** use
`buildSyncSnapshot` / `applyCloudData` — those serialize the _whole library_
(savedPresets, prefs, …) and are specific to cloud sync. We borrow `cloudSync.js`
only as the _orchestration_ template (pull/push/debounce/suppress), not its data
shape.

---

## 3. Architecture

```
Cursor / VSCode window
┌──────────────────────────────────────────────────────────────────┐
│  Extension Host (Node, TypeScript)         extension/src/extension.ts │
│   • reads/writes  data/<handle>/OpenAI Settings/*.json  (fs, atomic)  │
│   • FileSystemWatcher on that folder (external-change detection)      │
│   • Tree view "Preset Library" (one row per .json file)              │
│   • commands: open / pick-folder / reload-in-ST / edit-prompt-in-tab │
│   • WebSocket server on 127.0.0.1:<port>  ── notify ST to reload ──┐  │
│        ▲   postMessage bridge   │                                  │  │
│        │  (load / save / …)     ▼                                  │  │
│  ┌─────┴───────────────────────────────────┐                      │  │
│  │ Webview Panel                            │                      │  │
│  │   built Vue SPA (extension/media/)       │                      │  │
│  │   src/stores/localBridge.js  ◄── NEW     │                      │  │
│  │   (detects acquireVsCodeApi → host mode) │                      │  │
│  └──────────────────────────────────────────┘                     │  │
└───────────────────────────────────────────────────────────────────┼──┘
                                                                     │
   SillyTavern (browser UI, separate app)                            │
   ┌──────────────────────────────────────────────┐                 │
   │ companion UI extension "STPE Bridge" (small)  │ ◄── ws ─────────┘
   │   on message → getContext().executeSlash...   │
   │                '/preset <name>'  → selectPreset() reloads file  │
   └──────────────────────────────────────────────┘
```

### 3a. Webview build pipeline (the fiddliest part)

VSCode webviews can't load `/assets/...` absolute URLs or arbitrary remote
scripts; resources must go through `webview.asWebviewUri()` and pass a CSP.

Plan:

- Add **`vite.config.webview.js`** (or a `--mode webview` branch in the existing
  config) that builds the SPA with **`base: './'`** into **`extension/media/`**.
  Relative asset paths are the key change vs. the web build.
- At panel-open the host reads `media/index.html`, rewrites every `href`/`src`
  through `panel.webview.asWebviewUri(...)`, injects a **strict CSP `<meta>`**
  with a per-load **nonce** on the script tag, and assigns `panel.webview.html`.
- Set `localResourceRoots: [media]`, `enableScripts: true`, and
  `retainContextWhenHidden: true` (so the SPA keeps state when the tab is hidden;
  the old extension already relies on this).
- Tailwind v4 / Vite output works unchanged once paths + CSP are handled.

This is a well-trodden pattern; calling it out because it's the most likely place
to lose an afternoon.

### 3b. Front-end provider: `src/stores/localBridge.js`

Mirrors `cloudSync.js`. Responsibilities:

1. Detect host mode: `const inHost = typeof acquireVsCodeApi === 'function'`.
   Cache the API once (`acquireVsCodeApi()` throws if called twice).
2. On startup: post `{ type: 'ready' }`. Host replies with the file list and the
   active file's contents.
3. Inbound `host → webview`:
   - `load { path, name, json }` → `store.parseFromJson(json)`; remember
     `activeFilePath`. (`parseFromJson` already calls `analyzeAllMacros`.)
   - `fileList { files }` → populate the library tree mirror (for in-app UI).
   - `externalChange { path }` → file changed on disk outside us; prompt to
     reload (guarded so it ignores our own writes).
4. Outbound `webview → host` (debounced ~1s, same idea as `PUSH_DEBOUNCE_MS`):
   - `save { path, json: store.finalJson }` on any data change.
   - `openFile { path }` when the user clicks a different preset in the library.
   - `editPromptExternally { promptId, name, content }` (see 3f).
5. Echo-guard: a `suppressSave` flag while applying an inbound `load`, mirroring
   `cloudSync.js`'s `suppressPush`, so loading a file doesn't immediately push it
   back.

A small **`hostStore.js`** (analogous to `syncStore.js`) holds host-only state
(`activeFilePath`, `fileList`, `hostConnected`, `stBridgeConnected`) so it never
looks like editable preset data and never triggers a save loop.

**Provider selection** in `src/main.js` `bootstrap()`:

```
if (inHost) { await initLocalBridge(); await initCloudSync(); }  // BOTH: files + cloud
else        { await initCloudSync(); }                           // web/mobile: cloud only
```

In the extension **both providers run together** (the confirmed workflow wants
local _and_ cloud on PC). They don't fight because the in-memory Pinia store is
the single source of truth and each provider is just a mirror of it:

- **Local file = authoritative on open.** Opening a preset loads it into the
  store; cloud is then a _downstream mirror_ (pushed to match).
- Cloud's "adopt a newer copy" behavior is suppressed in host mode, so opening a
  file never gets clobbered by an older cloud snapshot.
- The existing `suppressPush` / `pendingSync` echo-guards prevent ping-pong.

### 3b.1 The full device loop (reusing the EXISTING Cloudflare deployment)

Confirmed target workflow:

- **PC (extension):** edit → autosave writes the preset file to ST's folder
  **and** mirrors to Cloudflare → ST reloads (3e) → test, with logs in the IDE.
- **Mobile (web):** the _existing_ deployed web app, unchanged — pull library
  from Cloudflare, edit, push back. **Mobile never touches SillyTavern**, so there
  is no manual import/export hop; ST testing happens on PC only.

Because the _currently-open preset_ is already part of the cloud snapshot, the PC
and mobile editors show the same preset automatically — the loop is fully
automatic end-to-end, no file copying anywhere.

**No new deployment.** Same worker, same KV, same data, same URL. Two small
changes let the extension reach the cloud it already has:

1. **Configurable cloud URL.** `cloudSync.js` currently uses the _relative_
   `'/api/presets'` (resolves to the app's own origin). On the website that's the
   Cloudflare domain; inside the extension the origin is local, so add a Settings
   field for the absolute base URL → `<cloudOrigin>/api/presets`. The webview CSP
   must also list that origin under `connect-src`.
2. **CORS on the worker.** "CORS" = the browser rule that a page may only call a
   server at a _different_ origin if that server opts in. The web app and worker
   are same-origin today, so this never came up; the extension is a different
   origin, so `worker/index.js` needs a few lines: answer the preflight `OPTIONS`
   and return `Access-Control-Allow-Origin` + `Access-Control-Allow-Headers:
X-Sync-Key`. The **passphrase stays the real security gate.**

Auth from the extension uses **passphrase mode** (`X-Sync-Key`, already
supported) — it's a plain header that works cross-origin. Cloudflare Access mode
relies on browser SSO cookies and is awkward from a webview, so passphrase is the
recommended path there.

### 3c. Extension host (`extension/`, TypeScript)

A fresh, small extension (we keep the _plumbing_ ideas from the `Simamiemie`
extension and replace its vanilla UI with our webview). Responsibilities:

- **Activation:** `onCommand` + `onView:stpeLibrary`. Keep the `.json`
  right-click / `Cmd+Shift+P` entry points from the old extension.
- **Commands**
  - `stpe.open` — open/reveal the editor webview (optionally for the active file).
  - `stpe.pickLibraryFolder` — choose the preset root; **auto-detect** an
    `OpenAI Settings/` folder under the workspace (covers `data/<handle>/…`).
  - `stpe.reloadInST` — manually fire the ST reload (also automatic on save).
  - `stpe.editPromptInTab` — the "edit one prompt in a real editor tab" feature.
- **Tree view `stpeLibrary`** — one row per `*.json` in the folder (this is the
  big model difference vs. the old extension; see 3d). Click → `openFile`.
- **File I/O** — read on open; **atomic write** on save (write temp + rename, as
  ST itself does) to avoid truncating a preset on crash. Format with
  `JSON.stringify(obj, null, 4)` to match ST's on-disk style (cosmetic; any valid
  JSON works).
- **`FileSystemWatcher`** on the folder → `externalChange` messages, with an
  in-flight set of paths we just wrote (+ mtime check) to suppress our own echo.
- **WebSocket server** (`127.0.0.1`, configurable port) for ST notify (3e).
- **Build:** `esbuild` bundle `extension/src/extension.ts → extension/out/`.

### 3d. Data-model shift: library = the folder (not localStorage)

Today the editor holds **one** preset (`rawJson`) plus a `savedPresets` library
_inside localStorage_. The ST folder is **many** preset files. In host mode:

- The **file tree is the library.** `savedPresets`/preset-manager UI is hidden or
  repurposed in host mode (the files on disk replace it).
- Selecting a file = `parseFromJson(contents)` + set `activeFilePath`.
- Saving writes back to `activeFilePath` only. Import/export still work as manual
  escape hatches.
- "New preset" = create a new `*.json` in the folder.

This is the main UX decision to confirm during M2; everything else is mechanical.

### 3e. Auto-notify SillyTavern (grounded in verified ST behavior)

Facts verified from ST source (`src/endpoints/presets.js`,
`public/scripts/preset-manager.js`):

- ST stores chat-completion presets at `data/<handle>/OpenAI Settings/<name>.json`.
- **No file-watch / hot-reload exists in ST core.**
- ST server endpoints (`POST /api/presets/save|delete|restore`) require ST's own
  session/CSRF and, crucially, **don't refresh the browser UI** even if called.
- The real reload hook is the **`/preset <name>` slash command** →
  `presetManager.selectPreset()`, which re-reads the file into the live UI and
  reconnects. It must run **inside** ST.

Therefore, **staged** integration (each tier ships independently):

- **Tier 0 — works with zero ST changes (MVP).** We own the folder, so our write
  _is_ the install. User clicks the preset in ST once (or reloads) to pick it up.
  In-app hint shows the saved path.
- **Tier 1 — the "auto-notify" deliverable.** Ship a ~50-line companion **ST UI
  extension "STPE Bridge"** that opens a WebSocket to our host. On `save` the host
  broadcasts `{ preset: <name> }`; the bridge runs
  `getContext().executeSlashCommandsWithOptions('/preset ' + name)` →
  live reload + reconnect, no manual click. Optional HTTP long-poll fallback for
  users who don't want a WS dependency.
- **Tier 2 — optional round-trip.** When ST (or git) changes a file, our
  `FileSystemWatcher` offers to pull it back into the editor (conflict-aware).

Why a companion extension and not "just POST to ST": ST's API needs its session
and won't repaint the UI; writing the file (which we already do) + a UI-side
`/preset` reselect is less coupled and actually refreshes what the user sees.

### 3f. Keep the old extension's one genuinely nice trick

The `Simamiemie` extension lets you pop a prompt's **content into a real editor
tab** (temp `.md`), edit with full Cursor power, and syncs back on save
(`onDidSaveTextDocument`). It pairs perfectly with our **focus editor**
(`FocusEditorModal.vue`). Port it: webview posts `editPromptExternally`, host
opens the temp doc, watches save, posts the new content back → store updates the
prompt → autosave to the preset file.

---

## 4. Repository layout & scripts (single repo — recommended)

Keep one repo so the UI stays shared. Additions:

```
STPresetEditor/
├─ src/                         # unchanged Vue UI (shared by all 3 shapes)
│  ├─ stores/localBridge.js     # NEW — host provider (mirrors cloudSync.js)
│  ├─ stores/hostStore.js       # NEW — host-only state (mirrors syncStore.js)
│  └─ main.js                   # EDIT — pick provider by environment
├─ vite.config.webview.js       # NEW — base:'./', outDir: extension/media
├─ extension/                   # NEW — the Cursor/VSCode extension
│  ├─ package.json              #   contributes: commands, view, menus, keys
│  ├─ src/extension.ts          #   host: fs, tree, watcher, ws, webview
│  ├─ media/                    #   built SPA (from vite webview build)
│  └─ st-bridge/                #   companion ST UI extension (Tier 1)
└─ EXTENSION_PLAN.md            # this file
```

New npm scripts (root `package.json`):

- `build:webview` → `vite build --config vite.config.webview.js`
- `build:ext` → `build:webview` then `esbuild` the host
- `package:ext` → `vsce package` (produces a `.vsix` for Cursor **and** VSCode;
  Cursor installs `.vsix` directly, same as the current extension is delivered)

Single source of truth rule still applies: when adding a persisted field, update
**both** `persist.paths` and `SYNC_DATA_PATHS` (host mode doesn't change that).

---

## 5. Milestones (build order)

| #          | Outcome                                                                                                                                                                     | Proves                                                            |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **M0** ✅  | Webview build pipeline; the existing Vue UI renders inside a panel (no I/O)                                                                                                 | CSP + asset-path pattern works                                    |
| **M1** ✅  | `localBridge` + host fs: open a `.json` → loads into the UI; edits → saved back to the same file                                                                            | End-to-end parity with the old extension, but with your UI        |
| **M2**     | Library tree (`OpenAI Settings/*.json`), multi-file switching, watcher + echo-guard, atomic writes                                                                          | The many-files model (3d)                                         |
| **M2c** ✅ | Cloud sync in-extension: host-side Node HTTP (no worker change / no CORS), passphrase auth, safe read-merge-write push on edit, "Pull from cloud" command/status-bar button | The PC↔cloud↔mobile loop (3b.1); reuses the existing deployment |
| **M3**     | ST auto-notify: companion bridge + WebSocket; save → `/preset` reselect                                                                                                     | The chosen "auto-notify" deliverable                              |
| **M4**     | Polish: edit-prompt-in-tab (3f), settings (folder/port), `.vsix` packaging, README                                                                                          | Shippable                                                         |

M0+M1 already deliver "your UI, on local files, in Cursor." M3 adds the live ST
reload. Each milestone is independently demoable.

---

## 6. Risks & mitigations

1. **Webview CSP / Vite asset paths** (most likely time-sink) → dedicated
   `base:'./'` build + `asWebviewUri` rewrite + nonce CSP. Validate in M0.
2. **Save/echo loop** between our writes and the FileSystemWatcher → suppress
   events for just-written paths (in-flight set + mtime), mirroring
   `cloudSync.js`'s `suppressPush`.
3. **Two providers running together in the extension** (cloud + local, by design)
   → no fight because the Pinia store is the single source of truth and each
   provider only mirrors it; local file is authoritative on open, cloud is a
   downstream mirror, and the existing `suppressPush`/`pendingSync` guards stop
   echo loops. (Web/mobile still runs cloud only.)
4. **ST reload coupling** → keep Tier 0 fully functional without the companion
   extension; Tier 1 is additive.
5. **Cursor vs VSCode parity** → same extension API; distribute the `.vsix`
   directly (Cursor can't rely on the MS marketplace) — same delivery model the
   current extension already uses.
6. **Re-serialization** → `parseFromJson`→`finalJson` round-trips through
   `JSON.parse(rawJson)`, preserving unknown top-level keys (honors "never clobber
   the rest of the file"), but whitespace/key-order may change. ST doesn't care;
   note it for anyone diffing presets in git.
7. **User handle / folder location** → don't hard-code `default-user`; let the
   user pick, auto-detecting `OpenAI Settings/`.

---

## 7. Open questions to confirm before/while building

1. **Library UX (3d):** in host mode, fully replace the in-app saved-presets
   manager with the file tree, or keep both? (Recommend: file tree is the
   library; hide saved-presets in host mode.)
2. **ST notify transport:** WebSocket (instant, tiny dep) vs HTTP long-poll
   (no dep)? (Recommend: WebSocket, with poll as fallback.)
3. **Distribution:** private `.vsix` you sideload (like the current one), or
   publish to the Open VSX registry Cursor can search?
4. **Single-file vs folder open:** default to opening the whole `OpenAI Settings`
   folder as a library, while still supporting right-click on one `.json`?
   (Recommend: both, folder is primary.)

```

```
