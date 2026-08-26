/**
 * V1.9 Phase 4 — a fast, offline guard on the real-toolchain TS e2e fixture
 * `test/fixtures/e2e-real-ts-project/`.
 *
 * The expensive end-to-end witness (real `tsc`/`ui5lint`, the static-only lane,
 * karma-never-invoked) lives in `test/e2e-real/ts-validate.e2e.test.ts` and only
 * runs under `VALIDATOR_E2E_REAL=1`. This file is the cheap counterpart: it
 * proves — in the default offline suite — that the fixture IS a discoverable TS
 * project (detected `ts`, non-zero `.ts` controller + `.qunit.ts` targets, the
 * dependency graph enumerates the TS controller), so a regression that breaks
 * the fixture's TS shape goes red in seconds instead of only surfacing in the
 * gated, paid e2e run.
 *
 * The functions exercised (`detectProjectLanguage`, `listWebappTsSources`,
 * `resolveFileScope`, `buildProjectGraph`) are READ-ONLY enumerators — they
 * never write under the project root — so the fixture is used in place (no
 * cpSync), which also avoids copying its (lazily-installed, git-ignored)
 * `node_modules`. The fixture-pollution rule applies to orchestrator runs that
 * write `.sapui5-validator/`, not to these pure reads.
 */

import { join, relative, sep } from 'node:path';
import { describe, expect, test } from 'vitest';
import { resolveFileScope } from '../../src/commands/validate.js';
import { detectProjectLanguage, listWebappTsSources } from '../../src/project/detect.js';
import { buildProjectGraph } from '../../src/project/dependency-graph.js';
import { detectTestLayout } from '../../src/project/test-layout.js';

const FIXTURE = join(process.cwd(), 'test', 'fixtures', 'e2e-real-ts-project');

function rels(root: string, abs: readonly string[]): string[] {
  return abs.map((p) => relative(root, p).split(sep).join('/')).sort();
}

describe('e2e-real-ts-project — offline detection + discovery guard', () => {
  test('detected as a TypeScript project', async () => {
    expect(await detectProjectLanguage(FIXTURE)).toBe('ts');
  });

  test('listWebappTsSources covers the sources and excludes the ambient declaration', async () => {
    const sources = await listWebappTsSources(FIXTURE);
    expect(sources).toContain('webapp/controller/App.controller.ts');
    expect(sources).toContain('webapp/Component.ts');
    expect(sources).toContain('webapp/test/unit/controller/App.controller.qunit.ts');
    // `.d.ts` is never a source.
    expect(sources).not.toContain('webapp/env.d.ts');
  });

  test('TS discovery enumerates the .ts controller + .qunit.ts test (HB-2, non-zero)', async () => {
    const scope = await resolveFileScope({ projectRoot: FIXTURE, all: true, projectLanguage: 'ts' });
    const ctrl = rels(FIXTURE, scope.controllerJs);
    const tests = rels(FIXTURE, scope.qunitTest);
    const views = rels(FIXTURE, scope.viewXml);

    expect(scope.controllerJs.length).toBeGreaterThan(0);
    expect(scope.qunitTest.length).toBeGreaterThan(0);
    expect(ctrl).toContain('webapp/controller/App.controller.ts');
    expect(ctrl).not.toContain('webapp/Component.ts'); // entrypoint, not an analysis target
    expect(ctrl).not.toContain('webapp/env.d.ts'); // ambient declaration
    expect(tests).toContain('webapp/test/unit/controller/App.controller.qunit.ts');
    expect(views).toContain('webapp/view/App.view.xml');
  });

  test('HB-2 fail-on-revert: a JS-only discovery lane enumerates ZERO on this pure-TS fixture', async () => {
    const scopeTs = await resolveFileScope({ projectRoot: FIXTURE, all: true, projectLanguage: 'ts' });
    const scopeJs = await resolveFileScope({ projectRoot: FIXTURE, all: true, projectLanguage: 'js' });
    expect(scopeJs.controllerJs).toEqual([]);
    expect(scopeJs.qunitTest).toEqual([]);
    expect(scopeTs.controllerJs.length).toBeGreaterThan(scopeJs.controllerJs.length);
    expect(scopeTs.qunitTest.length).toBeGreaterThan(scopeJs.qunitTest.length);
  });

  test('the dependency graph enumerates the TS controller (GA1-03/04)', async () => {
    const layout = detectTestLayout(FIXTURE);
    const graphTs = await buildProjectGraph({
      projectRoot: FIXTURE,
      testLayout: layout,
      projectLanguage: 'ts',
    });
    expect(graphTs.controllers.map((c) => c.controllerRel)).toContain(
      'webapp/controller/App.controller.ts',
    );
    // fail-on-revert: a JS-only enumeration finds zero controllers here.
    const graphJs = await buildProjectGraph({
      projectRoot: FIXTURE,
      testLayout: layout,
      projectLanguage: 'js',
    });
    expect(graphJs.controllers).toEqual([]);
  });
});
