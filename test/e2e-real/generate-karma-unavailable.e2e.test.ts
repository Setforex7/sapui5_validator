/**
 * V1.3-2 — karma-unavailable witness for the `generate` command.
 *
 * The sandbox overwrites `karma.conf.js` with a config whose browser launcher
 * (`Bogus`) is not registered, so `karma start` aborts during bootstrap with
 * "Cannot load browser 'Bogus'" before any test runs — the "karma installed
 * but not runnable" failure mode from V1.3-DIAGNOSIS Area 6.
 *
 * Contract V1.3-5 + V1.3-6 must satisfy: a broken karma runner is classified
 * distinctly from a red test, and the unconditional baseline karma probe
 * (V1.3-6) fails fast on `karma-unavailable` *before any LLM call* — even for
 * a single-controller scope where today's conditional probe is skipped.
 *
 * On `master` the broken runner is not detected until verify time: with a
 * single-controller scope the baseline karma probe is skipped, so `generate`
 * proceeds, burns three LLM refinement attempts on a sound test against the
 * dead runner, and quarantines it (`unfixed-findings`, `llmCallCount > 0`).
 * Both witness assertions below therefore fail on `master`.
 */
import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  E2E_REAL_ENABLED,
  createGenerateSandbox,
  type CliRunResult,
  type GenerateSandbox,
} from './_shared.js';

const RUN_TIMEOUT_MS = 12 * 60_000;

/**
 * A deliberately broken karma config. `Bogus` is not a registered launcher,
 * so `karma start` aborts during bootstrap before executing any test.
 */
const BROKEN_KARMA_CONF = `/* eslint-env node */
// Seeded by generate-karma-unavailable.e2e.test.ts (V1.3-2). 'Bogus' is not a
// registered browser launcher, so \`karma start\` aborts during bootstrap with
// "Cannot load browser 'Bogus'" before any test executes.
module.exports = function (config) {
  config.set({
    frameworks: ['ui5'],
    ui5: { url: 'https://sdk.openui5.org' },
    browsers: ['Bogus'],
    reporters: ['progress'],
    singleRun: true,
    autoWatch: false,
  });
};
`;

let sandbox: GenerateSandbox | null = null;
let runResult: CliRunResult | null = null;

beforeAll(async () => {
  if (!E2E_REAL_ENABLED) return;
  sandbox = createGenerateSandbox('sapui5-gen-karmadead-');
  writeFileSync(sandbox.path('karma.conf.js'), BROKEN_KARMA_CONF, 'utf8');
  runResult = await sandbox.run([
    'generate',
    'webapp/controller/App.controller.js',
    '--qunit-only',
    '--force',
  ]);
}, RUN_TIMEOUT_MS);

afterAll(() => {
  sandbox?.remove();
  sandbox = null;
  runResult = null;
});

describe.skipIf(!E2E_REAL_ENABLED)('V1.3-2 — generate fails fast on an unrunnable karma', () => {
  test('exits with the karma-unavailable reason (V1.3-5 classification)', () => {
    if (sandbox === null || runResult === null) throw new Error('run did not execute');
    expect(sandbox.reportExists(), 'report.json not written').toBe(true);
    const report = sandbox.readReport();
    expect(
      report.exitReason.kind,
      `expected exitReason 'karma-unavailable' for a broken karma runner; ` +
        `got '${report.exitReason.kind}'. On master a broken runner is ` +
        `absorbed into a per-test verification failure.`,
    ).toBe('karma-unavailable');
  });

  test('fails fast before any LLM call (V1.3-6 unconditional baseline probe)', () => {
    if (sandbox === null) throw new Error('sandbox not initialised');
    const report = sandbox.readReport();
    expect(
      report.llmCallCount,
      `expected 0 LLM calls — the unconditional baseline karma probe must ` +
        `detect the dead runner before candidate discovery. On master the ` +
        `probe is skipped for a single-controller scope, so calls are burnt.`,
    ).toBe(0);
  });
});
