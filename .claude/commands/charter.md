---
description: Stage 2 — author a ready-to-paste session charter (action prompt) from a plan phase, then self-validate it
argument-hint: "<plan path> <phase/fix id> — e.g. plans/<cycle>-PLAN.md Phase-1"
---

Author the **ready-to-paste session charter** (the "action prompt") for the
phase/fix `$ARGUMENTS` from its plan, in this repo's house format — the same
shape the §4 "Ready-to-paste session prompts" blocks use and that
`charter-validator` + `session-exit-auditor` expect. This is a main-loop
procedure (not a subagent): authoring needs the full plan/diagnosis context and
free code-reading to pin citations to the CURRENT tree.

Steps:

1. **Read the source.** Open the named plan (and its diagnosis if referenced) and
   isolate the one phase/fix. Read every file the phase will touch so each
   citation is pinned to the current code, not the plan's possibly-stale line
   numbers.

2. **Write the charter** as one self-contained, paste-ready prompt with ALL of:
   - **Objective** — the single fix/feature and its defect/feature id; one or two
     lines, no ambiguity. One commit, on a clean tree.
   - **Files to change (§5)** — each with a verified `path:line` citation and what
     changes. Keep the scope to one logical change.
   - **Do-not-modify (§6 / "Do NOT change …")** — the keep-out list (symbols,
     files, frozen assertions), plus the standing keep-outs: any local-only
     maintainer docs at the repo root, unrelated `test/fixtures/**`, and any
     public contract the phase is not meant to touch.
   - **Fail-on-revert test(s)** — name the exact test file(s) and assert each new
     guard **MUST fail before the src change — prove it fails pre-fix**, then pass
     after. Integration tests must cpSync the fixture, never write the shared
     `FIXTURE_ROOT`.
   - **Verification gates** — `npm run build` / `lint` / `test` /
     `typecheck:test` all green. For any TypeScript-path work, restate the
     **never-build firewall** (`karma-call-count == 0 on TS`) as a hard guard.
   - **Commit** — a conventional subject (e.g. `fix(vX.Y.Z): … (Dn)`), a
     one-line behaviour-boundary note, and the `Co-Authored-By` trailer.
   - **Closing block** — "Then invoke `session-exit-auditor` over the diff + this
     charter and report its verdict." (The standing handoff convention.)

3. **Self-validate.** Invoke the `charter-validator` subagent on the charter you
   just wrote. Relay its PASS/FAIL and fix any stale citation (`OLD → NEW`) it
   reports before presenting the final charter.

Output the finished, validator-clean charter ready to paste into a fresh session.
By default print it inline; write it to a file only if the user asks (charters
live under the local untracked `plans/` — they never enter the tracked tree).

To re-validate a hand-edited charter later, invoke the `charter-validator`
subagent on it directly.
