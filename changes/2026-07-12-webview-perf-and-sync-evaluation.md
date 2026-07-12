# Evaluation — webview performance & sync (VS Code extension)

**Date:** 2026-07-12
**Mode:** spec-communication → evaluation/audit (feeds future change requests; **no code changed**)
**Scope of request:** (1) confirm whether Tailwind + other libraries helped smoothness in the
original pre-fork branch; (2) evaluate shortcomings of the current approach for performance and
syncing (user observed sync still needs a document switch + reload instead of workspace memory);
(3) output candidate QoL / large-library / performance / sync improvements.

**Evidence base:** git history (`package.json` `-S` traces, fork-boundary commits), `CLAUDE.md`
architecture, `bugs/2026-07-11-extension-typing-lag.md`, `changes/2026-07-10-audit-findings.md`,
`extension/extension.js`, `src/stores/localBridge.js`, `extension/presetFolder.js`,
`src/utils/persistStorage.js`. No live profiling was re-run this session — numbers cited are the
team's own from the typing-lag bug doc.

---

## Q1 — Did Tailwind / libraries help smoothness in the original (pre-fork) branch?

**Finding: the libraries are the *original upstream author's foundation, not fork additions* — so
they are not the source of any post-fork regression.**

Git evidence (`git log -S … -- package.json`):

| Library | First appears in | Meaning |
|---|---|---|
| `tailwindcss` | `7097e11 feat: Basic edition` (2025-07-25, **first commit**) | original |
| `@headlessui/vue` | `25a2949 feat: Add UI` (original era) | original |
| `floating-vue` | `9eac781 feat: Add tooltips` (original era) | original |
| Cloudflare sync / worker | `61b8164 feat: add private Cloudflare cloud sync` (the **fork**) | fork addition |

Interpretation:

- **Tailwind v4 (`@tailwindcss/vite`) is build-time only.** It compiles to a static CSS file; it
  ships **zero runtime JS** and is **not on the typing hot path**. It did not help *or* hurt
  runtime smoothness — it is neutral at runtime and a net positive for authoring/maintenance.
- **Headless UI and floating-vue are runtime libraries but off the hot path** — Headless UI runs
  only while a dialog/menu is open; floating-vue only while a tooltip is shown. Neither runs
  per-keystroke, so neither is implicated in the editor's typing lag.
- **The smoothness problems came from the fork's own state/sync machinery, not the libraries.**
  The typing lag (bug doc) traces to fork-introduced deep store watchers, per-keystroke
  serialization of the persisted subset, and a host↔webview reconcile race — all added by the
  cloud-sync + extension work, and largely fixed in **0.8.1**.

**Bottom line:** keep Tailwind and the UI libraries. They were the original smooth baseline; they
are not the regression. The regression was in the fork's persistence/sync layer.

---

## Q2 — Does sync really require a document switch + reload instead of workspace memory?

**Finding: confirmed. There is no VS Code workspace memory. Working state lives only in (a) the
`.json` files on disk and (b) the webview's own browser `localStorage` (Pinia persist).**

Mechanism (`extension/extension.js`, `src/stores/localBridge.js`):

- Webview panels are **keyed by file path** (`panels` Map). Opening a *different* preset spawns a
  **new** panel that **cold-loads and re-parses the JSON from disk** (`ready` → `sendLoad` →
  `applyLoad`, `localBridge.js` `parseFromJson`).
- `retainContextWhenHidden: true` keeps an *already-open* hidden panel alive (switching back just
  reveals it), but a freshly opened/re-opened file always reloads from disk.
- **No `context.workspaceState` / `globalState` / `Memento` is used anywhere.** The extension keeps
  no in-memory or workspace-scoped cache of the working set. To pick up externally/cloud-synced
  changes the user must force a reload (switch/reopen the document), which re-parses everything.

**Why this is the wrong seam:** the source of truth for the *working editing session* is scattered
across disk + webview localStorage, with the VS Code host acting only as a file courier. There is
no host-side "current working library" a panel can rehydrate from instantly, so continuity across
document switches and reloads costs a full disk parse each time.

**Code locations that would change to fix it** (from coworker trace):

- `extension.js` — `openPanel()`, `handleMessage` (add `saveState`), `handleSave`, `sendLoad`
  (check `workspaceState` before disk read).
- `localBridge.js` — `applyLoad()` / `initLocalBridge()` (push current store state back to host;
  handle a new `restoreState` message that hydrates the store directly, bypassing disk read).

---

## Performance — what's fixed vs. what remains

### Fixed in 0.8.1 (`4bdc0f3`) — do not re-litigate
- **F1** auto-grow no longer forces reflow (CSS `field-sizing: content` + single-rAF fallback).
- **F2** persist migrated to persistedstate **v4** `pick`/`afterHydrate` (57 keys → intended
  subset) + debounced localStorage adapter (`persistStorage.js`, ~400 ms, flush on hide/unload).
- **F4** `savedPresets[*].data` is `markRaw`'d → the library is skipped by deep-watcher traversal
  and Vue reactivity. Measured: typing cost stopped scaling with library size (~20 ms @0.6 MB,
  ~22 ms @2.5 MB); p50 ~90 ms → ~20 ms.
