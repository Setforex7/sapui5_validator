/**
 * V1.9 Phase 4 (REL-1.0) — the real-toolchain TypeScript-SAPUI5 witness.
 *
 * `setup.ts` runs one `sapui5-validate validate --all --force` against the
 * installed `test/fixtures/e2e-real-ts-project/` (a real TS-SAPUI5 app: ES
 * `import` + `class`, `tsconfig.json`, `@openui5/types`, a `.qunit.ts`). This
 * file asserts — against the persisted artifacts and against the real project
 * binaries — that a TypeScript `validate` run:
 *
 *   1. DETECTS TypeScript and PROCEEDS (not the pre-Phase-2 `typescript-project`
 *      refusal); the report carries `verification: "static-only"` — no silent
 *      "clean".
 *   2. Runs TS-aware DISCOVERY (HB-2): the `.ts` controller is enumerated and a
 *      TS-framed check prompt (` ```typescript ` fence + the `.ts` source)
 *      actually reaches the model — proven from the persisted prompt audit.
 *   3. Takes the STATIC-ONLY lane with the project's REAL binaries: `tsc --noEmit`
 *      and `ui5lint` are invoked over the `.ts` source (direct-adapter witnesses
 *      below, deterministic — no LLM, no karma).
 *   4. NEVER invokes karma — neither the baseline probe nor the post-fix suite.
 *      Karma-running a `.ts` would transpile it through the project's own
 *      `ui5-tooling-transpile` / babel config = arbitrary in-process code
 *      execution (the TS-V1 never-build firewall). Asserted from the absence of
 *      any karma verify artifact and from `postFixSuite` never being
 *      `passed`/`failed` (both of which require karma to have run).
 *
 * The integration test `test/integration/ts-validate-refusal.test.ts` already
 * pins the firewall STRUCTURALLY with counting fake adapters (a TS run's karma
 * call count is exactly 0); this file is the REAL-binary counterpart.
 */

import { describe, expect, test } from 'vitest';
import {
  E2E_REAL_ENABLED,
  TS_PATHS,
  concatDirFiles,
  listDir,
  readTsReport,
  tsReportExists,
} from './_shared.js';
import { runTsc } from '../../src/verify/tsc.js';
import { runUi5Lint } from '../../src/verify/ui5lint.js';

const ABS_PATH_DIAGNOSTIC = "Pattern must be relative to project's root folder";
const TS_CONTROLLER_REL = 'webapp/controller/App.controller.ts';

// `tsc --noEmit` and `ui5lint` each rebuild the whole project type model on a
// cold run (and load `@openui5/types`), so they comfortably exceed vitest's 5 s
// default. Give the direct-adapter witnesses a ceiling matching the adapters'
// own per-subprocess timeout (5 min, DEP-3/HB-3) plus margin — a genuine hang
// is still caught by the adapter returning `exitCode: -1`, which the assertions
// below reject.
const TOOL_TEST_TIMEOUT_MS = 6 * 60_000;

