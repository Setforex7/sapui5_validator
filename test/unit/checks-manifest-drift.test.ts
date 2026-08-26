import { describe, expect, test } from 'vitest';
import { FakeClaudeRunner } from '../../src/claude/fake-runner.js';
import { manifestComponentDriftCheck } from '../../src/checks/manifest-component-drift.js';
import { createCheckHarness, findingsResponse } from './_check-helpers.js';

const MANIFEST = JSON.stringify({
  'sap.app': { type: 'application' },
  'sap.ui5': { routing: { routes: [{ name: 'main', target: 'main' }] } },
});
const COMPONENT = 'sap.ui.define(["sap/ui/core/UIComponent"], function (U) { return U.extend("x.Component", {}); });';

describe('manifestComponentDriftCheck', () => {
  test('clean: empty findings when LLM finds no drift', async () => {
    const h = createCheckHarness();
    h.writeFile('webapp/manifest.json', MANIFEST);
    h.writeFile('webapp/Component.js', COMPONENT);
    const runner = new FakeClaudeRunner([
      {
        match: /manifest-component-drift/,
        response: findingsResponse({ findings: [] }),
      },
    ]);
    const result = await manifestComponentDriftCheck.run(h.projectRoot, h.makeCtx(runner));
    expect(result.findings).toEqual([]);
  });

  test('positive: returns manual-only finding (proposedFix null + explanation)', async () => {
    const h = createCheckHarness();
    h.writeFile('webapp/manifest.json', MANIFEST);
    h.writeFile('webapp/Component.js', COMPONENT);
    const runner = new FakeClaudeRunner([
      {
        match: /manifest-component-drift/,
        response: findingsResponse({
          findings: [
            {
              checkId: 'manifest-component-drift',
              file: 'webapp/Component.js',
              message: 'route `main` never activated',
              proposedFix: null,
              explanation: 'Component.js does not call getRouter().initialize().',
            },
          ],
        }),
      },
    ]);
    const result = await manifestComponentDriftCheck.run(h.projectRoot, h.makeCtx(runner));
    expect(result.findings).toHaveLength(1);
    const f = result.findings[0]!;
    expect(f.proposedFix).toBeNull();
    if (f.proposedFix === null) {
      expect(f.explanation).toMatch(/getRouter/);
    }
  });

  test('manual-only schema rejects auto-fix proposal as malformed', async () => {
    const h = createCheckHarness();
    h.writeFile('webapp/manifest.json', MANIFEST);
    h.writeFile('webapp/Component.js', COMPONENT);
    const runner = new FakeClaudeRunner([
      {
        match: /manifest-component-drift/,
        response: findingsResponse({
          findings: [
            {
              checkId: 'manifest-component-drift',
              file: 'webapp/Component.js',
              message: 'x',
              proposedFix: { newFileContent: 'forbidden' },
            },
          ],
        }),
      },
    ]);
    const result = await manifestComponentDriftCheck.run(h.projectRoot, h.makeCtx(runner));
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.proposedFix).toBeNull();
    expect(result.findings[0]?.message).toMatch(/malformed output/);
  });

  test('no manifest or component: skips silently with no findings (no LLM call)', async () => {
    const h = createCheckHarness();
    // ui5.yaml-only project (manifest detection covers this path elsewhere)
    h.writeFile('ui5.yaml', 'specVersion: "3.0"');
    const runner = new FakeClaudeRunner([]);
    const result = await manifestComponentDriftCheck.run(h.projectRoot, h.makeCtx(runner));
    expect(result.findings).toEqual([]);
    expect(runner.calls).toHaveLength(0);
  });

  test('scope is project', () => {
    expect(manifestComponentDriftCheck.scope).toBe('project');
  });
});
