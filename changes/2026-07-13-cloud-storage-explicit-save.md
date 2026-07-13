# 2026-07-13 — Cloud simplified to "storage + explicit save"

**Decision (maintainer, locked 2026-07-13):** REPLACE the automatic sync engine.
Root cause of the whole duplicate/resurrection saga was automatic multi-writer
sync (whole-blob, then per-record) reconciling libraries keyed by per-device
random UUIDs. The rewrite removes the engine instead of patching it again.

## The model

- **The cloud is passive, NAMED storage.** One KV record per preset, keyed by
  the preset's NAME (`user:<id>:p:<name>`). There is never more than one cloud
  preset with the same name — the structural fix for duplication: divergent
  random ids can no longer fork one logical preset into many.
- **Same-name write = replace, newest wins.** The explicit send
  (`PUT /api/presets/:name?snapshot=1`) keeps the replaced version as a
  restorable snapshot inside the record (capped at 20).
- **Nothing syncs by itself from Cursor/VS Code.**

## Per runtime

| Runtime                                                    | Behaviour                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Web app**                                                | No UX change: auto-save keeps updating the open preset in place, and a debounced diff push uploads changed entries under their names. Startup = per-name newest-wins reconcile. The toolbar dot is an explicit "Refresh from cloud".                                                                                   |
| **Cursor Interface A — file editor**                       | Opens THAT file; edits save to disk only. NO cloud engine, NO load-from-cloud. One explicit **Send to cloud** button (file name = cloud identity).                                                                                                                                                                     |
| **Cursor Interface B — cloud browser** (`stpe.openEditor`) | Opens BLANK with the Preset Manager listing the cloud presets. Open one into the editor (read from cloud). The normal **Save** button writes it into a workspace folder you pick, overwriting a same-named file. Delete/rename in the manager delete/rename the cloud preset. Edits stay local until an explicit Send. |

Deletes stick: each client keeps a tiny persisted map of names it has synced
(`stpe:cloud:pushed`); a name that vanished from the cloud is removed locally,
never re-uploaded. A name the cloud never saw is a new preset (uploaded on the
web, kept-until-sent in the extension).

## What was removed (not left as dead residue)

- 3-way merge base (`stpe:sync:base`), `resolveDivergence`, the keep-mine /
  use-cloud conflict dialog, background poll (30s/focus/visibility), `syncNow`.
- Whole-document wire format (`{updatedAt, data}` blob), conditional-PUT 409
  protocol, `SYNC_DATA_PATHS` / `EXTENSION_LIBRARY_PATHS`, `buildSyncSnapshot`,
  `applyCloudData`.
- Extension folder↔cloud link: `.stpe-library.json` mapping, `reconcileFolder`,
  `decideSyncAction`/`canonicalHash`, download-missing, cloud-only tree items,
  per-file sync badges, `fileLink` status, "Sync library" status-bar button,
  self-write suppression windows.
- Old host↔webview cloud protocol (`cloudPullRequest`/`cloudPush`/`cloudAck`/
  `cloudReconcile`/`fileState`).

Preferences (`language`, `themeMode`, custom macros/wraps, …) no longer roam —
the cloud stores presets, not settings.

## Cutover

Maintainer authorized wiping cloud storage (local backups exist). No migration:
new code reads/writes only `user:<id>:p:*` keys, so the legacy blob at
`user:<id>` is invisible. Optional cleanup commands are in README →
"Upgrading from the automatic-sync versions". Accounts (D1 auth tables) are
untouched; any experimental per-record tables from the WIP deployment can be
dropped.

## Acceptance (verified by tests + browser smoke)

- Editing a local file in Cursor never creates/changes a cloud preset
  (`test/extensionSync.test.js` — file mode sends only `save` messages).
- Send with a NEW name creates exactly ONE cloud preset; send with an EXISTING
  name updates it, keeps the prior version as a snapshot, leaves ONE record
  (`test/extensionSync.test.js`, `test/worker.test.js`).
- Cloud browser: open → edit stays local → Save routes to the workspace-folder
  picker (host overwrites same-named files).
- Deleting a cloud preset removes it and it does NOT come back
  (`test/extensionSync.test.js`, `test/cloudSync.test.js` resurrection tests).
- The cloud browser opens blank with the library list (Preset Manager) open.
- Webview CSS = web CSS (both builds emit the identical stylesheet; verified
  side-by-side in Chromium).
