<!-- Findings for changes/2026-07-10-dead-code-audit.md — REPORT ONLY, nothing removed. -->

# Audit findings: dead code & redundant library features (2026-07-10)

> **Resolution (2026-07-11):** user approved all findings; cleanup applied.
> Done: A1 (splitpanes removed + B4 paneSizes/setPaneSizes state removed,
> F7 boolean kept), A2 (resolved by dropping **@vueuse/core** instead of
> lodash-es — the RC5 sync fix needs lodash-debounce's battle-tested `maxWait`;
> AppLayout uses a plain matchMedia listener), A3 (autoprefixer + postcss
> removed), B1 (webview bundle rebuilt via `package:ext`), B2 (0.3.1 VSIX →
> `.ai/archive/STPresetEditor/`), B5 (`safeEqual`/`extractVarRefs` unexported),
> B6 (NUL byte → `'\0'` escape; extension.js greps as text again), B8
> (`src/utils/clone.js` consolidates toPlain/toPlainClone), C1+C2 (folded into
> the sync fix; see the sync bug report), D1–D5 (CLAUDE.md refreshed + stale
> code comments corrected). **Skipped:** B7 (httpRequest→fetch) — extension
> `engines.vscode ^1.74.0` predates guaranteed Node-18 `fetch` in the host, so
> the hand-rolled UTF-8-safe client stays. B3 (`isLibraryHost`) kept — API
> symmetry, test-covered.

Scope: `src/`, `extension/`, `worker/`, configs, `package.json`. Method:
dependency-import scan, coworker symbol inventory of the large files,
cross-file usage greps, git history, VSIX/bundle inspection, full test run
(89 tests: 88 pass, 1 fail — see the sync bug report for that failure).

**Nothing has been deleted.** Each item: evidence → suggested action.

## A. Unused / redundant dependencies

| # | Finding | Evidence | Suggested action |
|---|---------|----------|------------------|
| A1 | **`splitpanes` is dead** | Zero imports anywhere in `src/`; `AppLayout.vue:29` comment confirms splitters were replaced by collapsible columns. Store still carries `paneSizes`/`setPaneSizes`/`_paneSizesBackup`/`toggleRightPaneMaximize` persistence for it (see B4) | Remove from `package.json` deps |
| A2 | **`lodash-es` vs `@vueuse/core` overlap** | lodash-es used for exactly one function, `debounce` (6 import sites); @vueuse/core used for exactly one function, `useBreakpoints` (`AppLayout.vue:3`). Either dep could absorb the other's job (`useDebounceFn`, or a matchMedia listener) | Keep one; simplest: drop lodash-es, use `useDebounceFn` (or a ~10-line local debounce) |
| A3 | **`autoprefixer` + `postcss` devDeps likely residual** | Tailwind v4 via `@tailwindcss/vite` needs neither; no postcss config file exists in the repo | Remove both devDeps; verify `npm run build` after |
| A4 | **CLAUDE.md claims `vuedraggable`** (§Tech stack) | Not in `package.json`; no Sortable/vuedraggable import; reordering is native HTML5 DnD in `PromptCard.vue` | Doc fix (see D1) |

## B. Dead / residual first-party code

