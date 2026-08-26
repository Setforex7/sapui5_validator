# test/e2e-real — real-toolchain integration tests

This directory contains end-to-end tests that **invoke real external
binaries** (`claude`, `ui5lint`, `eslint`, `karma`) against a real
SAPUI5 fixture at [test/fixtures/e2e-real-project/](../fixtures/e2e-real-project/README.md).
Unlike the rest of the suite, these tests do not use the
`FakeClaudeRunner` or mock subprocess output. They exist because an
all-fake test suite once shipped five distinct bugs into production —
bugs the real toolchain surfaces immediately.

## Enabling

```sh
# Windows / POSIX, via the script wrapper:
npm run test:e2e-real

# Or explicitly:
VALIDATOR_E2E_REAL=1 npm test         # POSIX
cross-env VALIDATOR_E2E_REAL=1 npm test   # Windows
```

Default `npm test` and CI runs **without** the flag will skip
everything under `test/e2e-real/**`.

## How a run works

A single `sapui5-validate validate --all --force` per fixture happens in
vitest's `globalSetup` ([setup.ts](setup.ts)). Since V1.9.5 (INF-1) each
run executes inside a **deterministic tmpdir sandbox** — a copy of the
fixture minus `node_modules`, with `node_modules` junctioned (Windows) /
symlinked (POSIX) from the installed in-repo fixture — at
`<os-tmp>/sapui5-validator-e2e-real/js-validate/` (JS) and
`…/ts-validate/` (TS). Artifacts persist under each sandbox's
`.sapui5-validator/`:

- `report.json`
- `last-run/prompts/*`
- `last-run/responses/*`
- `last-run/verify/*`
- `last-run/llm-error-*.txt`

Each test file under [./](./) then performs pure-filesystem assertions
against those artifacts via [./\_shared.ts](./_shared.ts) (`PATHS` /
`TS_PATHS` point at the sandboxes). The cost of one full pass is
therefore **one** real validator run per fixture regardless of how many
witness tests are added, matching the $0.10–$0.40 / run budget published
below.

Because LLM-applied fixes land in the sandbox, the tracked fixtures under
`test/fixtures/` are never mutated — there is no post-run revert step.
The suite's `teardown()` asserts `git status --porcelain --
test/fixtures/` is empty and fails the run otherwise (the fail-on-revert
guard for the sandbox isolation). The offline cheap-suite test
`test/unit/e2e-sandbox-materialize.test.ts` exercises the
copy-plus-symlink core on every platform in CI, including the POSIX
symlink branch on the ubuntu leg.

## Cost

- LLM calls: ~5–20 per full E2E run, depending on how many checks
  produce findings against the fixture. At Claude 4.7 Opus rates that
  is roughly $0.10–$0.40 per run on API billing; on a Max subscription
  the cost is absorbed.
- Network: `karma-ui5` fetches the SAPUI5 SDK from
  `https://sdk.openui5.org` on every run.
- Time: first run installs the fixture's `node_modules/` (~100–300 MB)
  via [setup.ts](setup.ts); subsequent runs reuse the install.

## Why this is gated and not in CI

1. Cost: a flaky network or a regression that loops over the LLM would
   burn real dollars on every PR.
2. Determinism: real `claude` output varies turn-to-turn, so tests
   here are expected to be slightly less stable than the fake-runner
   tier.
3. Setup time: the first-run `npm install` is on the order of a minute.

Developers are expected to run `npm run test:e2e-real` locally before
landing any change that touches LLM call paths, verify-pipeline
adapters, or `BinaryRunner`. The fake-runner suite (`npm test`) remains
the default for everything else and runs in seconds.

## V1.1 bug-witness tests (Session V1.1-3)

Six tests land here in V1.1-3 — one per known V1 bug. All six are
designed to **fail today** and pass progressively as each fix session
(V1.1-4 through V1.1-8) lands:

| File | Witnesses | Fix session |
|---|---|---|
| [audit-log.e2e.test.ts](audit-log.e2e.test.ts) | Bug 5 — `prompts/`, `responses/`, `verify/` written | V1.1-4 (+ V1.1-8 for verify/) |
| [audit-log-routing.e2e.test.ts](audit-log-routing.e2e.test.ts) | Bug 7 — audit-log filenames correlate by callId | V1.1-4 |
| [ui5lint-paths.e2e.test.ts](ui5lint-paths.e2e.test.ts) | Bug 1 — ui5lint receives project-relative paths | V1.1-5 |
| [scope-exclusion.e2e.test.ts](scope-exclusion.e2e.test.ts) | Bug 4 — `*.min.js` excluded from scope | V1.1-6 |
| [process-kill.e2e.test.ts](process-kill.e2e.test.ts) | Bug 2 / B1 / R4.3 — argv-guard refusal (exitCode -2) classified distinctly | V1.1-7, split in R4.3 |
| [schema-envelope.e2e.test.ts](schema-envelope.e2e.test.ts) | Bug 3 — envelope unwrap before schema validation | V1.1-8 |

