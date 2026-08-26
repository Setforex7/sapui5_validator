# Fixture: minimal-project

A minimum-viable SAPUI5 application used by integration tests. Detected via
**condition 1 of SPEC §2.2** — `ui5.yaml` exists at the root.

## Layout

- `ui5.yaml`, `package.json`, `karma.conf.js` at the root.
- `webapp/` with `manifest.json`, `Component.js`, an i18n bundle, and one
  controller / view pair.
- `webapp/test/` with `testsuite.qunit.html`, a unit suite, and an
  integration suite — enough for `parseTestSuiteHtml` and the karma `files:`
  glob parser to find real entries.

## Deliberate breaks

These are seeded for the V1 semantic checks (SPEC §2.8). Session 5 only
detects them at the project layer; the actual flagging happens in later
sessions.

| File | Check it triggers | What's wrong |
|---|---|---|
| `webapp/controller/Main.controller.js` | `no-direct-dom` (§2.8 #1) | Uses `document.getElementById(...)` instead of `this.byId(...)`. |
| `webapp/view/Main.view.xml` | `missing-i18n` (§2.8 #4) | A `Button` has a hardcoded `text="Submit"` rather than `text="{i18n>submitButton}"`. |
| `webapp/manifest.json` vs `webapp/Component.js` | `manifest-component-drift` (§2.8 #5) | `manifest.json` declares a route `details` whose target/view name is not referenced anywhere in `Component.js` (no setup of routing or models for it). |

## Why these three

They span the three break categories the SPEC's V1 acceptance criterion #5
requires: a controller-level issue, a view-level issue, and a config/code
drift issue. One per category is enough to exercise the validate
end-to-end pipeline without inflating the fixture.
