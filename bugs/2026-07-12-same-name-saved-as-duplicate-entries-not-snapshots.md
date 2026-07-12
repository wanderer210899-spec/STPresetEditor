# Bug — same-name presets become duplicate entries instead of snapshots

**Date:** 2026-07-12
**Where:** VS Code extension webview (file/library flow), preset library (`savedPresets`)
**Severity:** annoying → data-clutter (not data loss; both copies survive)
**Status:** FIXED 2026-07-12 (step 1a) — `openFileAsPreset` now dedupes the display name of a
genuinely-new entry via `_dedupedPresetName` (same as the web/adopt path); distinct files stay
separate ("MyPreset" / "MyPreset (2)"), re-opening the same file keeps a stable name. Regression
tests in `test/presetStore.test.js` ("openFileAsPreset same-name handling"). Full suite 93/93.
Note: cross-panel / post-cloud-merge name collisions and the deeper same-file-different-id
(link vs unlink) identity case are S3 (identity unification), tracked separately.

## Title
Saving/opening a preset under a name that already exists creates a **second library entry with
the same name** instead of adding a **snapshot (version)** to the existing entry.

## Steps to reproduce
1. In the VS Code extension, open a preset file (e.g. `MyPreset.json`) — it becomes a library entry named "MyPreset".
2. Open (or save) another preset that resolves to the same display name "MyPreset" but a different file path.
3. Observe the library.

## Expected
The second save is recorded as a **new snapshot/version under the one "MyPreset" entry** (the
currently-open preset and its versioning), so there is a single named lineage with a version history.

## Actual
Two separate `savedPresets` entries both named "MyPreset" appear ("different versions of a prompt
with the same name"). No snapshot is created; the version history feature is bypassed.

## Root cause (grounded in code)
The library keys entries by a stable **id**, and the two save paths handle name identity differently:

- **`openFileAsPreset(json, name, presetId)`** — `presetStore.js:2683`. The extension/file path keys
  the entry purely by `presetId` (derived from the file path: folder-mapping id when linked, else
  `file:<path>`). **It performs no name-collision check.** Two files with the same basename but
  different paths ⇒ two different `presetId`s ⇒ **two entries with identical `name`**
  (`savedPresets[presetId] = { name: displayName, … }`, line 2695). It *preserves* existing
  `snapshots` (line 2700) but never *creates* one.
- **`importPresetWithDuplicateCheck`** — `presetStore.js:2501` — *does* check names
  (`findPresetIdByName`, line 2542) and offers overwrite-or-unique-rename, but still **never snapshots**;
  it either overwrites `.data` in place or spawns a new UUID entry.
- **Snapshots are manual and per-entry only.** `createSnapshot(presetId, name)`
  (`presetStore.js:2746`, cap `MAX_SNAPSHOTS_PER_PRESET = 20`, line 130) is a deliberate user action
  from the preset manager. No save/open path calls it automatically, so same-name re-saves never
  become versions.

Net: identity is **path/UUID-based**, display **name** is free-form and un-deduped on the file path,
and versioning is a separate manual gesture — so a same-name re-save forks a duplicate entry.

## Fix direction — DECIDED 2026-07-12: snapshot the OPEN lineage only
The user chose **Option A, scoped to the currently-open preset's lineage** (not any global name
match):
- A same-name save/open **on the currently-open preset (same stable identity)** ⇒ call
  `createSnapshot` on that entry and update its `.data`, instead of forking a new entry.
- Two *genuinely different* presets (different stable identity/path) that merely share a display
  name **stay separate** — never silently merged. Visually dedupe their display names so they are
  distinguishable.
- Implementation must key "same lineage" on **stable identity** (the presetId / path-derived id),
  NOT on the free-form display-name text.

## Related
- Ties into the sync "workspace memory = currently-open preset + its versioning" refinement in
  [changes/2026-07-12-webview-perf-and-sync-evaluation.md](../changes/2026-07-12-webview-perf-and-sync-evaluation.md) (S1/S2).
- Must preserve the `markRaw` snapshot invariant (`CLAUDE.md` Architecture) and keep
  `savedPresets[*].data` / `snapshots[*].data` opaque.
