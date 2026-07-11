<!-- Intake via spec-communication skill, 2026-07-10 -->

# Change: Dead-code & redundant-dependency audit (report first)

- **Date:** 2026-07-10
- **Project:** sillytavern-extensions/STPresetEditor
- **Status:** Confirmed — report only, removals decided afterwards

## What it does now

The repo has accumulated a fork's worth of history: an upstream static SPA plus
this fork's cloud sync, auth, VS Code extension, worker, two vite configs,
planning docs, and several libraries (Headless UI, Splitpanes, vuedraggable,
floating-vue, lodash-es, Tailwind v4, …). Some code paths and library features
are suspected dead or near-duplicated.

## What should change

Produce a **findings report** covering, across `src/`, `extension/`, `worker/`,
configs and `package.json`:

1. **Dead code** — unused exports/functions/components, unreachable branches,
   leftover residue from replaced approaches (e.g. superseded sync paths).
2. **Redundant / near-redundant library usage** — dependencies that are unused,
   used for one trivial thing replaceable by existing code, or overlapping with
   another dependency already in the bundle.
3. **Duplicated in-repo logic** — two implementations of the same thing.

Each finding: what it is, where (file:line), evidence it's dead/redundant, and
the suggested action. **No deletions in this pass** — the user picks what gets
removed afterwards.

## Why now

Requested alongside the sync/conflict debugging; the recent refactor may have
left residue.

## Must stay the same (regression guard) — REQUIRED

- No source, config, or dependency changes as part of the audit itself.
- `references/` and other workspace projects untouched.

## Rewrite policy — pick one (REQUIRED)

- [x] **Report only** (this pass). Cleanup happens as a follow-up change after
  the user selects findings. (Fix-policy answer "refactor allowed" applies to
  the two bug fixes, not to this audit.)

## Acceptance check

> Done when a findings document exists in the project listing dead code and
> redundant library features with file/line evidence and suggested actions,
> and no repo files were modified by the audit.

## Assumptions & open questions

- **Assumption:** node_modules / lockfile internals are out of scope; only
  declared deps and first-party code are audited.
- **Open question:** none.
