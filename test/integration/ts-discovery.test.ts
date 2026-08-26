/**
 * V1.9 Phase 0 — TS-aware discovery (GA1-01/04) and the HB-2 guarantee.
 *
 * The single most load-bearing TS finding (diagnosis HB-2): relaxing the TS
 * guard without TS-aware discovery would make the tool enumerate ZERO targets
 * on a TS project, run the 7 checks on an empty set, and report "clean" on an
 * unvalidated project — a correctness failure that *looks like success*. These
 * tests assert the discovery layer yields NON-ZERO `.ts` controller + test
 * targets for a TS fixture, and — the fail-on-revert teeth — that reverting
 * discovery to JS-only yields ZERO on the (pure-TS) fixture.
 *
 * Fixtures are copied to a tmpdir per the repo's fixture-pollution rule (never
 * pass a shared fixture root as projectRoot).
 */

import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { resolveFileScope } from '../../src/commands/validate.js';
import { detectProjectLanguage } from '../../src/project/detect.js';
import { buildProjectGraph } from '../../src/project/dependency-graph.js';
import { detectTestLayout } from '../../src/project/test-layout.js';

const FIX_ROOT = join(process.cwd(), 'test', 'fixtures');

function copyFixture(fixture: string): string {
  const root = mkdtempSync(join(tmpdir(), 'sapui5-ts-disc-'));
  cpSync(join(FIX_ROOT, fixture), root, { recursive: true });
  return root;
}

function rels(root: string, abs: readonly string[]): string[] {
  return abs.map((p) => relative(root, p).split(sep).join('/')).sort();
}

describe('TS-aware discovery — HB-2 non-zero TS targets (GA1-01)', () => {
  let root: string;
  beforeEach(() => {
    root = copyFixture('ts-helloworld');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('a TS project enumerates its .ts controllers and .qunit.ts tests', async () => {
    const scope = await resolveFileScope({ projectRoot: root, all: true, projectLanguage: 'ts' });

    expect(scope.controllerJs.length).toBeGreaterThan(0);
    expect(scope.qunitTest.length).toBeGreaterThan(0);

    const ctrl = rels(root, scope.controllerJs);
    const tests = rels(root, scope.qunitTest);
    const views = rels(root, scope.viewXml);

    expect(ctrl).toContain('webapp/controller/App.controller.ts');
    // entrypoint + ambient declaration are NOT analysis targets
    expect(ctrl).not.toContain('webapp/Component.ts');
    expect(ctrl).not.toContain('webapp/env.d.ts');
    expect(tests).toContain('webapp/test/unit/controller/App.controller.qunit.ts');
    // XML views are language-agnostic and must still be found
    expect(views).toContain('webapp/view/App.view.xml');
  });

  test('HB-2 fail-on-revert teeth: the TS lane yields strictly MORE than the JS lane on the same fixture', async () => {
    // The genuine fail-on-revert assertion, self-contained: discovery is run
    // twice on the SAME pure-TS fixture, once per lane. The TS lane MUST
    // enumerate strictly more controllers and tests than the JS lane. If the
    // language gate were removed (discovery reverted to JS-only globs), the TS
    // lane would collapse onto the JS lane — both would see the SAME (empty)
    // set — and `toBeGreaterThan` goes RED. The JS lane is empty here because
    // the fixture ships zero `.js` controllers and zero `.qunit.js` tests (the
    // purity premise); a TS run on JS-only discovery would thus scan an empty
    // set and falsely report "clean" — the exact HB-2 hole this guards.
    const scopeTs = await resolveFileScope({ projectRoot: root, all: true, projectLanguage: 'ts' });
    const scopeJs = await resolveFileScope({ projectRoot: root, all: true, projectLanguage: 'js' });
    expect(scopeJs.controllerJs).toEqual([]);
    expect(scopeJs.qunitTest).toEqual([]);
    expect(scopeTs.controllerJs.length).toBeGreaterThan(scopeJs.controllerJs.length);
    expect(scopeTs.qunitTest.length).toBeGreaterThan(scopeJs.qunitTest.length);
  });

  test('detection drives discovery end-to-end: detect ts → non-zero targets', async () => {
    const language = await detectProjectLanguage(root);
    expect(language).toBe('ts');
    const scope = await resolveFileScope({ projectRoot: root, all: true, projectLanguage: language });
    expect(scope.controllerJs.length).toBeGreaterThan(0);
    expect(scope.qunitTest.length).toBeGreaterThan(0);
  });
});

describe('GA1-04 — dependency-graph enumerates TS controllers', () => {
  let root: string;
  beforeEach(() => {
    root = copyFixture('ts-helloworld');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('the controller glob widens to .ts (and reverts to zero under JS-only)', async () => {
    const layout = detectTestLayout(root);

    const graphTs = await buildProjectGraph({ projectRoot: root, testLayout: layout, projectLanguage: 'ts' });
    expect(graphTs.controllers.length).toBeGreaterThan(0);
    expect(graphTs.controllers.map((c) => c.controllerRel)).toContain(
      'webapp/controller/App.controller.ts',
    );
    expect(graphTs.controllers.map((c) => c.controllerRel)).not.toContain('webapp/Component.ts');

    // fail-on-revert: JS-only enumeration finds zero controllers in a pure-TS project
    const graphJs = await buildProjectGraph({ projectRoot: root, testLayout: layout, projectLanguage: 'js' });
    expect(graphJs.controllers).toEqual([]);
  });
});

describe('JS discovery path is byte-identical (frozen snapshot)', () => {
  let root: string;
  beforeEach(() => {
    root = copyFixture('minimal-project');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("a JS project's enumerated targets are unchanged (default language === 'js')", async () => {
    // No projectLanguage passed → defaults to 'js', the legacy path. These are
    // the exact targets the pre-V1.9 discovery produced; any drift in the JS
    // globs/excludes/predicates breaks this snapshot.
    const scope = await resolveFileScope({ projectRoot: root, all: true });

    expect(rels(root, scope.controllerJs)).toEqual(['webapp/controller/Main.controller.js']);
    expect(rels(root, scope.viewXml)).toEqual(['webapp/view/Main.view.xml']);
    expect(rels(root, scope.qunitTest)).toEqual([
      'webapp/test/unit/controller/Main.controller.qunit.js',
      'webapp/test/unit/unit.qunit.js',
    ]);
  });

  test('explicitly passing projectLanguage:"js" produces the identical JS scope', async () => {
    const a = await resolveFileScope({ projectRoot: root, all: true });
    const b = await resolveFileScope({ projectRoot: root, all: true, projectLanguage: 'js' });
    expect(rels(root, b.controllerJs)).toEqual(rels(root, a.controllerJs));
    expect(rels(root, b.viewXml)).toEqual(rels(root, a.viewXml));
    expect(rels(root, b.qunitTest)).toEqual(rels(root, a.qunitTest));
  });
});
