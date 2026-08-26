/* eslint-env node */
// Minimal flat ESLint config so the e2e-real fixture is a faithful,
// self-contained SAPUI5 project. Real projects that list `eslint` in
// devDependencies ship a config; without this file the fixture silently
// inherited the validator repo's own eslint.config.js whenever it ran inside
// the repo tree — and broke the moment it was copied to an isolated tmpdir
// sandbox (V1.3-2). Zero rules: eslint genuinely runs and reports nothing, so
// the verify pipeline exercises the real eslint adapter without the config
// itself flagging the fixture's deliberately-seeded files.
module.exports = [
  {
    files: ['webapp/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { sap: 'readonly', QUnit: 'readonly', jQuery: 'readonly' },
    },
    rules: {},
  },
];
