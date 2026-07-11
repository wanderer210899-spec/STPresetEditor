<!-- Intake 2026-07-11: perf investigation ("typing lags a bit on the VS Code extension — find out why"). Diagnosis only; no code changed. -->

# Perf: typing lags in the VS Code extension (and, at scale, everywhere)

- **Date:** 2026-07-11
- **Project:** sillytavern-extensions/STPresetEditor
- **Status:** **FIXED 2026-07-11** (F1, F2, F4, F6 shipped in extension 0.8.1;
  F3 + F5 evaluated and deferred — see below)

## Fix applied (2026-07-11) — measured result

Per-keystroke main-thread time on the shim harness (12-preset library + 80-prompt
open file, the same repro as the diagnosis), driven identically before/after:

| Build | p50 | p90 | long tasks / 24 keys |
|---|---|---|---|
| Baseline (0.8.0) | ~90 ms | ~113 ms | 1 per keystroke |
| + F1 + F2 | ~39 ms | ~60 ms | 0 |
| + F4 (0.8.1) | **~20 ms** | **~26 ms** | 0 |

**F4 also removes library-size scaling** (its whole point): with the library
inflated to 2.5 MB / 49 entries, typing is **22.6 ms with the library raw (F4)
vs 67 ms reactive (pre-F4)** — i.e. per-keystroke cost is now flat regardless of
library size (20 ms at 0.6 MB, 22 ms at 2.5 MB).

- **F1 — no forced reflow in auto-grow.** `MacroAutocompleteTextarea.vue` now uses
  native CSS `field-sizing: content` (every modern VS Code webview / Chromium 123+)
  so the textarea grows with zero JS layout reads. Older engines fall back to a
  single rAF-coalesced `scrollHeight` measurement (was two synchronous reads per
  keystroke: onInput + the modelValue watcher).
- **F2 — persist config was silently broken + serialize debounced.** The store's
  persist config still used the v3 `paths`/`beforeRestore`/`afterRestore` keys,
  which pinia-plugin-persistedstate **v4 ignores** — so the plugin was serializing
  the ENTIRE store (all 57 keys: `undoStack`/`redoStack`, `variables`,
  `macroStateSnapshots`, `prompt.macros`, modal flags, …) on every keystroke, AND
  the extension's active-area exclusion (`PERSIST_PATHS`) was void (a latent
  "wrong file flashes on open" hazard). Migrated to `pick`/`afterHydrate`
  (verified: persisted payload dropped from 57 keys to the intended library+prefs,
  no active-area leak in host mode). Added a debounced localStorage adapter
  (`utils/persistStorage.js`) that flushes at most once per ~400 ms and on
  `visibilitychange`/`pagehide`/`beforeunload`. Same fix applied to `syncStore`.
- **F4 — saved-preset `.data` is `markRaw`'d.** Library entries (and their
  snapshots) are opaque snapshots the app only reads imperatively and always
  replaces wholesale, so marking them non-reactive keeps the whole saved library
  out of every deep store-watcher traversal and the persist serializer's proxy
  walk. Enforced at every write site plus two normalizers (`afterHydrate`,
  `applyCloudData`). Verified: `savedPresets[*].data.__v_isReactive` is false.
- **F6 — host stops reconciling on the webview's own saves.** The saving webview
  already pushes the edit through its own cloudSync engine; the host's post-save
  `scheduleReconcile()` (and the FS-watcher echo of the atomic write) just raced
  that push and churned 409s during typing. `handleSave` now records a self-write
  and the watcher skips reconciling on it (external edits still reconcile).

**Deferred (evaluated, not done):**
- **F3 (collapse the 3 deep `$subscribe` watchers into one).** After F4 the deep
  traverse already skips the entire library, so the remaining benefit is marginal;
  the only meaningful merge would touch cloudSync's `flush:'sync'` subscription,
  which is load-bearing for the just-shipped sync-data-loss fix's suppress-push
  guard. Not worth the regression risk for a small gain.
