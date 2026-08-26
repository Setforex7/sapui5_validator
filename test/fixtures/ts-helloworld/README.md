# Fixture: ts-helloworld

A minimal **TypeScript-SAPUI5** application mirroring SAP's
`ui5-typescript-helloworld` shape (ES `import` + `export default class extends
Controller` + JSDoc `@namespace`). Fully offline; no installed deps.

## What it exercises (V1.9 Phase 0)

- **TS-DETECT** — `detectProjectLanguage` must classify this as `'ts'` (it has
  non-`.d.ts` `.ts` sources under `webapp/`, plus a `tsconfig.json` and a
  `ui5-tooling-transpile` task in `ui5.yaml`).
- **TS-aware discovery (GA1-01/04)** — the discovery layer must enumerate the
  `.ts` controller (`webapp/controller/App.controller.ts`) and the `.qunit.ts`
  test (`webapp/test/unit/controller/App.controller.qunit.ts`), while excluding
  `webapp/Component.ts` (entrypoint) and `webapp/env.d.ts` (ambient
  declaration).
- **HB-2 fail-on-revert** — this project is **pure TS**: it ships zero `.js`
  controllers and zero `.qunit.js` tests. So if discovery is reverted to
  JS-only, it enumerates **zero** targets and the `HB-2` guarantee test goes
  red. That is the point — a validation tool must never silently report "clean"
  on a project it did not scan.

## Not the e2e-real fixture

This is a static fixture for **unit/integration** detection + discovery tests
(no installed deps; offline). The real-toolchain TS e2e fixture — installed
deps, `tsc`/`ui5lint` actually invoked — is
[`e2e-real-ts-project`](../e2e-real-ts-project/README.md) (V1.9 Phase 4).

## Runtime status (shipped — V1.9 Phase 2)

End-to-end `validate` on this project now **proceeds**: it is detected as
TypeScript, discovery enumerates the `.ts` controller + `.qunit.ts` test, the
seven checks run over the `.ts` source, and fixes are verified by the
**static-only** lane (`ui5lint` + `tsc --noEmit` + config-gated `eslint`) —
never karma (the TS-V1 never-build firewall). The run reports
`verification: "static-only"`. `generate` still **refuses** with the SPEC §2.5
message (`generate`-for-TS is the 1.1 cycle). The Phase-0 end-to-end refusal
described in earlier revisions of this file is historical.
