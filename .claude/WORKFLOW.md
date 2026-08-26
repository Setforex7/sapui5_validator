# Development workflow — the canonical map

Development is a repeating, **real-project-gated cycle**: deterministic tooling
is ground truth, the LLM is surgical and verify-then-accept, and every release
is proven against a real SAPUI5 project before it ships. The guiding lesson,
from the project's own history: *"a fake good enough to pass tests is not a
fake good enough to prove the product works"* — which is why the **real gate**
is the load-bearing check and every auditor below is **read-only** and
**adversarial**.

## The cycle

| # | Stage | Tooling | Notes |
|---|-------|---------|-------|
| 1 | **Diagnose** | `/diagnose` (+ `/security-review` on trust-boundary surface; web research for external SAPUI5/karma/sinon unknowns) | read-only; writes one local untracked `diagnosis/<cycle>-DIAGNOSIS.md` |
| 2 | **Charter** | `/charter <plan> <phase>` authors a paste-ready session prompt, then self-validates via `charter-validator` (invoke the agent directly to re-check a hand-edited charter) | charters live in the local untracked `plans/`, or stay inline |
| 3 | **Implement** | one charter → one commit on a clean tree; `/code-review high` → `/simplify`; cheap gates: `build` / `lint` / `test` / `typecheck:test` | `/claude-api` before touching envelope parsing |
| 4 | **Exit-audit** | `session-exit-auditor` on the session commit | read-only; hunts vacuous guards, frozen-assertion drift, firewall breaches |
| 5 | **Real gate** | `/real-gate`: `test:e2e-real` (sandboxed) + optional `cap_try`/`cap_try_ts` run + **runtime shakedown of generated tests in the gate project's own harness** → `gate-interpreter` verdict | costs real money — always human-triggered, never `/loop`/`/schedule`d |
| 6 | **Release** | `/ship-check` (`release-readiness-auditor`) + `npm run release:check` + a docs-accuracy sweep (README/SPEC/CHANGELOG vs shipped behavior — stale-doc drift is this repo's recurring defect class) | publish stays manual |

Stage 5's runtime shakedown exists because static acceptance cannot see a
runtime hang: executing generated `.qunit.ts` in the gate project's own harness
(a dev-time action in a trusted checkout — the product's never-build firewall
is untouched) is what caught the v1.5.1 qunit-2 double-define defects that
every static lane had passed.

## Working documents — single source of truth

The **tracked tree carries product truth only** (README, SPEC, CHANGELOG, code,
tests). Per-cycle working documents — diagnosis, plan, charter — live in the
local, **deliberately untracked** (gitignored) `plans/` and `diagnosis/`
directories. Session/cycle state beyond that lives in the maintainer's private
memory, not in the repo. One lean cycle doc is enough — diagnosis, ranked plan,
and charter may share a single file when the cycle is small.

## Custom agents (`.claude/agents/` — all read-only auditors)

- **`charter-validator`** — pre-session lint of a charter: resolves every
  `file:line` citation against the current tree, reports stale ones
  (`OLD → NEW`), checks do-not-touch symbols and fail-on-revert tests.
- **`session-exit-auditor`** — post-commit audit of a session against its
  charter: re-runs the cheap gates, then hunts what a green suite cannot catch
  (vacuous/skipped guards, moved frozen assertions, §6 violations, never-build
  firewall breaches).
- **`gate-interpreter`** — interprets a real-gate run's artifacts (sandbox
  `report.json` + `last-run/`) and classifies every non-green signal:
  genuine-regression / known-flake / environmental / expected. Emits
  `PASS / PASS-WITH-FLAKES / FAIL` + a draft defect table.
- **`release-readiness-auditor`** — GO/NO-GO before tagging: tarball hygiene,
  `npm audit --omit=dev`, the lean-six dependency freeze, version/CHANGELOG/tag
  alignment, inert-`release.yml` publish-safety, and the exact remaining manual
  steps.

All four are **read-only in the dangerous sense**: no `git
checkout/reset/clean/commit/push`, no edits. (A Bash-armed reviewer once
destroyed uncommitted work — see the guardrails below.)

## Always-on guardrails (each has incident history — do not weaken)

- **Pre-commit reviewers are read-only** — `/code-review`, `/security-review`,
  or `agentType: Explore`; never a Bash-armed reviewer. One once
  `git checkout`-ed away uncommitted work. Re-run `git status` after any
  review.
- **`test:e2e-real` is sandboxed** — runs execute in
  `<os-tmp>/sapui5-validator-e2e-real/{js,ts}-validate/`; the tracked fixtures
  stay byte-clean and the suite `teardown()` fails if
  `git status --porcelain -- test/fixtures/` is non-empty. Treat that as a
  sandbox-isolation regression, never clean it up silently. The
  `PreToolUse` hook (`scripts/guard-precommit.mjs`, wired in
  `.claude/settings.json`) blocks the cheap suite while `VALIDATOR_E2E_REAL`
  leaks in the env; it fails open.
- **`npm run release:check`** — the supply-chain + packaging-invariant gate
  (also run by `prepublishOnly`). Publish is **manual and inert by design**:
  `release.yml` fires on `release: published`, never on a tag push.

## Skills — when NOT to use

- No `/loop` or `/schedule` on the real gate — the costly run stays
  human-triggered.
- No `/init` — CLAUDE.md is hand-tuned.
- `/simplify`'s "extract a shared helper" suggestions: reject unless a second
  caller exists (CLAUDE.md "Avoid").
