<!-- Intake via spec-communication skill, 2026-07-10; diagnosed same day (investigate-only pass) -->

# Bug: Cloud sync loses edits in both directions (web ⇄ VS Code extension)

- **Date:** 2026-07-10
- **Project:** sillytavern-extensions/STPresetEditor
- **Status:** **FIXED 2026-07-11** (RC1–RC5 + C2 identity unification; shipped in extension 0.8.0)

## Fix applied (2026-07-11) — cloudSync.js refactored around a persisted merge base

- **RC2:** the 3-way merge base (`syncedSerialized`) now persists in
  localStorage (`stpe:sync:base`) and reloads on init; `reconnectCloudSync()`
  clears it (credentials changed). With no base, `mergeCollection` falls back
  to heuristics (keep local-only and remote-only entries; both-differ → newer
  `updatedAt` wins) instead of "local wins everywhere".
- **RC1:** init's cloud-newer + no-pending branch no longer blind-adopts: it
  diffs local against the persisted base and routes local changes (e.g. the
  just-linked disk file) through `resolveDivergence()` — merge, then
  conditional push. Regression test: reproSaveSync "E. RC1 restart".
- **RC3:** init's "already in sync" branch now verifies local == cloud before
  sealing the base; a difference pushes instead of orphaning. Regression test:
  cloudSync "RC3 offline changes".
- **RC4:** conflicts resolve merge-first everywhere (`resolveDivergence`).
  The web dialog opens ONLY for a genuine fork of the open document
  (`rawJson`/`prompts`/`promptOrder` changed on both sides since base).
  "Keep mine" pushes the MERGE (conditional PUT — other devices' library
  entries survive; `forcePush`/blind writes removed); "use cloud" adopts
  wholesale as before; dismissal still defers.
- **RC5:** the push debounce gained `maxWait: 3000`, so the store's derived
  mutations can no longer starve pushes; `buildSyncSnapshot()` also strips
  derived `prompt.macros` (like `activeAreaData` already did), eliminating
  false "both changed" diffs and payload bloat. The formerly failing
  dismissal-reprompt test passes.
- **C2:** one identity per file — the host's `load` message now carries the
  folder-mapping presetId when the workspace is linked (webview uses it in
  `openFileAsPreset`), and the folder auto-map adopts an existing
  `file:<path>` cloud entry instead of minting a duplicate UUID. Pre-existing
  duplicate entries in the cloud are NOT auto-migrated (manual cleanup via the
  Preset Manager).

**Verification:** vitest 91/91 (incl. 3 new regression tests for RC1/RC2/RC3
simulating restarts with fresh module state + persisted localStorage), eslint
clean, web + webview builds, extension repacked as 0.8.0.

**Not addressed (unchanged residual risks):** Cloudflare KV eventual
consistency / non-atomic worker check (cross-PoP races can still slip a
conditional write; a Durable Object would fix it properly), shared webview
localStorage whole-state writes between simultaneously-open panels, and
client-clock `updatedAt` stamps.

## User report

Edits from either client (web app / VS Code extension) can be overwritten or
lost; clients can keep showing stale data after the other side synced. *"There
was always a sync conflict issue, but now it's gotten worse after the latest
refactor. Previously the editor just did not sync the browser version on the
open doc."* — the refactor is commit `9a1f11a` (2026-07-04, "Extension parity:
two-way sync of the open preset"), which links the open file to a library entry
(`openFileAsPreset`, id `file:<abs path>`) that autosaves and cloud-syncs.

## Root causes (ranked)

### RC1 — Extension startup: blind adopt steamrolls the just-opened file
`main.js` (file mode) runs `initLocalBridge()` → host sends `load` →
`openFileAsPreset()` stamps the disk content into the library entry
(`presetStore.js:2661`) **before** `initCloudSync()` attaches its change
subscription — so that change never sets `pendingSync`. The reconcile at
`cloudSync.js:407` then sees `cloudIsNewer && !sync.pendingSync` and calls
`adoptCloud()` — a **wholesale replace, not a merge** (`applyCloudData` +
`reloadActiveFromLibrary`, which also rewrites the mirrored .json on disk).
The guard for "local has unsynced edits" at `cloudSync.js:419` is explicitly
`!hostMode`-only. Any cloud movement since the last sync (any web edit, even
an unrelated pref) ⇒ **the open file's local changes are silently destroyed on
extension startup**. This is the primary "extension edits lost" path.

