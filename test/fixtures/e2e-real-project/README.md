# Fixture: e2e-real-project

A real SAPUI5 1.120 application used by **VALIDATOR_E2E_REAL=1** tests
(see [test/e2e-real/](../../e2e-real/README.md)). Unlike `minimal-project`,
the dependencies in `package.json` are not mocked: a real `npm install`
runs on first E2E execution via `test/e2e-real/setup.ts`, and the
resulting `node_modules/.bin/ui5lint`, `node_modules/.bin/eslint`, and
`node_modules/.bin/karma` are invoked by the validator under test.

Detected by sapui5-validator via **condition 1 of [SPEC.md](../../../SPEC.md) §2.2** —
`ui5.yaml` at the root.

## Layout

- `ui5.yaml`, `package.json`, `karma.conf.js` at the root.
- `webapp/` with `manifest.json`, `Component.js`, `i18n/i18n.properties`, and
  three view/controller pairs (`App`, `Main`, `Details`, `Settings`).
- `webapp/test/` with `testsuite.qunit.html`, a unit suite, and one trivial
  passing QUnit test for the `Main` controller, so karma has something
  real to execute.
- `karma.conf.js` defaults to `ChromeHeadless`. Set `KARMA_NO_SANDBOX=1`
  for CI environments where headless Chrome cannot sandbox (Docker as
  root, restricted runners) — that flips it to `ChromeHeadlessNoSandbox`
  which adds `--no-sandbox --disable-gpu --disable-dev-shm-usage`.

## Why dependencies are NOT installed at commit time

The `node_modules/` directory is heavy (>100MB for karma + chrome
launcher) and the fixture is only useful when `VALIDATOR_E2E_REAL=1` is
set. The `test/e2e-real/setup.ts` script lazy-installs on first E2E run
and stamps a `.npm-install-done` marker so subsequent runs skip the
install when the marker's hash matches the current `package.json`.

## Seeded breaks

These are deliberate. Each one is what a real SAPUI5 codebase looks like
when the corresponding semantic check (SPEC §2.8) needs to fire. The
documentation here is **mandatory** — without it the next person to
read this fixture has no way to distinguish "intentionally broken" from
"shipped a bug into a test fixture", which is exactly the trap V1
fixtures fell into.

### 1. `no-direct-dom` — `webapp/controller/Main.controller.js` (`onPress`)

The button-press handler reaches into the DOM with
`document.getElementById("__xmlview0--submitBtn")` and sets a
`data-pressed` attribute. The SAPUI5-idiomatic approach is
`this.byId("saveBtn")`, which returns the framework-managed control
without coupling to the auto-generated XML view prefix.

This pattern occurs in real codebases when a developer wants to "just
get the element" and forgets that SAPUI5 renders the same control multiple
times during async navigation, so the static id becomes stale. The
**no-direct-dom** check (SPEC §2.8 #1) detects calls to
`document.getElementById`, `document.querySelector`, and `$(...)` inside
controllers.

### 2. `missing-teardown` — `webapp/controller/Main.controller.js` (`onInit`)

`onInit` calls `sap.ui.getCore().getEventBus().subscribe("navigation",
"refresh", this._onNavigationRefresh, this)`. There is no `onExit` method
on the controller, so when the view containing it is destroyed
(SAPUI5 navigation creates and disposes views routinely), the EventBus
still holds a reference to the controller's bound handler. The handler
keeps the entire view alive in memory — a classic SAPUI5 memory leak.

The **missing-teardown** check (SPEC §2.8 #3) flags `EventBus.subscribe`,
`addEventListener`, `attachBrowserEvent`, and timer subscriptions in
`onInit`/`onBeforeRendering` that are not balanced by a corresponding
unsubscribe/cleanup in `onExit`.

### 3. Unhandled Promise rejection — `webapp/controller/Main.controller.js` (`onLoadData` / `_fetchData`)

`onLoadData` (a button-press handler, which cannot be `async` itself
without losing the SAPUI5 event-handler contract) calls `this._fetchData()`
without `await`, without a `.catch`, and without storing the returned
promise. `_fetchData` is `async` and can reject from `fetch` failing or
from the `!oResponse.ok` branch throwing.

This is the most common surface for unhandled rejections in real SAPUI5
code: a sync event handler firing an async data load and dropping the
promise. It survives unit tests because the test framework awaits a
specific promise; it surfaces in production as
`UnhandledPromiseRejectionWarning` in karma test runs and as silent UX
breakage in the browser.

The `no-direct-dom` and `missing-teardown` checks both exist today in
V1; the unhandled-promise pattern is detected by the `no-sync-odata`
check's "fire-and-forget" sibling pattern and serves as a third break
to widen the surface area exercised by the E2E suite. If V1.1 does not
end up flagging this one, the pattern still belongs in the fixture so
V1.2 can target it without a fixture change.

### 4. `missing-i18n` — `webapp/view/Main.view.xml`

The "Save" button is declared as `text="Save"` rather than
`text="{i18n>save}"`. The `webapp/i18n/i18n.properties` file is
**deliberately missing** a `save=` entry to make sure the issue is not
just a binding typo — the underlying problem is that the user-visible
string was authored inline, never made it into the bundle, and would
not be translatable.

The **missing-i18n** check (SPEC §2.8 #4) flags hardcoded user-visible
strings in views: `text=`, `title=`, `placeholder=`, `tooltip=`,
`description=` attributes whose value is a literal and not an i18n
binding expression.

## What is NOT seeded here

The fixture is not exhaustive — it does not exercise every V1 check.
Specifically, `no-sync-odata`, `manifest-component-drift`,
`globals-in-views`, and `missing-coverage` are exercised by the existing
fake-runner unit/integration suites, where the cost of broad coverage
is zero. The E2E real fixture is deliberately narrow: each seeded
break must be worth a real LLM call (~$0.01-$0.05) and a real
ui5lint/eslint/karma invocation per test run.
