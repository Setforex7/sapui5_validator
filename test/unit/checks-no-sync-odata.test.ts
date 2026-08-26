import { describe, expect, test } from 'vitest';
import { FakeClaudeRunner } from '../../src/claude/fake-runner.js';
import { noSyncOdataCheck } from '../../src/checks/no-sync-odata.js';
import { createCheckHarness, findingsResponse } from './_check-helpers.js';

describe('noSyncOdataCheck', () => {
  test('clean: empty findings array', async () => {
    const h = createCheckHarness();
    const path = h.writeFile('webapp/controller/Main.controller.js', '// clean');
    const runner = new FakeClaudeRunner([
      { match: /no-sync-odata/, response: findingsResponse({ findings: [] }) },
    ]);
    const result = await noSyncOdataCheck.run(path, h.makeCtx(runner));
    expect(result.findings).toEqual([]);
  });

  test('positive: flags async: false on a model option', async () => {
    const h = createCheckHarness();
    const path = h.writeFile(
      'webapp/controller/Main.controller.js',
      'oModel.loadData("/p", null, false);',
    );
    const runner = new FakeClaudeRunner([
      {
        match: /no-sync-odata/,
        response: findingsResponse({
          findings: [
            {
              checkId: 'no-sync-odata',
              file: 'webapp/controller/Main.controller.js',
              line: 1,
              message: 'sync loadData',
              proposedFix: { newFileContent: 'async fixed' },
            },
          ],
        }),
      },
    ]);
    const result = await noSyncOdataCheck.run(path, h.makeCtx(runner));
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.checkId).toBe('no-sync-odata');
  });

  test('malformed: invalid JSON yields a proposedFix-null finding', async () => {
    const h = createCheckHarness();
    const path = h.writeFile('webapp/controller/Main.controller.js', '// x');
    const runner = new FakeClaudeRunner([
      { match: /no-sync-odata/, response: { raw: 'not-json' } },
    ]);
    const result = await noSyncOdataCheck.run(path, h.makeCtx(runner));
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.proposedFix).toBeNull();
  });
});
