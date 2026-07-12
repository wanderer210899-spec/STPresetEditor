# Live validation plan & results — F5 + S2

**Date:** 2026-07-12
**Scope:** live (running-app) confirmation of F5 incremental macro analysis and S2 `syncNow`
forced-pull, beyond the headless unit tests. Includes the capability reality of what can be
driven automatically vs. what needs the user's hands in VS Code.

## How to run live (grounded in `TESTING.md`)

| Target | Command | URL | Validates |
|---|---|---|---|
| **Web SPA** (same Vue bundle as the VS Code webview) | `npm run dev` | http://localhost:5173 | F5 render, general UI, macro analysis |
| **Worker + sync API** | one-time `npx wrangler d1 migrations apply stpreseteditor-auth --local`, then `npm run cf-preview` | http://localhost:8787 | S2 cloud pull, sync, conflict |
| **VS Code extension** | Install `extension/stpreseteditor-local-0.8.1.vsix` (or F5 "Run STPresetEditor Extension"), then right-click a `.json` → "Open in STPresetEditor" | webview panel | host file bridge, document switching, real hidden-tab pull |

Two-client sync test (from `TESTING.md`): open the same URL in a second browser/private window,
sign in with the same account; an edit on one side is picked up by the other within ~30s / on focus.

## Capability reality (what I can drive)

- **Web SPA at :5173 — YES, reliably.** I drive it via the chrome-devtools MCP (isolated Chrome on
  `--remote-debugging-port=9222`). It runs the **identical** built Vue bundle the VS Code webview
  loads, so F5 render behavior and store logic are validated 1:1.
- **VS Code's own Electron webview — NOT reliably.** The MCP browser attaches to Chromium via CDP;
  VS Code is Electron and the webview lives in a nested iframe/webview process. CDP attach to it is
  fragile and has historically hung in this workspace. So the **extension-only** paths (host↔webview
  postMessage file bridge, switching the active VS Code document, the real hidden/unfocused webview)
  are best confirmed by the user with the manual checklist below, or accepted via the web-SPA proxy
  (same bundle) for everything that isn't host-specific.

## F5 — live results (PASS, web SPA, production bundle)

Driven against the live Pinia store in the running app (example preset, 21 ordered prompts):

- Edit ONE prompt through the real `updatePromptDetail` path → after the real 300 ms debounce, only
  that prompt's `.macros` was re-tokenized; **all 20 other prompts kept the same `.macros` array
  reference** (`changedOthersCount: 0`) — the "no list-wide re-render" win, confirmed live.
- Tokenization correct (`{{setvar::__liveF5__::42}}` → `__liveF5__:42`); cross-prompt aggregates
  rebuilt (`getvar` resolved, `variableEndValues.__liveF5__ === '42'`, var count 5→6).
- **Edge — two prompts edited in one 300 ms window:** both re-tokenized (dirty-set accumulation),
  a third stayed stable.
- **Edge — structural change (toggle enabled):** ran the FULL pass (every prompt re-tokenized),
  confirming the incremental path is correctly scoped to content typing only.
- **Console: zero errors/warnings.** DOM reflected the edits.

## S2 — live results (PASS, two real clients on the local worker :8787)

Ran the full end-to-end with the local Cloudflare worker (`npm run cf-preview`, D1 + KV local) and
two isolated browser contexts signed into one account (`a@test.local`):

