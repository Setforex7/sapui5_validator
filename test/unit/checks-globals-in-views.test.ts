import { describe, expect, test } from 'vitest';
import { FakeClaudeRunner } from '../../src/claude/fake-runner.js';
import { globalsInViewsCheck } from '../../src/checks/globals-in-views.js';
import { createCheckHarness, findingsResponse } from './_check-helpers.js';

const VIEW_WITH_CONTROLLER = `
<mvc:View controllerName="x.controller.Main" xmlns="sap.m" xmlns:mvc="sap.ui.core.mvc">
  <Button press=".onClick" />
</mvc:View>
`.trim();

const CONTROLLER = `
sap.ui.define([], function () {
  return { onClick: function () {} };
});
`.trim();

describe('globalsInViewsCheck', () => {
  test('clean: no findings, paired controller embedded in prompt', async () => {
    const h = createCheckHarness();
    h.writeFile('webapp/controller/Main.controller.js', CONTROLLER);
    const viewPath = h.writeFile('webapp/view/Main.view.xml', VIEW_WITH_CONTROLLER);
    const runner = new FakeClaudeRunner([
      { match: /globals-in-views/, response: findingsResponse({ findings: [] }) },
    ]);
    const result = await globalsInViewsCheck.run(viewPath, h.makeCtx(runner));
    expect(result.findings).toEqual([]);
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]!.prompt).toContain('Paired controller: webapp/controller/Main.controller.js');
  });

  test('positive: returns a finding (auto-fix or manual both allowed)', async () => {
    const h = createCheckHarness();
    h.writeFile('webapp/controller/Main.controller.js', CONTROLLER);
    const viewPath = h.writeFile('webapp/view/Main.view.xml', VIEW_WITH_CONTROLLER);
    const runner = new FakeClaudeRunner([
      {
        match: /globals-in-views/,
        response: findingsResponse({
          findings: [
            {
              checkId: 'globals-in-views',
              file: 'webapp/view/Main.view.xml',
              line: 2,
              message: 'press handler missing on controller',
              proposedFix: null,
              explanation: 'handler must be added to the controller; fix needs both files.',
            },
          ],
        }),
      },
    ]);
    const result = await globalsInViewsCheck.run(viewPath, h.makeCtx(runner));
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.checkId).toBe('globals-in-views');
  });

  test('COR-6: a NESTED controller is still embedded in the prompt', async () => {
    // Pre-COR-6 `findPairedController` kept only the last segment and looked at
    // `webapp/controller/Main.controller.js` — so a nested controller resolved
    // to "No paired controller". The layout-aware resolver finds it.
    const h = createCheckHarness();
    h.writeFile('webapp/controller/sub/Main.controller.js', CONTROLLER);
    const viewPath = h.writeFile(
      'webapp/view/Main.view.xml',
      '<mvc:View controllerName="x.controller.sub.Main" xmlns:mvc="sap.ui.core.mvc"><Button press=".onClick"/></mvc:View>',
    );
    const runner = new FakeClaudeRunner([
      { match: /globals-in-views/, response: findingsResponse({ findings: [] }) },
    ]);
    await globalsInViewsCheck.run(viewPath, h.makeCtx(runner));
    expect(runner.calls[0]!.prompt).toContain(
      'Paired controller: webapp/controller/sub/Main.controller.js',
    );
  });

  test('missing paired controller: prompt notes the absence', async () => {
    const h = createCheckHarness();
    const viewPath = h.writeFile(
      'webapp/view/Orphan.view.xml',
      '<mvc:View xmlns:mvc="sap.ui.core.mvc"><Button text="x"/></mvc:View>',
    );
    const runner = new FakeClaudeRunner([
      { match: /globals-in-views/, response: findingsResponse({ findings: [] }) },
    ]);
    await globalsInViewsCheck.run(viewPath, h.makeCtx(runner));
    expect(runner.calls[0]!.prompt).toContain('No paired controller');
  });

  test('malformed: yields a proposedFix-null finding', async () => {
    const h = createCheckHarness();
    const viewPath = h.writeFile('webapp/view/X.view.xml', '<View/>');
    const runner = new FakeClaudeRunner([
      { match: /globals-in-views/, response: { raw: '"hello"' } },
    ]);
    const result = await globalsInViewsCheck.run(viewPath, h.makeCtx(runner));
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.proposedFix).toBeNull();
  });

  test('scope is view-xml', () => {
    expect(globalsInViewsCheck.scope).toBe('view-xml');
  });
});
