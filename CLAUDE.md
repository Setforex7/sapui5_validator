# CLAUDE.md

## Purpose
This repo is `sapui5-validator`, a Node CLI named `sapui5-validate` that validates SAPUI5 projects and generates QUnit/OPA5 tests. Linters (ui5lint, eslint) and karma are ground truth; Claude is invoked surgically and every artifact it produces is verified before being accepted.

## Architecture
A deterministic TypeScript core orchestrates external SAPUI5 tooling and calls the `claude` binary via subprocess (`claude -p --output-format json`). Every LLM-produced artifact flows through a verify-then-accept pipeline with a 3-retry cap. See [SPEC.md](SPEC.md) for the full design, the seven baked-in semantic checks, CLI surface, exit codes, and V1 scope.

## Commands
- `npm run build` — TypeScript compile to `dist/` (src only; the build excludes `test/` and `scripts/`).
- `npm test` — vitest unit + integration suites (fake-runner; fast, offline, free). Runs via esbuild, so it does **not** type-check.
- `npm run typecheck:test` — `tsc --noEmit` over `test/` + `scripts/` (the src build excludes them and `npm test` does not type-check). Run after editing any test or script, or a type error ships green.
- `npm run test:e2e-real` — V1.1 real-toolchain scope under `test/e2e-real/`. Invokes real `claude`, `ui5lint`, `eslint`, and `karma`/`tsc` against both `test/fixtures/e2e-real-project/` (JS) and `e2e-real-ts-project/` (TS, static-only lane — no karma). Burns real LLM calls (~$0.10–$0.40 / run on API billing); installs the fixtures' deps on first run. See [test/e2e-real/README.md](test/e2e-real/README.md). Run before any change touching LLM call paths or verify adapters.
- `npm run lint` — eslint over the repo (`src` + `test` + `scripts`, per `eslint.config.js`).
- `npm run dev -- <args>` — run the CLI from source via tsx.

## Conventions
- TypeScript **strict** mode. No `any`, no `// @ts-ignore`, no `as unknown as`. `exactOptionalPropertyTypes` is on — never assign `undefined` to an optional field; spread it conditionally (`...(x !== undefined ? { x } : {})`), the idiom used throughout `src/`. LLM output and subprocess output cross trust boundaries — validate with `zod`; the verify pipeline gates acceptance (SPEC.md §2.10).
- **Named exports only.** No `export default`.
- The `ClaudeRunner` interface (SPEC.md §1.5) is non-negotiable. All code that invokes Claude depends on the interface, never on `BinaryRunner` directly. Tests use an in-memory fake.
- Construct every `ClaudeRunArgs` via `buildClaudeArgs()` in `src/claude/runner.ts` — it hard-codes the §1.7 allowlist, and an eslint rule bans a literal `allowedTools:` property anywhere else in `src/`. Never include `Bash(rm*)`, `Bash(git push*)`, or `Bash(git commit*)` (SPEC.md §6 item 12 asserts this).
- Every filesystem write under the scanned project goes through `assertInsideProject()` (`src/util/containment.ts`) before `writeFile` — realpath containment, fails closed on a symlink escape. Never `writeFile` a project-relative path directly.
- LLM-written files go through the verification pipeline (SPEC.md §2.10) before being kept. Failed fixes revert; failed generated tests move to `webapp/test/_failing/`.
- **Cross-run detection cache (V1.9.8, SPEC §2.14a):** `validate` serves unchanged batched detection checks from `.sapui5-validator/cache/` (CLI default on; `--no-cache` disables; `--force` bypasses reads but still writes). Detection calls ONLY — acceptance/verify, fix refinement, generation, and the deterministic checks are never cached. Served findings carry `cached: true` and must move together with `RunReport.cache` counters (`writeReport` enforces it); a HIT never fabricates an audit transcript. Cache entries are untrusted input: strict zod on read, tamper ⇒ MISS. Prompt-text edits in `src/checks/batch.ts` require a `PROMPT_VERSION` decision (a pinned-hash ratchet test enforces it).

## Avoid
- Over-engineering. Concurrency is bounded and evidence-gated: both commands default to `--concurrency 2` (V1.9.7 THR-1; `--concurrency 1` restores sequential), single-runner, no config file. Do not reintroduce anything listed as deferred in SPEC.md §7.
- Hard-coded values. Retry caps, the LLM call budget, and paths under `.sapui5-validator/` go through per-module constants or CLI flags — there is no central `constants.ts`, and no model ID lives in the code (the `claude` binary picks the model).
- Speculative abstractions. Add an interface only when there is a concrete second implementation or test fake. `ClaudeRunner` is the one such boundary that already pays for itself.
- Single-use helpers. Inline trivial logic; extract only on the second caller.
- New dependencies. SPEC.md §5 lists the V1 set; additions need a PR-description line explaining why nothing on that list works.
- Internal subagents (Task tool, subagent files) in the runtime path — SPEC.md §1.3 forbids them in V1. (Dev-time agents/workflows are fine — see below.)
- Building or karma-running TypeScript. The **never-build firewall** (SPEC.md §2.5/§2.10) forbids `karma`, `ui5 build`, or any transpile on a `.ts` artifact — it would execute the untrusted project's `babel.config.js` in-process. TS `validate` is **static-only** (`ui5lint` + `tsc --noEmit` + config-gated `eslint`); a `karma-call-count == 0 on TS` structural test guards it. Re-establish that guard first in any generate-for-TS work.

## Development workflow
The release cycle (diagnose → plan → implement → audit → real gate → release) is codified as Claude tooling under `.claude/` — canonical map: **[.claude/WORKFLOW.md](.claude/WORKFLOW.md)**. Per-cycle working documents (`diagnosis/`, `plans/`) are **local-only and untracked**; the tracked tree carries product truth (README, SPEC, CHANGELOG). The load-bearing always-on rules:
- **Pre-commit reviewers are read-only** — use `/code-review`, `/security-review`, or `agentType: Explore`; never a Bash-armed reviewer (one once `git checkout`-ed away uncommitted work). Re-run `git status` after.
- **`test:e2e-real` is sandboxed** (since 1.2.0): each fixture's validate run happens in a tmpdir sandbox (`<os-tmp>/sapui5-validator-e2e-real/`), so the tracked fixtures stay byte-clean. The suite's `teardown()` fails if `git status --porcelain -- test/fixtures/` is non-empty; treat that as a sandbox-isolation regression, never clean it up silently. A `PreToolUse` guard hook (`scripts/guard-precommit.mjs`) blocks the cheap suite while `VALIDATOR_E2E_REAL` leaks; it fails open.
- **Custom agents** (read-only auditors, all under `.claude/agents/`): `session-exit-auditor` (post-session commit audit), `gate-interpreter` (real-run verdict), `release-readiness-auditor` (GO/NO-GO), `charter-validator` (pre-session plan lint).
- **Editing prompt assembly or the QUnit generator?** Two tested traps: keep LLM-facing feedback under `MAX_PROMPT_FEEDBACK_BYTES` (16 KiB — a token-cost bound on the volatile, re-sent-per-retry refinement payload; SPEC.md §2.10), and honour the detected sinon dialect (`sap-bundled` = sinon 1.17: no `.resolves`/`.callsFake`/`createSandbox`; SPEC.md §2.1).
- **Before publishing**, run `npm run release:check` (the supply-chain + lean-six dependency-freeze gate) — publish stays manual; a tag push alone does not publish.