- **F5 (incremental macro analysis).** This targets the ~300 ms *post-pause*
  analysis hitch, not the per-keystroke lag reported here (`analyzeAllMacros` is
  debounced 300 ms and never fires mid-burst — confirmed in the measurement). A
  safe version (skip reassigning unchanged prompts' `macros`) is possible but
  touches the heavily test-covered analysis core; deferred as separate follow-up.

**Validation:** vitest 91/91, eslint clean, web + webview builds, extension
repackaged as 0.8.1 with the fresh bundle; MCP-backed before/after typing
measurement above.

## Reproduced (MCP-backed, 2026-07-11)

Shimmed-host build (0.8.0 bundle, `acquireVsCodeApi` shim, file mode) with a
realistic dataset: 12-preset library (~640 KB) + an 80-prompt open file
(~115 KB) linked as a library entry → **persisted blob 1.17 MB**. Typing
simulated by dispatching `InputEvent`s into the details-pane content textarea
(`#pd-content`, the `updatePromptDetail` path — same as the inline card editor).

**Result: every keystroke spawns a ~70–110 ms main-thread task**
(p50 90 ms, p90 113 ms over 45 strokes; one long task per keystroke in the
`longtask` observer). At typing speed these tasks queue behind each other —
that IS the felt lag. The synchronous part of the input event is only ~4 ms;
the cost lands in the post-mutation flush (Vue effects + subscribers).

## Where the ~90 ms goes (profiler + A/B-stub attribution)

Measured three ways: DevTools trace (ForcedReflow insight), JS self-profiler
(`Document-Policy: js-profiling`, sample aggregation), and A/B stubbing
(`scrollHeight` getter stubbed; `Storage.setItem` no-op'd):

| # | Cost per keystroke | Share | Culprit |
|---|---|---|---|
| T1 | ~15–30 ms | ~25% of samples | **Forced reflow ×2 in `adjustHeight`** — `MacroAutocompleteTextarea.vue:82-86` sets `height='auto'` then reads `scrollHeight`, once synchronously in `onInput` (line 349) and again in the `modelValue` watcher after Vue patched the DOM (line 394) — the second read forces a full synchronous layout of the card list. DevTools: 375 ms of forced reflow across 12 keystrokes, attributed to bundle fn `g` = `adjustHeight` verbatim. |
| T2 | ~20–30 ms | `traverse` 19% + proxy-`get` traps | **Deep store watchers.** Every `store.$subscribe` registers a Vue deep watcher that `traverse()`s the ENTIRE store state — all library entries, all prompts — through reactivity proxies on every trigger. There are up to three: pinia-plugin-persistedstate, cloudSync (`cloudSync.js:555`, and it's `flush:'sync'` → re-fires per mutation, not per tick), localBridge (`localBridge.js:314`, host only). Profiler top-2 frame `Xt` = Vue's `traverse`. |
| T3 | ~24 ms | `serialize` 10% + setItem + proxy walks | **pinia-plugin-persistedstate serializes ALL persisted paths on every mutation** — `JSON.stringify` of the 1.17 MB subset (through proxies) + `localStorage.setItem`, per keystroke, even though the keystroke changed one string. A/B: no-op'ing setItem+serialize dropped p50 from 84.8 → 60.4 ms. Raw setItem of the same blob is only ~2–4 ms — the serialization/proxy walk is most of it. |
| T4 | remainder (~15–25 ms) | long tail of Vue internals | Component re-render/patch + style recalc for the edited card + details pane. |

**On typing pauses (extra hitches, not per-keystroke):**

- +300 ms: `analyzeAllMacrosDebounced` → `analyzeAllMacros()` **clears and
  reattaches fresh `macros` arrays on every prompt** (`presetStore.js:851,873`)
  — the analysis itself is cheap (measured 1.9 ms) but replacing `macros` on
  all 80 prompts invalidates every `PromptCard` → list-wide re-render, plus the
  T2/T3 cascade re-fires on each of those mutations.
- +1000 ms: `_touchActivePreset` (`presetStore.js:1065`) — double
  `JSON.stringify` compare of the whole active area, then a large
  `savedPresets` entry write → full T2/T3 cascade again.
- Host only, +800 ms: `saveFileNow` → host disk write → **host schedules
  `reconcileFolder` 2 s later** (`extension.js:915,246`) *plus* a 30 s interval
  while any panel is open (`extension.js:122`) — cloud GET + hash scan +
  conditional PUT **racing the webview's own push engine** (maxWait 3 s) on the
  same KV doc. Periodic 409 → `resolveDivergence` (getDoc + merge + possible
  applyCloudData → full re-render) during an editing session.

## Why the extension feels it worse than the browser

1. **The open file exists twice in state** in host mode — active area AND the
   linked `savedPresets` entry (`openFileAsPreset`) — so every O(state) cost
   (T2 traverse, T3 serialize) pays for the open document twice.
2. **localBridge adds the third deep watcher** and the disk-mirror path; the
   host reconcile adds background churn the web app doesn't have.
3. Docked panels are narrow → more line wrapping → taller documents → each
   forced reflow (T1) is costlier; webviews also share renderer resources with
   the workbench.

**Scaling note:** T2 and T3 are O(total library size) *per keystroke*. The lag
grows with the synced library everywhere (web included) — the extension just
crosses the annoyance threshold first.

## Proposed fixes (ranked by win ÷ effort — awaiting approval)

1. **F1 — stop forcing layout in `adjustHeight`** (trivial, ~25% win): use CSS
   `field-sizing: content` where supported (every VS Code webview; Chromium
   123+) and keep a JS fallback for older browsers that coalesces the
   `scrollHeight` read into one rAF and skips when the value is unchanged.
   Remove the duplicate call (onInput + modelValue watcher both fire per key).
2. **F2 — debounced storage adapter for persistedstate** (small, ~25% win):
   `persist.storage` accepts a custom storage; wrap localStorage with a
   ~300 ms trailing-debounce writer that flushes on `visibilitychange`/
   `beforeunload`/`pagehide`. Keystroke cost of persistence → ~0.
3. **F3 — one deep watcher, not three** (medium): a single `$subscribe` fan-out
   (persist-debounce, save-debounce, push-debounce) — and revisit cloudSync's
   `flush:'sync'` (it exists for the suppressPush guard; a token/epoch check
   achieves the same without a per-mutation deep watcher).
4. **F4 — make library entry `data` non-reactive** (medium-high, the
   structural fix): `savedPresets[id].data` is an opaque snapshot — nothing
   binds to its internals (Preset Manager reads name/updatedAt; sync merges
   operate on plain JSON). Storing it `markRaw`ed (or as a JSON string) removes
   the entire library from traverse/serialize/proxy costs — typing cost stops
   scaling with library size.
5. **F5 — incremental macro analysis** (medium): on content edits, re-tokenize
   only the edited prompt and rebuild aggregates; don't touch other prompts'
   `macros` arrays (no list-wide invalidation). Keep the full pass for
   structural ops (order/enable/import).
6. **F6 — don't reconcile after webview-originated saves** (small): the
   webview's own engine already pushes that change; keep the watcher/interval
   for external edits only. Removes the mid-session 409/merge churn.

Validation plan: re-run the same instrumented typing measurement (target:
p50 < 15 ms/keystroke tick, no per-keystroke long tasks at 1.2 MB persisted
state), vitest suite, browser regression of auto-grow behavior (web +
narrow-webview shim), and a two-writer session (webview typing + host
reconcile) confirming no 409 churn.

## Measurement environment

Shim harness (scratchpad `stpe-drag-repro/`, 0.8.0 dist + `Document-Policy:
js-profiling`), isolated Chrome via `--user-data-dir` + CDP :9222, driven with
chrome-devtools MCP (`evaluate_script`, `performance_start/stop_trace`,
`performance_analyze_insight`). Numbers above from a 1200×900 window; absolute
ms will vary with machine/panel width, ratios shouldn't.
