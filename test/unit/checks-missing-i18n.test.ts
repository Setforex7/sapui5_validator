import { describe, expect, test } from 'vitest';
import { FakeClaudeRunner } from '../../src/claude/fake-runner.js';
import { missingI18nCheck } from '../../src/checks/missing-i18n.js';
import { createCheckHarness, findingsResponse } from './_check-helpers.js';

describe('missingI18nCheck', () => {
  test('clean: no findings', async () => {
    const h = createCheckHarness();
    const path = h.writeFile(
      'webapp/view/Clean.view.xml',
      '<mvc:View xmlns:mvc="sap.ui.core.mvc"></mvc:View>',
    );
    const runner = new FakeClaudeRunner([
      { match: /missing-i18n/, response: findingsResponse({ findings: [] }) },
    ]);
    const result = await missingI18nCheck.run(path, h.makeCtx(runner));
    expect(result.findings).toEqual([]);
  });

  test('positive: flags hardcoded text', async () => {
    const h = createCheckHarness();
    const path = h.writeFile(
      'webapp/view/Main.view.xml',
      '<Button text="Submit"/>',
    );
    const runner = new FakeClaudeRunner([
      {
        match: /missing-i18n/,
        response: findingsResponse({
          findings: [
            {
              checkId: 'missing-i18n',
              file: 'webapp/view/Main.view.xml',
              line: 1,
              message: 'Submit hardcoded',
              proposedFix: { newFileContent: '<Button text="{i18n>submit}"/>' },
            },
          ],
        }),
      },
    ]);
    const result = await missingI18nCheck.run(path, h.makeCtx(runner));
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.checkId).toBe('missing-i18n');
  });

  test('malformed: bad JSON yields proposedFix-null finding', async () => {
    const h = createCheckHarness();
    const path = h.writeFile('webapp/view/Y.view.xml', '<View/>');
    const runner = new FakeClaudeRunner([
      { match: /missing-i18n/, response: { raw: '{ this is broken' } },
    ]);
    const result = await missingI18nCheck.run(path, h.makeCtx(runner));
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.proposedFix).toBeNull();
  });

  test('scope is view-xml', () => {
    expect(missingI18nCheck.scope).toBe('view-xml');
  });
});
