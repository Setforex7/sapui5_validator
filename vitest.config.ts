import { defineConfig } from 'vitest/config';

// The repo has two opt-in test scopes layered on top of the default suite:
//   VALIDATOR_E2E=1       — Session-6 real-toolchain smoke (test/unit/verify-pipeline.e2e.test.ts).
//                           Gating lives inside that file via describe.skipIf.
//   VALIDATOR_E2E_REAL=1  — V1.1 real-claude + real-linter scope under
//                           test/e2e-real/. Gating is config-level here so the
//                           folder is completely invisible to the default run.
const isE2eReal = process.env['VALIDATOR_E2E_REAL'] === '1';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Nested **/node_modules/** is required because test/fixtures/e2e-real-project/
    // installs real deps on first VALIDATOR_E2E_REAL run, and several of those
    // packages (e.g. yaml-ast-parser) ship their own *.test.ts files that vitest
    // would otherwise collect and fail on.
    exclude: isE2eReal
      ? ['**/node_modules/**', 'dist/**']
      : ['**/node_modules/**', 'dist/**', 'test/e2e-real/**'],
    globalSetup: isE2eReal ? ['test/e2e-real/setup.ts'] : [],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'html'],
    },
  },
});