- **Cloud round-trip works in the built bundle:** client A `register` → pushes the open preset;
  client B `login` (same account) → **pulls A's library** (`STATE_ONE`). Push/pull verified against
  `GET /api/presets`. (Confirms my `presetStore`/`cloudSync` changes didn't break sync.)
- **Remote edit live-applies into the OPEN editor with no reload:** A edits `STATE_ONE→STATE_TWO`,
  pushes; B's open editor updated to `STATE_TWO` without a document switch or reload.
- **Hidden-guard edge (the exact VS Code symptom), cleanly reproduced:** with B forced to report
  `document.hidden = true`, A pushed `STATE_THREE`; B's auto-pull triggers (focus/visibility) fired
  but the pull was **suppressed** — editor stayed `STATE_TWO` ("had to switch document and reload").
  Removing the hidden override and re-firing → the pull ran and the editor **live-applied
  `STATE_THREE`** with no reload. This proves the `document.hidden` guard is the *sole* blocker, and
  `syncNow({force:true})` skips exactly that guard (unit-tested in `reproSaveSync.test.js` "F.").
- **Console: zero errors/warnings** on both clients.

**Not directly invocable live:** `syncNow()` is a module export with no wired UI trigger yet (the
"Sync now" button is the deferred QoL item), so it can't be clicked from the running page. Its
forced-bypass contract is covered by the unit test + the hidden-guard demonstration above; wiring the
button will let it be clicked live (and in VS Code).

**Remaining S2 edge cases (unit-tested; re-verify live once the button is wired):** `syncNow` no-ops
when already current; pending local edits → merge path (not blind overwrite).

## Does `syncNow` actually add value over auto-sync? (root-cause probe)

`syncNow()` is `pollCloudNow({ force: true })` — the **only** code difference from auto-sync is
skipping the `if (!force && document.hidden) return` guard. Same fetch, same conflict-safe merge.
Auto-sync (`pollCloudNow` on focus/visibility/30s) has existed since `2efcd0a Phase 2` — it
predates the reported "had to switch document and reload" symptom, yet the symptom still happened.

Grounding (VS Code docs): with `retainContextWhenHidden` (this extension uses it) "scripts and other
dynamic content keep running even when the tab is not active or visible" — so the 30s interval keeps
ticking, and once the panel is visible again the next tick should pull **iff `document.hidden` reads
false when visible.** VS Code does NOT document `document.hidden`/`visibilitychange` behavior in
webviews. So the value of `syncNow` hinges on one unverified fact.

**Decisive probe — paste into the VS Code webview DevTools console**
(Command Palette → "Developer: Open Webview Developer Tools", with the STPresetEditor panel open):

```js
console.log('[probe] now: hidden=', document.hidden, 'state=', document.visibilityState);
document.addEventListener('visibilitychange', () =>
  console.log('[probe] visibilitychange -> hidden=', document.hidden, 'state=', document.visibilityState));
window.addEventListener('focus', () => console.log('[probe] focus  -> hidden=', document.hidden));
window.addEventListener('blur',  () => console.log('[probe] blur   -> hidden=', document.hidden));
```
Then switch to another editor tab and back, and read the log.
- **`visibilitychange` fires and `hidden` toggles true→false correctly** ⇒ auto-sync already works
  (refreshes within ≤30s of returning) ⇒ `syncNow` is mostly redundant (only adds immediacy).
- **No event fires, or `hidden` stays `true` while the panel is visible** ⇒ auto-sync is blocked ⇒
  `syncNow`'s forced bypass is the real fix; wire the button.

Status: **RESOLVED by shipping the button (2026-07-12).** Rather than keep chasing VS Code's
undocumented visibility behavior (the console probe is blocked by Trusted Types in Cursor, and the
user is non-technical), the "Sync now" button was wired as a universal manual backstop — useful
regardless of the root cause (worst case: saves the ≤30s wait; best case: it's the fix). Validated
live below.

### "Sync now" button — wired + live-validated (PASS)
`AppToolbar.vue`: both sync-status dots are now click-to-`syncNow()` buttons (label/tooltip
`sync.syncNow`, en+zh; toast on result). Driven live on the local worker with two clients:
- Client B forced to report `document.hidden = true` (the VS Code condition). Client A edited the
  shared preset (`STATE_THREE → BUTTON_TEST`) and pushed.
- **Clicking the real "Sync now" button on hidden B forced the pull** — the open editor updated to
  `BUTTON_TEST` (which the auto-pull would have skipped while hidden), with a "pulled the latest"
  success toast.
- Second click (nothing new) → "Already up to date." Zero console errors. 99/99 unit tests still pass.

## VS Code manual checklist (extension-only paths — for the user)

Run after installing the built vsix (rebuild first: `npm run package:ext`):

**F5 in the webview**
1. Open a folder with a preset `.json`; right-click → "Open in STPresetEditor".
2. Type macros into one prompt's body (e.g. `{{setvar::t::1}}`) — highlighting updates smoothly with
   no whole-list flicker; the Variables tab shows `t`.
3. Edit a second prompt to `{{getvar::t}}` — it resolves (not unresolved). No lag on a large preset.

**S2 sync without switching documents**
4. Settings → Cloud sync → connect (Worker URL + API key). Edit the same preset from the web app.
5. Back in VS Code, trigger "Sync now" (once wired) — the open editor updates **without** closing/
   reopening the document. (Today, wiring the button is the pending QoL piece.)

**Same-name (step 1a)**
6. Open two different files both named e.g. `Default.json` from different folders — the library shows
   `Default` and `Default (2)` (distinct entries, never merged).

## Status (2026-07-12)
- **F5: validated live (web SPA, production bundle) + unit-tested.** Only-edited-prompt re-tokenize,
  multi-prompt window, cross-prompt rebuild, structural→full-pass; zero console errors. VS Code
  webview runs the same bundle; manual steps 1–3 recommended as a spot check.
- **S2: validated live (two clients on local worker) + unit-tested.** Cloud round-trip, live-apply
  without reload, and the hidden-guard behavior all confirmed; zero console errors. The forced
  `syncNow` bypass is unit-tested (no wired trigger to click yet).
- **VS Code host-specific paths:** user-run manual checklist below (not reliably drivable by MCP
  tooling — Electron webview CDP attach is fragile in this workspace).
- **Harness left running:** web SPA `localhost:5173`, worker `127.0.0.1:8787`, isolated Chrome on
  `:9222`. Stop with the servers' background processes when done.
