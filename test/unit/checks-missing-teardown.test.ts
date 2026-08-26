import { describe, expect, test } from 'vitest';
import { FakeClaudeRunner } from '../../src/claude/fake-runner.js';
import { missingTeardownCheck } from '../../src/checks/missing-teardown.js';
import { createCheckHarness, findingsResponse } from './_check-helpers.js';

describe('missingTeardownCheck', () => {
  test('clean: returns empty', async () => {
    const h = createCheckHarness();
    const path = h.writeFile(
      'webapp/test/unit/controller/Main.controller.qunit.js',
      'QUnit.module("M");',
    );
    const runner = new FakeClaudeRunner([
      { match: /missing-teardown/, response: findingsResponse({ findings: [] }) },
    ]);
    const result = await missingTeardownCheck.run(path, h.makeCtx(runner));
    expect(result.findings).toEqual([]);
  });

  test('positive: flags a QUnit.module without afterEach destroy', async () => {
    const h = createCheckHarness();
    const path = h.writeFile(
      'webapp/test/unit/X.qunit.js',
      'QUnit.module("X", { beforeEach: function () { this.btn = new Button(); } });',
    );
    const runner = new FakeClaudeRunner([
      {
        match: /missing-teardown/,
        response: findingsResponse({
          findings: [
            {
              checkId: 'missing-teardown',
              file: 'webapp/test/unit/X.qunit.js',
              line: 1,
              message: 'no afterEach destroy()',
              proposedFix: { newFileContent: 'fixed' },
            },
          ],
        }),
      },
    ]);
    const result = await missingTeardownCheck.run(path, h.makeCtx(runner));
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.checkId).toBe('missing-teardown');
  });

  test('malformed: schema rejection yields a proposedFix-null finding', async () => {
    const h = createCheckHarness();
    const path = h.writeFile('webapp/test/unit/Y.qunit.js', '// x');
    const runner = new FakeClaudeRunner([
      {
        match: /missing-teardown/,
        // missing required `message` field
        response: findingsResponse({
          findings: [{ checkId: 'missing-teardown', file: 'x', proposedFix: null }],
        }),
      },
    ]);
    const result = await missingTeardownCheck.run(path, h.makeCtx(runner));
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.proposedFix).toBeNull();
    expect(result.findings[0]?.message).toMatch(/malformed output/);
  });

  test('scope is qunit-test', () => {
    expect(missingTeardownCheck.scope).toBe('qunit-test');
  });
});
