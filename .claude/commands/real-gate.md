---
description: Stage 5 — run the real-project gate (test:e2e-real + optional cap_try), then gate-interpreter
argument-hint: "[js|ts|both] (default both)"
---

Run the methodology **stage-5 real-project gate** — the one run that proves the
product actually works (no fake-runner) — then hand the artifacts to the
`gate-interpreter` agent for the flake-vs-regression verdict.

Procedure:

1. Confirm `VALIDATOR_E2E_REAL` is **unset** in the ambient env (the guard hook
   enforces this for the cheap suite; the real run sets it deliberately).
2. Run the real-toolchain suite: **`npm run test:e2e-real`** — it sets
   `VALIDATOR_E2E_REAL=1` via cross-env and exercises BOTH the JS fixture
   (`test/fixtures/e2e-real-project/`) and the TS fixture
   (`test/fixtures/e2e-real-ts-project/`, static-only / karma-never). This burns
   real LLM calls (~$0.10–$0.40) and needs an authenticated `claude`. `$ARGUMENTS`
   may narrow intent to `js` or `ts`.
3. (Optional) if the user has a `cap_try` / `cap_try_ts` real SAPUI5 checkout,
   run `npx tsx src/cli.ts validate --all --force` there too.
3b. **Runtime shakedown of generated tests.** If the gate run generated tests
   (JS or TS), execute them in the **gate project's own harness** (its own
   `karma`/npm scripts, run by you in that checkout — a dev-time action on a
   trusted local project, NOT the product running karma; the product's
   never-build firewall is untouched). For TS this is the only stage that
   executes `.qunit.ts` output at all — static-only acceptance cannot see a
   runtime hang, and this exact step is what caught the qunit-2 double-define
   defects (v1.5.1). A generated test that hangs or reds the project suite is a
   gate FAIL signal even when every static lane was green.
4. **Invoke the `gate-interpreter` subagent** pointed at each SANDBOX's
   `.sapui5-validator/last-run/` + `report.json` (since V1.9.5 INF-1 the runs
   execute in `<os-tmp>/sapui5-validator-e2e-real/js-validate/` and
   `…/ts-validate/`, not the in-repo fixtures) and the vitest output. Relay its
   `PASS / PASS-WITH-FLAKES / FAIL` verdict and any draft defect table verbatim.
5. Confirm `git status --porcelain -- test/fixtures/` is empty (the suite's
   own `teardown()` asserts this too). Non-empty = a sandbox-isolation
   regression — report it, do not clean it up.
