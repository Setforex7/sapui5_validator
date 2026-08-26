# Fixture: dirty-baseline

A SAPUI5 application with **pre-existing lint failures**. Detected via
condition 1 of SPEC §2.2.

Used to exercise:

- `validate` baseline policy (SPEC §2.3): `validate` should attempt to fix
  the baseline issues with the LLM, same retry budget; exit 0 only if
  resolved (strict). Wired in a later session.
- `generate` baseline refusal (SPEC §2.3): `generate` must refuse to run
  while baseline lint is red and exit non-zero.

> Note: this is a *baseline-of-the-source* fixture. The git working tree
> itself is **clean** in this checkout — the dirty-tree gate in SPEC §2.6
> is a separate concern and is exercised at runtime against any working
> copy, not from a static fixture.

## Deliberate breaks

| File | Why it's "dirty" |
|---|---|
| `webapp/controller/Broken.controller.js` | Declares an unused variable, references an undefined identifier, and uses `var` where `let`/`const` would be expected — flagged by a default eslint config and by ui5lint conventions. |
