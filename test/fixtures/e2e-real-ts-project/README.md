# Fixture: e2e-real-ts-project

The **real-toolchain TypeScript-SAPUI5** e2e fixture (V1.9 Phase 4). It is the
TS counterpart of [`e2e-real-project`](../e2e-real-project/README.md): an
installable app whose **real** `tsc` / `ui5lint` are invoked by the
`VALIDATOR_E2E_REAL=1` suite. Where `ts-helloworld` is an offline static fixture
for unit/integration detection + discovery tests, this fixture exists to prove
the **static-only verify lane works against real binaries** end-to-end.

It mirrors SAP's `ui5-typescript-helloworld` shape: ES `import` + `export
default class extends Controller` + a JSDoc `@namespace`, a `tsconfig.json`
pinning `@openui5/types` + `@types/qunit`, a `ui5.yaml` with the
`ui5-tooling-transpile` task, and a `.qunit.ts` test importing the
controller-under-test by its namespace.

## What a TS `validate` run proves here

A `sapui5-validate validate --all --force` against this fixture (driven once by
[test/e2e-real/setup.ts](../../e2e-real/setup.ts), asserted by
[test/e2e-real/ts-validate.e2e.test.ts](../../e2e-real/ts-validate.e2e.test.ts)):

- **Detection + discovery (HB-2).** Detected as TypeScript (non-`.d.ts` `.ts`
  under `webapp/` + the transpile task); discovery enumerates the `.ts`
  controller + the `.qunit.ts` test (never zero), so the TS-aware check prompts
  are dispatched against the real `.ts` source — no silent "clean".
- **The static-only verify lane.** Verification is `ui5lint` + `tsc --noEmit` +
  (config-gated) `eslint` — the project's **own** binaries. The run reports
  `verification: "static-only"`.
- **The never-build firewall (TS-V1).** `karma` is **never** invoked — neither
  the baseline probe nor the post-fix suite. Running karma on a `.ts` would
  transpile it through this project's `ui5-tooling-transpile` / babel config
  (arbitrary in-process code execution); the lane structurally has no karma step.

## Deliberate state

- Pure TypeScript: zero `.js` controllers, zero `.qunit.js` tests — so a
  discovery regression to JS-only enumerates **zero** targets.
- A canonical, clean app — `tsc --noEmit` and `ui5lint` are green out of the box,
  so the lane's outcome is deterministic and the assertions are about the lane,
  not about findings. The `tsconfig.json` adds a `paths` alias for the app's own
  namespace (`e2e/real/ts/*` → `./webapp/*`) so the `.qunit.ts` self-import
  type-checks under standalone `tsc --noEmit`.
- No `karma.conf.js` and no eslint config: the TS lane uses neither (karma is
  firewalled; without a `typescript-eslint`-aware eslint config, `.ts` is left to
  `ui5lint` — the realistic SAP-sample default).

## Install / cost

`node_modules/` (TypeScript + `@openui5/types` + `@ui5/linter` + `@ui5/cli` +
`ui5-tooling-transpile`) is installed lazily on the first `VALIDATOR_E2E_REAL=1`
run by `setup.ts` (hashed `.npm-install-done` marker, idempotent). It is
git-ignored and never committed. The TS run boots **no** browser and downloads
**no** CDN (karma is firewalled), so it is faster and cheaper than the JS run;
its LLM cost is the per-check calls over one controller.
