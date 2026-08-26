# Fixture: ts-project

A TypeScript-based SAPUI5 application. Used to assert the V1.9 Phase-2
**command-routed flip** in `checkTsGuard` (SPEC §2.5): on a TypeScript project,
`validate` **proceeds** (`ok`, `language: 'ts'`) while `generate` **still
refuses** with the verbatim message:

> TypeScript SAPUI5 support is planned for V2.

(`generate`-for-TS — the LLM emitting `.ts` tests — is deferred to the 1.1
cycle.) See `test/unit/ts-guard.test.ts`.

## Detection vs. routing

This fixture is detected as a SAPUI5 project via **condition 2 of SPEC §2.2**
(no `ui5.yaml`, but `webapp/manifest.json` has `sap.app.type === "application"`
and `webapp/Component.ts` exists). That demonstrates the detect → ts-guard
ordering: detect first accepts the project, then the guard routes by command —
`validate` into the TS-aware discovery + static-only verify lane, `generate`
into the honest refusal.

## Deliberate state

- `webapp/Component.ts` and `webapp/controller/App.controller.ts` exist.
- No `webapp/Component.js` — the project is intentionally pure-TypeScript.
