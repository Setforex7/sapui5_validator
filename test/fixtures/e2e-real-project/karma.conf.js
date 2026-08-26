/* eslint-env node */

// Karma config for the e2e-real-project fixture.
//
// Uses karma-ui5 against the public OpenUI5/SAPUI5 SDK so we don't need to
// vendor UI5 resources locally. `ChromeHeadless` is the default; in CI
// environments without a sandboxed Chrome (e.g. Docker-as-root, some
// hosted runners) it tends to fail with `crashed: no usable sandbox`.
// For those environments switch `browsers: ['ChromeHeadless']` to
// `browsers: ['ChromeHeadlessNoSandbox']` (defined below) by setting the
// KARMA_NO_SANDBOX=1 env var.
module.exports = function (config) {
  const noSandbox = process.env.KARMA_NO_SANDBOX === '1';

  config.set({
    // karma-ui5 in "html" mode (default) supports QUnit out of the box —
    // listing 'qunit' here is rejected with "not compatible with certain
    // framework plugins". Keep 'ui5' as the only framework entry.
    frameworks: ['ui5'],
    ui5: {
      url: 'https://sdk.openui5.org',
    },
    browsers: [noSandbox ? 'ChromeHeadlessNoSandbox' : 'ChromeHeadless'],
    customLaunchers: {
      ChromeHeadlessNoSandbox: {
        base: 'ChromeHeadless',
        flags: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
      },
    },
    reporters: ['progress'],
    singleRun: true,
    autoWatch: false,
    // karma-ui5 in "html" mode discovers tests via webapp/test/testsuite.qunit.html
    // and forbids any custom `files:` config — leave it unset.
  });
};