| # | Finding | Evidence | Suggested action |
|---|---------|----------|------------------|
| B1 | **Stale webview bundle in `extension/media/`** (build of 2026-06-18) while src/VSIX are 2026-07-04 | File mtimes; VSIX 0.7.1 contains a 07-04 bundle, so the on-disk media folder was overwritten/reverted afterwards. Anyone running the extension from source gets 3-week-old UI — a stale-deploy trap | Re-run `npm run build:webview`; consider a freshness check in `package:ext` |
| B2 | **`stpreseteditor-local-0.3.1.vsix`** superseded by 0.7.1 | Two VSIX files in `extension/` | Archive under `.ai/archive/` or delete (workspace prefers archiving) |
| B3 | **`isLibraryHost()` unused by app code** | `src/utils/host.js:35`; only `editorMode.test.js` references it | Keep if intended API symmetry, else inline/remove |
| B4 | **Splitpanes-era store state still persisted** | `paneSizes`, `_paneSizesBackup`, `setPaneSizes`, `isRightPaneMaximized`/`toggleRightPaneMaximize` (F7) — verify F7 still has UI after the collapsible-columns rework; `paneSizes` itself has no consumer if splitpanes is gone | Confirm F7 UI wiring; drop `paneSizes` persistence if truly orphaned |
| B5 | **Export-only-internal symbols** | `safeEqual` (worker/auth.js:26) and `extractVarRefs` (src/utils/macros.js:186) are exported but only used inside their own files | Drop the `export` keyword (keeps grep-truth honest) |
| B6 | **Literal NUL byte in `extension/extension.js:40`** (`LIBRARY_PANEL_KEY = '<NUL>library'`) | Intentional sentinel, but it makes every grep/ripgrep treat the file as **binary** (searches silently miss the whole host), and some tooling may mangle it | Write it as the escape `'\0library'` — identical runtime value, text-safe file |
| B7 | **Hand-rolled `httpRequest()` in extension.js:1006** | ~30 lines of http/https plumbing; VS Code's extension host (Node ≥18) has global `fetch` | Optional simplification when next touching the file (the UTF-8-chunk comment/fix should be preserved as a regression test either way) |
| B8 | **Duplicate deep-clone helpers** | `toPlain()` (localBridge.js:244) vs `toPlainClone()` (presetStore.js) — same JSON round-trip idiom; plus `eq()` JSON-equality in cloudSync.js duplicated as inline `JSON.stringify(a)===JSON.stringify(b)` in presetStore | Consolidate into one small util when convenient |

## C. Redundant sync machinery (overlaps the sync bug report)

| # | Finding | Evidence |
|---|---------|----------|
| C1 | **Three concurrent sync engines** can write the same KV doc: per-panel webview engine, host folder reconcile (30 s + FS events), web app | `extension.js:119`, `cloudSync.js`, see bug report |
| C2 | **Same file, two cloud identities** — `file:<abs path>` entries (webview) vs mapping UUIDs (folder link) duplicate presets in the cloud library | `localBridge.js:131` vs `extension.js:467` |

These are design-level redundancies; fold their resolution into the sync fix
change request rather than "cleanup".

## D. Stale documentation (CLAUDE.md drifted from the 07-02→07-04 refactors)

| # | Claim in CLAUDE.md | Reality |
|---|--------------------|---------|
| D1 | "Splitpanes (desktop 3-pane), vuedraggable (drag-reorder)" | Neither is used; 3-pane is collapsible columns, reorder is native DnD |
| D2 | `DetailsModal.vue` listed under Modals | File no longer exists |
| D3 | "syncStore.js — sync status **+ passphrase state**", Settings "**cloud-sync passphrase**" | Zero `passphrase` hits in src; auth is accounts + API keys |
| D4 | "the open file … is **never cloud-synced**" (also `extension.js:15` header, `localBridge.js:4`, `_touchActivePreset` docstring "No-op in the VS Code extension") | Since `9a1f11a` the open file IS synced via its `file:` library entry; `_touchActivePreset` is not a host no-op anymore. Directly misleads future sync debugging |
| D5 | File-routing table lacks the newer components/utils | `GlobalSearchModal.vue`, `ShortcutsHelpModal.vue`, `VariableTimeline.vue`, `utils/highlight.js`, `utils/shortcuts.js`, `utils/tokens.js` exist but are unrouted |

Suggested action: one CLAUDE.md refresh pass (cheap, high value — the stale
"never synced" language actively contradicts the current data flow).

## E. Verified NOT dead (checked, keep)

- All 25 components are imported somewhere (orphan scan: none).
- `splitByTerm`, `getCaretCoordinates`, `opLabelKey`, `VAR_MACRO_META`,
  `estimateTokens`/`formatTokenCount`, `loadPresetIntoFile`,
  `createPresetFile`, `requestCloudState`, all `presetFolder.js` exports —
  all have real consumers.
- `floating-vue` (v-tooltip/VTooltip in 4 components), `@headlessui/vue`,
  `@heroicons/vue`, `@vueuse/core` (pending A2 decision) — in use.
- `legacy_progress.md` — intentionally preserved upstream history.
- `launch-stpreseteditor.bat` — working dev-server launcher.

## Test suite status

`npm test`: 88/89 pass. The one failure
(`cloudSync.test.js` › "after a dismissal, the next edit-triggered push
re-opens the dialog") is a timing regression from the 07-04 refactor —
analysed as RC5 in `bugs/2026-07-10-sync-conflict-data-loss.md`.
