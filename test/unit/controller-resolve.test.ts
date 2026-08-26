/**
 * COR-6 — layout-aware controller resolution shared by `globals-in-views` and
 * OPA5 discovery. Witnesses the two cases the old per-call heuristics broke on:
 * a nested controller and a `controller`-named namespace segment, plus the
 * namespace-prefix strip and the not-found → null contract.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  resolveControllerRelFromName,
  resolveControllerRelFromView,
} from '../../src/project/controller-resolve.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sapui5-ctrlres-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function seed(rel: string, content = ''): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

describe('resolveControllerRelFromName', () => {
  test('flat standard layout (no manifest) resolves via the controller segment', () => {
    seed('webapp/controller/Main.controller.js', '// Main');
    expect(
      resolveControllerRelFromName({ projectRoot: root, controllerName: 'demo.controller.Main' }),
    ).toBe('webapp/controller/Main.controller.js');
  });

  test('a NESTED controller resolves (the old last-segment-only globals heuristic dropped it)', () => {
    seed('webapp/controller/sub/Main.controller.js', '// nested');
    expect(
      resolveControllerRelFromName({
        projectRoot: root,
        controllerName: 'demo.controller.sub.Main',
      }),
    ).toBe('webapp/controller/sub/Main.controller.js');
  });

  test('a `controller`-named namespace segment resolves (the old first-`controller` OPA5 slice misfired)', () => {
    seed('webapp/controller/Main.controller.js', '// Main');
    expect(
      resolveControllerRelFromName({
        projectRoot: root,
        controllerName: 'my.controller.app.controller.Main',
      }),
    ).toBe('webapp/controller/Main.controller.js');
  });

  test('namespace-prefix strip resolves a controller NOT under a `controller/` folder', () => {
    seed('webapp/manifest.json', JSON.stringify({ 'sap.app': { id: 'my.app' } }));
    seed('webapp/Main.controller.js', '// flat-at-root');
    expect(
      resolveControllerRelFromName({ projectRoot: root, controllerName: 'my.app.Main' }),
    ).toBe('webapp/Main.controller.js');
  });

  test('returns null when no candidate file exists', () => {
    expect(
      resolveControllerRelFromName({
        projectRoot: root,
        controllerName: 'demo.controller.Absent',
      }),
    ).toBeNull();
  });

  test('GA1-05 — a TS controller resolves to .controller.ts (no .controller.js exists)', () => {
    // Fail-on-revert: the pre-V1.9 single-suffix loop only tried `.controller.js`
    // and returned null for a TS project, silently dropping the paired controller.
    seed('webapp/controller/App.controller.ts', '// TS controller');
    expect(
      resolveControllerRelFromName({ projectRoot: root, controllerName: 'demo.controller.App' }),
    ).toBe('webapp/controller/App.controller.ts');
  });

  test('GA1-05 — when BOTH .js and .ts exist, .js wins (JS path byte-identical)', () => {
    seed('webapp/controller/App.controller.js', '// JS controller');
    seed('webapp/controller/App.controller.ts', '// TS controller');
    expect(
      resolveControllerRelFromName({ projectRoot: root, controllerName: 'demo.controller.App' }),
    ).toBe('webapp/controller/App.controller.js');
  });
});

describe('resolveControllerRelFromView', () => {
  test('reads controllerName and resolves', () => {
    seed('webapp/controller/Main.controller.js', '// Main');
    const view = '<mvc:View controllerName="demo.controller.Main" xmlns:mvc="sap.ui.core.mvc"/>';
    expect(resolveControllerRelFromView({ projectRoot: root, viewContent: view })).toBe(
      'webapp/controller/Main.controller.js',
    );
  });

  test('returns null for a view with no controllerName', () => {
    expect(
      resolveControllerRelFromView({
        projectRoot: root,
        viewContent: '<mvc:View xmlns:mvc="sap.ui.core.mvc"/>',
      }),
    ).toBeNull();
  });
});