- **F6** host skips reconcile on self-saves (kills the 409/`resolveDivergence` re-render storm).

### Remaining performance shortcomings (candidates)
- **P1 — Post-pause macro re-analysis hitch (~300 ms).** `analyzeAllMacrosDebounced` clears and
  reattaches `macros` on **every** prompt → list-wide PromptCard invalidation. Scales with prompt
  count. (Deferred **F5**: *incremental* analysis — re-tokenize only the edited prompt, rebuild
  aggregates, don't touch other prompts' `macros`.)
- **P2 — `_touchActivePreset` double `JSON.stringify` (~1000 ms post-pause).** Full compare of the
  active area + a large persisted-entry write, triggering the full watcher cascade.
- **P3 — Three separate deep `$subscribe` watchers** (persist, cloudSync, localBridge) not merged.
  (Deferred **F3**: single fan-out subscription; revisit cloudSync's `flush:'sync'` guard.)
- **P4 — Per-keystroke serialization likely still runs.** The debounced adapter only coalesces the
  *write*; the persist plugin still calls `JSON.stringify(pick(state))` **before** `setItem` on
  each mutation. `markRaw` keeps the library out of Vue's *traverse*, but **not** out of
  `JSON.stringify`. Worth measuring: a large library may still cost a full stringify per keystroke.
- **P5 — The open file exists twice in state** (active area *and* its linked `savedPresets` entry in
  host mode), so every O(state) cost is paid double for the open document.
- **P6 — `httpRequest` hand-roll** in `extension.js` instead of Node ≥18 global `fetch`
  (audit B7 — cleanup, minor).

---

## Large-library handling — what scales badly & options

Current mitigations: `markRaw` library data (non-reactive), and only prompts in `promptOrder` are
analysed. What still scales badly: `analyzeAllMacros` rebuilds `macros` on all prompts (O(prompt
count)); the whole library is one `localStorage` blob (synchronous stringify + ~5–10 MB ceiling);
open-file duplication (P5).

Options (ordered by leverage):
- **L1 — Move library persistence off the synchronous-stringify path.** A keyed store (IndexedDB via
  `idb-keyval`) removes the per-mutation full-blob stringify **and** the localStorage size ceiling;
  entries load/save independently. Biggest structural win for large libraries.
- **L2 — Virtualize the prompt list** (render only visible `PromptCard`s). Caps list-wide
  re-render/DOM cost so it stops scaling with prompt count. Pairs well with P1/F5.
- **L3 — Incremental macro analysis** (= F5). Removes the O(prompt count) re-analysis hitch.
- **L4 — Lazy-hydrate library `.data`.** Entries are already opaque/`markRaw`; only hydrate a
  preset's full data when it is actually opened.

---

## Sync improvements (working-memory direction)

> **Scope clarified by the user (2026-07-12):** "workspace memory" here means **only the
> currently-open preset and its versioning** — *not* anything tied to VS Code's own workspace
> (folders, multi-root, `.code-workspace`). The working memory is the open preset + its snapshot
> lineage, and it should persist/rehydrate independently of which VS Code workspace is active.
> Prefer `globalState` (or an in-editor persistent store) keyed by preset identity over
> `workspaceState`, so it isn't scoped to a VS Code folder.

- **S1 — Persist the open preset + its version lineage as working memory.** Keep the currently-open
  preset and its `snapshots` as the authoritative working set; a new/reopened panel rehydrates from
  it instantly (`sendLoad` checks working memory before a disk parse), eliminating the cold re-parse
  on every document switch. Store it by **preset identity/lineage**, not by VS Code workspace.
- **S2 — Live-apply synced changes without a document switch.** When the host learns of a
  cloud/file change to the open preset, push a `restoreState` message into the webview (hydrate the
  store directly) instead of requiring the user to switch/reopen to force a reload.
- **S3 — One identity model for the open preset & its versions.** Unify the two save paths
  (`openFileAsPreset` file/library flow vs `importPresetWithDuplicateCheck`) onto a single
  preset-identity + versioning model so a same-name re-save becomes a **snapshot in the open
  preset's lineage**, not a duplicate-named entry. **Directly connected to the bug**
  [bugs/2026-07-12-same-name-saved-as-duplicate-entries-not-snapshots.md](../bugs/2026-07-12-same-name-saved-as-duplicate-entries-not-snapshots.md).
  (Design decision — must NOT silently merge two genuinely different presets that share a name;
  scope "same name ⇒ snapshot" to the currently-open lineage. Log in `.agent/decisions` if kept.)

---

## QoL candidates (smaller, user-facing)
- Q-a — Visible "reloaded from disk / applied cloud update" toast so a silent reparse isn't
  mistaken for lag or data loss.
- Q-b — Preserve scroll position + selection + expanded/collapsed state across a reload (today a
  reload can reset editor position).
- Q-c — Explicit "Reload from disk" / "Sync now" action so the user isn't forced to switch
  documents to trigger a refresh.
- Q-d — Cleanup: consolidate duplicate deep-clone helpers (`toPlain`/`toPlainClone`/inline
  stringify-equality) into one util (audit B8); `httpRequest` → `fetch` (P6/B7).

---

## Guardrails / must-not-touch (for any follow-on implementation)
- **Do NOT remove Tailwind or the UI libraries** — they are the original smooth baseline, not the
  regression.
- **Do NOT re-open the 0.8.1 fixes** (F1/F2/F4/F6). Build on them.
- Preserve the persistedstate **v4** `pick` config and the `markRaw` library invariant
  (`CLAUDE.md` Architecture) at every new `savedPresets[*].data = …` site.
- Keep `PERSIST_PATHS` / `SYNC_DATA_PATHS` / `EXTENSION_LIBRARY_PATHS` in sync when touching
  persisted fields.
- Preserve the merge-first sync engine and the UTF-8-chunk regression test if `extension.js`
  transport is touched.
- `sillytavern-extensions/` is protected — this evaluation is read-only; implementation is a
  separate, explicitly-approved step.

---

## Proposed priority (for turning into change requests)
1. **S1 + S2** (workspace-memory working set + live-apply) — directly fixes the user's reported
   sync pain.
2. **P1/L3 (F5 incremental analysis)** — kills the biggest remaining post-pause hitch.
3. **L1 (IndexedDB library store)** + **P4 verification** — structural large-library win.
4. **L2 (virtualized list)** — for very large presets.
5. **P3 (F3 merged watcher)**, **P5**, QoL (Q-a…Q-d), cleanup (P6/B7, B8) — polish.

---

## Implementation status — 2026-07-12

**Done + unit-tested (in this branch, 99/99 green, lint clean):**
- **Step 1a — same-name bug** → `openFileAsPreset` dedupes new-entry display names
  (`bugs/2026-07-12-…-not-snapshots.md`). Tests: `presetStore.test.js` "openFileAsPreset same-name".
- **F5 — incremental macro analysis.** Content typing now re-tokenizes only the edited prompt(s)
  via `queueIncrementalMacroAnalysis` → `_flushIncrementalMacros`, rebuilding aggregates through the
  extracted `_rebuildMacroAggregates`; unchanged prompts' `.macros` references are preserved (no
  list-wide PromptCard re-render). Structural edits still use the full `analyzeAllMacros`. Tests:
  `presetStore.test.js` "F5 incremental macro analysis" (reference-stability, multi-prompt window,
  cross-prompt aggregate rebuild, first-pass fallback, incremental≡full).