### RC2 — Auto-merge against an empty base clobbers remote edits
`autoRebaseAndPush()` uses module-level `syncedSerialized` as its 3-way merge
base (`cloudSync.js:163`): `syncedSerialized ? JSON.parse(...) : {}`. On the
init path `pendingSync → pushNow → 409 → autoRebaseAndPush`, `syncedSerialized`
is **still null** (it's only seeded by adopt/seed/in-sync branches), so the base
is `{}` — every local entry/pref counts as "locally changed" and **local wins
everywhere**, overwriting newer remote edits (`rebaseSnapshot`,
`cloudSync.js:132`). `pendingSync: true` persists across reloads
(`syncStore.js`), and any session closed within the ~1.5–2.5 s push-debounce
window leaves it set — so this fires routinely on the next launch. This is the
primary "web edits lost" path. Side effect of `{}`-base: locally deleted
presets resurrect (delete is indistinguishable from never-had).

### RC3 — "Already in sync" mis-seed silently orphans disk changes
Same startup ordering: if the cloud has NOT moved (`cloudIsNewer` false,
`pendingSync` false), the final else (`cloudSync.js:429`) seeds
`syncedSerialized` from the **current local snapshot** — which already contains
the fresh disk-authoritative entry that differs from the cloud. The change is
recorded as "synced" without ever being pushed: web stays stale until the next
extension edit, and a later web-side edit to that entry makes the extension
adopt it, discarding the disk version (feeds RC1).

### RC4 — Web conflict dialog is all-or-nothing
On the web, a 409 opens keep-mine/use-cloud (`openConflictDialog`,
`cloudSync.js:278`). "Keep mine" force-pushes the **entire snapshot** (no
`baseUpdatedAt`, `cloudSync.js:243`) — wiping every library entry the other
device added/changed, not just the contested one. "Use cloud" discards all
local edits wholesale. There is no per-entry merge on the web transport (the
extension's `mergeCollection` isn't used there). Long-standing, explains the
"always had conflict issues" history.

### RC5 — Push debounce re-armed by the store's own derived mutations
The `$subscribe` push trigger (`cloudSync.js:439`) fires on **every** preset
store mutation and re-arms the 1.5 s debounce — including derived writes:
`analyzeAllMacrosDebounced` (+300 ms) and `touchActivePresetDebounced`
(+1000 ms), which the same refactor put into the push path
(`pushNow → _touchActivePreset`). Net effect: pushes land ~2.5 s+ after the
last edit and any internal mutation postpones them further, widening the
close-the-window-with-pendingSync gap that triggers RC2.
**Evidence:** `test/cloudSync.test.js` "after a dismissal, the next
edit-triggered push re-opens the dialog" now FAILS (1/89) — the dialog does
reopen, but ~1 s later than the test's `waitFor` budget; confirmed by
instrumented run (flushing all timers makes it pass). This test failure is a
regression marker from `9a1f11a`.

## Contributing design hazards (not single-bug, worth deciding on)

- **Duplicate identities for the same file:** the file webview syncs the open
  doc as `savedPresets["file:<abs path>"]`, while the F5 folder link maps the
  same file to a `crypto.randomUUID()` entry (`extension.js:467`). With a
  linked folder, one .json becomes 2+ cloud entries that both update forever,
  multiplying conflict surface (and `file:` ids leak machine-local absolute
  paths into the shared library; the same file on two machines = distinct
  entries).
- **Many concurrent writers, weak primitive:** each open webview panel runs its
  own full sync engine, the host folder-reconcile PUTs every 30 s
  (`extension.js:119`), plus the web app. Conflict detection is
  read-check-write on **Cloudflare KV**, non-atomic in the Worker
  (`worker/index.js:88-101`) and eventually consistent across PoPs (up to
  ~60 s stale reads cross-device) — 409s can be missed entirely; KV is the
  wrong primitive for multi-writer coordination (Durable Object/D1 would be
  correct).
- **Shared webview localStorage:** all panels share one localStorage;
  `pinia-plugin-persistedstate` writes whole-state on each mutation, so two
  open panels can revert each other's persisted `savedPresets`/`lastSyncedAt`
  offline; in-memory divergence then propagates via push.
- Client-clock `updatedAt` stamps (equality-compared, so tolerable, but
  ordering-blind).

## Suggested fix directions (for the follow-up change request)

1. RC1/RC3: in host mode, treat the `openFileAsPreset` delta as pending —
   either run the reconcile BEFORE linking the file, or diff entry vs cloud at
   init and route through `autoRebaseAndPush` instead of `adoptCloud`.
2. RC2: persist the merge base (`syncedSerialized`) alongside
   `lastSyncedAt`/`pendingSync`, or refuse `{}`-base merges (fetch cloud, treat
   cloud as base for untouched keys).
3. RC4: reuse `mergeCollection` on the web path; scope the dialog to actually
   conflicting entries.
4. RC5: trigger the push subscription off the serialized sync snapshot
   (ignore derived/no-op mutations); fix or re-budget the failing test.
5. Decide: folder-link vs file-webview identity unification (`file:` ids ↔
   mapping UUIDs).

## Where it happened

Desktop; web app (Cloudflare Worker deployment) + VS Code extension 0.7.1
(packaged 2026-07-04, contains the refactored bundle).

## How often & how bad

Recurring; silent data loss — blocks trust in sync.

## Fix policy (from intake)

Refactor allowed; must preserve: local-only fallback, auth model, web
full-set vs extension library-only scope split.
