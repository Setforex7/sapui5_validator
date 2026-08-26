# Fixture: no-tests-project

A minimal SAPUI5 application with **no test directory and no karma config**.
Detected via condition 1 of SPEC §2.2 (`ui5.yaml` present).

Used to exercise:

- `generate` no-tests interactive prompt path (SPEC §2.4) — not yet wired in
  Session 5.
- Test-layout detection fallback (SPEC §2.7) — should report
  `inferredFrom: 'fallback'`.
- Tooling probe missing-karma case — `karma` is not in `package.json`, so
  the probe should classify it `required` and `missing`.

## Deliberate state

- No `webapp/test/` at all.
- No `karma.conf.js`.
- `package.json` lists no test runner — this is the "no tests" baseline,
  not a "broken tests" one (compare with `dirty-baseline`).