The Bug-2 and Bug-4 tests depend on two files seeded into the JS
**sandbox** by [setup.ts](setup.ts) (`webapp/util/oversized-input.js`
and `webapp/util/dummy-vendor.min.js`); both are recreated on every
enabled run and never touch the in-repo fixture.

R4.3 split the process-kill witness: post-B1, an oversized input is
always refused by the pre-spawn argv guard (synthetic `exitCode: -2`,
no spawn), so the seeded-input tests above now pin the GUARD path, and
[process-kill-real.e2e.test.ts](process-kill-real.e2e.test.ts) pins the
real-OS-kill path (`exitCode: -1`) by letting the OS terminate a
genuinely-spawned `claude` child at the `BinaryRunner` layer.
[generate-concurrency.e2e.test.ts](generate-concurrency.e2e.test.ts)
(R2.6a) is the automated `--concurrency 2` witness against the real
toolchain.

## Files

- `setup.ts` — Vitest `globalSetup`. Installs fixture deps in-repo
  (idempotent, hashed marker), materializes both tmpdir sandboxes fresh,
  seeds the Bug-2 / Bug-4 input files into the JS sandbox, then runs
  `sapui5-validate validate --all --force` once per sandbox per enabled
  invocation. Its `teardown()` asserts the tracked fixtures stayed
  byte-clean. No-op when `VALIDATOR_E2E_REAL` is unset.
- `_shared.ts` — paths + lightweight readers used by every witness test
  to inspect the persisted run artifacts. Makes no assertions itself.
- `*.e2e.test.ts` — the six bug-witness tests listed above.

## What lives where

| Layer | Purpose | Speed | Cost |
|---|---|---|---|
| `test/unit/`        | Fake-runner-driven units            | <1 s/test | $0 |
| `test/integration/` | Fake-runner-driven orchestration    | <2 s/test | $0 |
| `test/unit/*.e2e.test.ts` (VALIDATOR_E2E=1)   | Real `ui5lint`/`eslint` against `minimal-project`, no LLM | ~10 s | $0 |
| `test/e2e-real/`    (VALIDATOR_E2E_REAL=1)    | Real `claude` + real linters + real karma | ~60 s+ | ~$0.10–$0.40 |

## Deviation from V1.1-3 plan: karma test-starter upgrade deferred

V1.1-PLAN session V1.1-3 lists a prerequisite step:

> Before writing E2E tests that depend on karma executing QUnit, upgrade
> the e2e-real-project fixture's testsuite to the karma-ui5 test-starter
> pattern (createSuite.js + testsuite.qunit.js manifest), which Session
> V1.1-2 flagged as deferred. Verify karma actually runs QUnit on the
> trivial test in the fixture before proceeding to the karma-related E2E
> tests.

After auditing the six tests against the fixture and the verify pipeline,
**none of the six bug-witness tests depend on karma successfully
executing QUnit**:

- The audit-log tests (Bug 5 / Bug 7) assert that the `verify/` directory
  is non-empty, but the verify pipeline writes a dump per fixed file for
  *any* configured verify step. The fixture's seeded breaks fire findings
  in `no-direct-dom` / `missing-teardown` / `missing-i18n`, whose fix
  loop runs `ui5lint` and `eslint` regardless of whether karma succeeds.
- All other tests assert against `report.json` shape and audit-log file
  presence/naming. They do not introspect karma's runtime behaviour.

The karma test-starter upgrade is therefore deferred to V1.1-3.5 (or
folded into a later session if the need arises during fix work). The
existing `html`-mode `karma.conf.js` + `testsuite.qunit.html` setup
continues to be used.

**Risk accepted:** if karma fails to launch (e.g., chrome headless is
unavailable in CI), the affected fix-loop iterations will leave a
karma-failure stderr dump under `verify/`. That actually *helps* the
Bug-5 witness — verify dumps appear sooner. It does not falsify any
test in this folder.

If a later session needs the upgrade, the typical shape is:

```
webapp/test/testsuite.qunit.html  →  uses sap/ui/test/starter/createSuite.js
webapp/test/testsuite.qunit.js    →  exports { name, defaults, tests: { ... } }
```

…and `karma.conf.js` switches `frameworks: ['ui5']` from html mode to
script mode via `ui5: { mode: 'script', testpage: 'webapp/test/testsuite.qunit.html' }`.
