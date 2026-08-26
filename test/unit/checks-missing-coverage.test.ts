import { describe, expect, test } from 'vitest';
import { CallBudget } from '../../src/claude/budget.js';
import { createCapState } from '../../src/budget/cap.js';
import { FakeClaudeRunner } from '../../src/claude/fake-runner.js';
import {
  expectedTestPath,
  missingTestCoverageCheck,
} from '../../src/checks/missing-test-coverage.js';
import { FALLBACK_LAYOUT, type TestLayout } from '../../src/project/test-layout.js';
import { createCheckHarness, findingsResponse } from './_check-helpers.js';

describe('expectedTestPath', () => {
  test('maps controller path to unit test path with .qunit.js suffix', () => {
    expect(expectedTestPath('webapp/controller/Main.controller.js')).toBe(
      'webapp/test/unit/controller/Main.controller.qunit.js',
    );
  });
  test('handles helper files outside the controller folder', () => {
    expect(expectedTestPath('webapp/helper/Formatter.js')).toBe(
      'webapp/test/unit/helper/Formatter.qunit.js',
    );
  });

  test('GA1-06 — a TS controller maps to .controller.qunit.ts', () => {
    // Fail-on-revert: the `.js`-only regex was a no-op on a `.ts` path, leaving
    // `App.controller.ts` as the "test" path → a false "missing test" finding.
    expect(expectedTestPath('webapp/controller/App.controller.ts')).toBe(
      'webapp/test/unit/controller/App.controller.qunit.ts',
    );
  });

  test('GA1-06 — TS test-path honours a non-fallback qunit root', () => {
    expect(expectedTestPath('webapp/controller/App.controller.ts', 'custom/qunit')).toBe(
      'custom/qunit/controller/App.controller.qunit.ts',
    );
  });
});

describe('missingTestCoverageCheck', () => {
  test('clean: empty findings when LLM reports all methods covered', async () => {
    const h = createCheckHarness();
    const ctrl = h.writeFile(
      'webapp/controller/Main.controller.js',
      'sap.ui.define([], function () { return { onInit: function () {} }; });',
    );
    h.writeFile(
      'webapp/test/unit/controller/Main.controller.qunit.js',
      'QUnit.test("onInit", function () {});',
    );
    const runner = new FakeClaudeRunner([
      { match: /missing-test-coverage/, response: findingsResponse({ findings: [] }) },
    ]);
    const result = await missingTestCoverageCheck.run(ctrl, h.makeCtx(runner));
    expect(result.findings).toEqual([]);
  });

  test('positive: returns manual-only finding (proposedFix null + explanation)', async () => {
    const h = createCheckHarness();
    const ctrl = h.writeFile(
      'webapp/controller/Main.controller.js',
      'sap.ui.define([], function () { return { onSubmit: function () {} }; });',
    );
    const runner = new FakeClaudeRunner([
      {
        match: /missing-test-coverage/,
        response: findingsResponse({
          findings: [
            {
              checkId: 'missing-test-coverage',
              file: 'webapp/controller/Main.controller.js',
              line: 1,
              message: 'onSubmit has no test',
              proposedFix: null,
              explanation: 'Add QUnit.test("onSubmit", ...) asserting the submit flow.',
            },
          ],
        }),
      },
    ]);
    const result = await missingTestCoverageCheck.run(ctrl, h.makeCtx(runner));
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.proposedFix).toBeNull();
  });

  test('prompt reflects whether the expected test file exists', async () => {
    const h = createCheckHarness();
    const ctrl = h.writeFile(
      'webapp/controller/NoTest.controller.js',
      'sap.ui.define([], function () { return {}; });',
    );
    const runner = new FakeClaudeRunner([
      { match: /missing-test-coverage/, response: findingsResponse({ findings: [] }) },
    ]);
    await missingTestCoverageCheck.run(ctrl, h.makeCtx(runner));
    const prompt = runner.calls[0]!.prompt;
    expect(prompt).toContain('No test file exists at webapp/test/unit/controller/NoTest.controller.qunit.js');
  });

  test('malformed: schema rejection yields proposedFix-null finding', async () => {
    const h = createCheckHarness();
    const ctrl = h.writeFile('webapp/controller/M.controller.js', '// x');
    const runner = new FakeClaudeRunner([
      {
        match: /missing-test-coverage/,
        // auto-fixable proposal not allowed for manual-only mode
        response: findingsResponse({
          findings: [
            {
              checkId: 'missing-test-coverage',
              file: 'webapp/controller/M.controller.js',
              message: 'x',
              proposedFix: { newFileContent: 'forbidden' },
            },
          ],
        }),
      },
    ]);
    const result = await missingTestCoverageCheck.run(ctrl, h.makeCtx(runner));
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.proposedFix).toBeNull();
    expect(result.findings[0]?.message).toMatch(/malformed output/);
  });

  test('scope is controller-js', () => {
    expect(missingTestCoverageCheck.scope).toBe('controller-js');
  });

  test('uses ctx.testLayout to resolve a non-fallback test root in the prompt', async () => {
    const h = createCheckHarness();
    const ctrl = h.writeFile(
      'webapp/controller/Main.controller.js',
      'sap.ui.define([], function () { return { onInit: function () {} }; });',
    );
    const layout: TestLayout = {
      inferredFrom: 'config',
      fallback: FALLBACK_LAYOUT,
      karma: {
        path: '/abs/karma.conf.js',
        testFileGlobs: ['custom/qunit/**/*.qunit.js'],
      },
    };
    const runner = new FakeClaudeRunner([
      { match: /missing-test-coverage/, response: findingsResponse({ findings: [] }) },
    ]);
    const ctx = {
      projectRoot: h.projectRoot,
      runner,
      budget: new CallBudget({ maxCalls: 5 }),
      testLayout: layout,
      capState: createCapState(100, 5), // COR-7: required, no-bind
    };
    await missingTestCoverageCheck.run(ctrl, ctx);
    const prompt = runner.calls[0]!.prompt;
    expect(prompt).toContain(
      'No test file exists at custom/qunit/controller/Main.controller.qunit.js',
    );
    // Default fallback path is NOT in the prompt when layout overrides it.
    expect(prompt).not.toContain('webapp/test/unit/controller/Main.controller.qunit.js');
  });
});
