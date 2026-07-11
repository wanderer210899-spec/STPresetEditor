<!-- Intake via spec-communication skill, 2026-07-10; reproduced + diagnosed same day (investigate-only pass) -->

# Bug: Prompt-card drag reordering dead inside the VS Code extension webview

- **Date:** 2026-07-10
- **Project:** sillytavern-extensions/STPresetEditor (webview build)
- **Status:** **FIXED 2026-07-11** — shipped in extension 0.8.0

## Fix applied (2026-07-11)

`PromptCard.vue`: the drag handle's width gate is now host-aware —
`:class="isHostDesktop ? 'inline-flex' : 'hidden md:inline-flex'"` (host
detection via `isVsCodeHost()`). In the webview the handle exists at every
panel width (always visible below `md`, hover-revealed above it); the browser
keeps the exact previous classes.

**Verification (MCP-backed, shimmed `acquireVsCodeApi` over the new build):**
- Host mode @ 701px: handle renders (`display:flex`), mousedown on it arms the
  card (`draggable="true"`), and `dragstart` fires. Previously `display:none`
  and permanently `draggable="false"`.
- Browser control @ 701px (no shim): unchanged — handle hidden, card
  `draggable="true"` via mobile mode.

## Root cause

Two "am I desktop?" signals disagree inside a VS Code webview panel narrower
than 768 px:

1. **JS forces desktop mode in the host.** `AppLayout.vue:18`:
   `isDesktop = isVsCodeHost() || gteDesktop` (commit `9a1f11a`, 2026-07-04).
   So in the webview `store.isMobile` is always `false`, and
   `PromptCard.vue:16` — `:draggable="store.isMobile ? true : dragArmed"` —
   requires the drag to be **armed from the handle** (`@mousedown` on
   `.block-controls`, introduced by Phase 4 commit `7dedb27`, 2026-07-02).
2. **CSS hides that handle by real width.** The handle's classes are
   `block-controls hidden … md:inline-flex` (`PromptCard.vue:30`) — Tailwind's
   `md:` is the **actual viewport width**, so below 768 px the handle is
   `display:none`.

A docked webview panel is very commonly < 768 px wide → no handle → `dragArmed`
can never become true → every card stays `draggable="false"` → **all drag
reordering is dead**. In the browser the two signals agree (below 768 px
`isMobile` is true ⇒ `draggable="true"`), which is why the web app works.

Until `7dedb27`, cards were `draggable="true"` unconditionally (verified at
commit `75d1d4a`, the 0.3.1-era code) — matching "it used to work, then
stopped after the latest refactor" (both changes shipped together in VSIX
0.7.1).

## Reproduction (MCP-backed, 2026-07-10)

Served the built app with `window.acquireVsCodeApi` shimmed (what
`isVsCodeHost()` checks, `src/utils/host.js:8`), fed a preset over the bridge,
drove it via Chrome DevTools MCP:

- 934 px viewport: handle rendered, cards `draggable="false"` until armed — OK.
- **701 px viewport: `.block-controls` computes `display:none`, cards
  `draggable="false"`, nothing can arm a drag.** Dispatching a synthetic
  `mousedown` on the *hidden* handle still flipped `draggable` to `"true"` —
  proving the arming chain works and handle reachability is the only break.

## Expected / Actual

- Expected: prompt cards can be drag-reordered in the extension at any panel width.
- Actual: impossible below 768 px panel width; above it, only via a small
  hover-revealed handle.

## Suggested fix direction (for the follow-up)

Make the two signals agree. E.g. gate the handle's visibility on host/desktop
*mode* rather than raw `md:` width (a `.host-desktop` root class or
`:draggable="store.isMobile || isVsCodeHost() ? … : …"`-side change), or in
host mode fall back to always-draggable below `md`. Must not change browser
behavior (regression guard).

## Where it happened

VS Code extension webview only (0.7.1); web app unaffected (user-confirmed +
code-confirmed).

## How often & how bad

Always, at typical docked panel widths; blocks the reordering workflow.

## Fix policy (from intake)

Refactor allowed; browser build behavior must stay identical.