describe.skipIf(!E2E_REAL_ENABLED)('V1.9 — TypeScript validate run takes the static-only lane', () => {
  test('detected TS and PROCEEDED — report carries verification "static-only", not a refusal', () => {
    expect(
      tsReportExists(),
      'TS report.json not produced — see e2e-real setup.ts output for the TS fixture run',
    ).toBe(true);

    const report = readTsReport();
    expect(report.command).toBe('validate');
    // It PROCEEDED end-to-end — not the pre-Phase-2 honest refusal.
    expect(report.exitReason.kind).not.toBe('typescript-project');
    expect(report.exitReason.kind).not.toBe('not-sapui5-project');
    // The never-build firewall marker: the test suite was NOT executed for TS.
    // No silent "clean" — the report states the verification depth.
    expect(report.verification).toBe('static-only');
  });

  test('TS-aware discovery (HB-2): a TS-framed check prompt reached the model', () => {
    expect(tsReportExists(), 'TS report.json not produced').toBe(true);

    const report = readTsReport();
    // Checks dispatched over the discovered `.ts` target(s) — a JS-only
    // discovery regression would enumerate ZERO targets and make NO LLM calls.
    expect(
      report.llmCallCount,
      'expected a non-zero LLM call count — TS-aware discovery must enumerate the .ts controller (HB-2)',
    ).toBeGreaterThan(0);

    const prompts = concatDirFiles(TS_PATHS.promptsDir);
    // GA1-10 — a TS controller is fenced ` ```typescript `, never ` ```javascript `.
    expect(
      prompts.includes('```typescript'),
      'no TS-fenced (```typescript) prompt found — GA1-10 framing did not reach the model',
    ).toBe(true);
    // The `.ts` controller's actual ES-module/class source made it into a prompt
    // — proof the `.ts` file was discovered and handed to a check (not skipped).
    expect(
      prompts.includes('export default class App'),
      'the .ts controller source was not embedded in any prompt — discovery did not enumerate it',
    ).toBe(true);
  });

  test('THE FIREWALL: karma was never invoked for the TS run', () => {
    expect(tsReportExists(), 'TS report.json not produced').toBe(true);

    const report = readTsReport();
    // The post-fix suite gate is karma. For a TS run it is gated off entirely:
    // it is either absent (no fixes applied) or recorded `not-run` with the
    // static-only reason. It must NEVER be `passed`/`failed` — both require
    // karma to have executed.
    if (report.postFixSuite !== undefined) {
      expect(
        report.postFixSuite.status,
        `postFixSuite.status must be 'not-run' on a TS run (karma is firewalled); ` +
          `got '${report.postFixSuite.status}' (reason: ${report.postFixSuite.reason ?? 'n/a'})`,
      ).toBe('not-run');
    }

    // No karma verify artifact was written. The JS path writes
    // `<callId>-karma.txt` dumps under last-run/verify/; a TS run writes none
    // because the karma step never runs.
    const verifyArtifacts = listDir(TS_PATHS.verifyDir);
    const karmaArtifacts = verifyArtifacts.filter((name) => name.toLowerCase().includes('karma'));
    expect(
      karmaArtifacts,
      `expected zero karma verify artifacts on the TS run; found: ${JSON.stringify(karmaArtifacts)}`,
    ).toEqual([]);
  });
});

describe.skipIf(!E2E_REAL_ENABLED)('V1.9 — the static-only lane runs the project\'s REAL tsc + ui5lint over .ts', () => {
  test('the project\'s real `tsc --noEmit` is invoked and the clean fixture type-checks green', async () => {
    const res = await runTsc({ projectRoot: TS_PATHS.fixture });
    // exitCode -1 means spawn/timeout failure (tsc never really ran). A real run
    // returns 0 (clean) or a positive code (type errors). The canonical fixture
    // is type-clean, so it must be 0 — and that proves the project-local tsc was
    // resolved (preferLocal) and executed over the .ts sources.
    expect(
      res.exitCode,
      `tsc did not spawn (exitCode -1). stderr:\n${res.stderr}`,
    ).not.toBe(-1);
    expect(
      res.ok,
      `expected the clean TS fixture to type-check green.\n` +
        `exitCode=${res.exitCode}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
    ).toBe(true);
  }, TOOL_TEST_TIMEOUT_MS);

  test('the project\'s real `ui5lint` is invoked over the `.ts` controller', async () => {
    const res = await runUi5Lint({ projectRoot: TS_PATHS.fixture, file: TS_CONTROLLER_REL });
    // -1 = spawn/timeout (never ran); >=0 = a real ui5lint exit (0 clean, >0
    // findings). Either real exit proves ui5lint actually linted the `.ts`.
    expect(
      res.exitCode,
      `ui5lint did not spawn (exitCode -1). stderr:\n${res.stderr}`,
    ).not.toBe(-1);
    // ui5lint lints `.ts` natively (diagnosis §1.2) — it must NOT reject the
    // path the way it rejects absolute paths, and must not parse-error on TS.
    const blob = `${res.stdout}\n${res.stderr}`;
    expect(
      blob.includes(ABS_PATH_DIAGNOSTIC),
      `ui5lint emitted the absolute-path diagnostic for a project-relative .ts path:\n${blob.slice(0, 400)}`,
    ).toBe(false);
  }, TOOL_TEST_TIMEOUT_MS);
});
