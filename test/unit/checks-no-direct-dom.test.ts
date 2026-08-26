import { describe, expect, test } from 'vitest';
import { FakeClaudeRunner } from '../../src/claude/fake-runner.js';
import { noDirectDomCheck } from '../../src/checks/no-direct-dom.js';
import { createCheckHarness, findingsResponse } from './_check-helpers.js';

describe('noDirectDomCheck', () => {
  test('clean: empty findings array passes through', async () => {
    const h = createCheckHarness();
    const path = h.writeFile(
      'webapp/controller/Clean.controller.js',
      'sap.ui.define([], function () { "use strict"; return {}; });',
    );
    const runner = new FakeClaudeRunner([
      { match: /no-direct-dom/, response: findingsResponse({ findings: [] }) },
    ]);
    const result = await noDirectDomCheck.run(path, h.makeCtx(runner));
    expect(result.findings).toEqual([]);
    expect(runner.calls).toHaveLength(1);
  });

  test('positive: one finding with proposedFix flows through and is pinned to the file', async () => {
    const h = createCheckHarness();
    const path = h.writeFile(
      'webapp/controller/Main.controller.js',
      'sap.ui.define([], function () { return { onInit: function () { document.getElementById("x"); } }; });',
    );
    const runner = new FakeClaudeRunner([
      {
        match: /no-direct-dom/,
        response: findingsResponse({
          findings: [
            {
              checkId: 'no-direct-dom',
              file: 'webapp/controller/Main.controller.js',
              line: 1,
              message: 'document.getElementById used',
              proposedFix: { newFileContent: 'fixed' },
            },
          ],
        }),
      },
    ]);
    const result = await noDirectDomCheck.run(path, h.makeCtx(runner));
    expect(result.findings).toHaveLength(1);
    const f = result.findings[0]!;
    expect(f.checkId).toBe('no-direct-dom');
    expect(f.file).toBe('webapp/controller/Main.controller.js');
    expect(f.line).toBe(1);
    expect(f.proposedFix).toEqual({ newFileContent: 'fixed' });
  });

  test('malformed: wrong-shape JSON becomes a proposedFix-null finding (no throw)', async () => {
    const h = createCheckHarness();
    const path = h.writeFile(
      'webapp/controller/Bad.controller.js',
      'sap.ui.define([], function () {});',
    );
    const runner = new FakeClaudeRunner([
      { match: /no-direct-dom/, response: { raw: '{"findings": "not an array"}' } },
    ]);
    const result = await noDirectDomCheck.run(path, h.makeCtx(runner));
    expect(result.findings).toHaveLength(1);
    const f = result.findings[0]!;
    expect(f.proposedFix).toBeNull();
    expect(f.checkId).toBe('no-direct-dom');
  });

  test('scope is controller-js and id is no-direct-dom', () => {
    expect(noDirectDomCheck.id).toBe('no-direct-dom');
    expect(noDirectDomCheck.scope).toBe('controller-js');
  });
});