- **S2 — forced pull (`syncNow`).** `pollCloudNow({force})` + exported `syncNow()` bypass the
  hidden-tab guard so a user can pull remote changes into the OPEN editor without switching the
  document (auto-pull already existed but the VS Code webview reports hidden/unfocused unreliably).
  Test: `reproSaveSync.test.js` "F. syncNow() forces a pull even when the tab reports hidden".
- **S1 — confirmed already satisfied.** The open preset (`currentPresetId`) + its versioning
  (`savedPresets[*].snapshots`) already persist via the webview's own storage (`PERSIST_PATHS`),
  independent of VS Code's workspace — exactly the requested scope. No change needed; do NOT add
  `workspaceState`.
- **P4 — VERIFIED (confirmed real).** `pinia-plugin-persistedstate` subscribes to every mutation and
  runs `serializer.serialize` (default `JSON.stringify`) BEFORE the debounced `setItem`
  (`node_modules/pinia-plugin-persistedstate/dist/index.js:44-45,75-76`). Since `savedPresets` is in
  `PERSIST_PATHS`, the whole library is stringified per keystroke; the debounced storage defers only
  the write, and `markRaw` speeds the walk but not the stringify. So a large library still pays an
  O(size) stringify per keystroke.

**Deferred — need a dependency, data-migration safety, or browser/visual validation I can't do
headless (NOT shipped, to avoid unvalidated risk):**
- **L1 — IndexedDB library store.** Requires a new dep (`idb-keyval`) + `fake-indexeddb` for tests +
  an async-hydration rewrite + a localStorage→IndexedDB migration of live user libraries. The safe
  P4 fix (IndexedDB, or change-detected split persistence) needs profiling to prove the win and
  confirm no stale-persist data loss. Do this as its own change with dependency approval.
- **QoL — "Sync now" button + toast — DONE 2026-07-12.** Both AppToolbar sync dots are now
  click-to-`syncNow()` (en+zh label/tooltip + result toast). Live-validated on the local worker: a
  real click on a hidden client forced a pull the auto-sync would have skipped and updated the open
  editor; "already up to date" on a no-op click; 0 console errors. See
  [changes/2026-07-12-live-validation.md](./2026-07-12-live-validation.md).
- **QoL — list virtualization, preserve scroll+selection across reload.** UI-layer; need browser
  validation.
- **Cleanup (B8 clone-helper dedupe, P6 `httpRequest`→`fetch`).** Low value; kept out of this commit
  to keep the diff focused.

*Each deferred item remains a discrete follow-up under its own acceptance check.*
