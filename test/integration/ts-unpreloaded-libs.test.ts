/**
 * V1.9 Phase 1 — GA1-03 integration witness: a TS controller's ES-module
 * imports drive the SAME `baseline-unpreloaded-libs` prevention spine a JS
 * controller's `sap.ui.define` array does. The V1.4 karma-module-load layer was
 * entirely INERT for TS (the `sap.ui.define`-only parser returned [] for every
 * TS controller); this proves a TS controller importing an UNDECLARED library
 * now surfaces a real gap in `ProjectGraph.unpreloadedLibs`.
 *
 * Self-contained: a synthetic TS project is seeded into a tmpdir (never the
 * shared fixtures — the fixture-pollution rule), so the gap is exactly the one
 * we author. Two fail-on-revert dimensions are covered:
 *   - revert the ES parser (route TS back through `parseControllerImports`) →
 *     the controller's imports collapse to [] → the `sap.f` gap disappears;
 *   - revert the GA1-04 glob (enumerate JS-only) → the `.ts` controller is never
 *     read at all → zero controllers, zero gaps.
 * The JS-lane assertion below pins the second; the parser-level
 * `controller-imports.test.ts` witness pins the first directly.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { buildProjectGraph } from '../../src/project/dependency-graph.js';
import { detectTestLayout } from '../../src/project/test-layout.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sapui5-ts-unpreload-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function seed(rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

describe('GA1-03 — TS imports drive the unpreloaded-libs spine', () => {
  beforeEach(() => {
    // Manifest declares ONLY sap.m + sap.ui.core, so an import of an undeclared
    // library (sap.f) is a genuine gap.
    seed(
      'webapp/manifest.json',
      JSON.stringify({
        _version: '1.40.0',
        'sap.app': { id: 'ts.gap.app', type: 'application' },
        'sap.ui5': { dependencies: { libs: { 'sap.m': {}, 'sap.ui.core': {} } } },
      }),
    );
    // The TS controller: one declared import (sap.m, no gap), one UNDECLARED
    // import (sap.f → the gap), one relative import (intra-project, excluded),
    // and one type-only import of another undeclared lib (sap.tnt → erased at
    // transpile, must NOT become a gap).
    seed(
      'webapp/controller/Gap.controller.ts',
      [
        'import MessageBox from "sap/m/MessageBox";',
        'import Card from "sap/f/Card";',
        'import AppComponent from "../Component";',
        'import type ToolHeader from "sap/tnt/ToolHeader";',
        '/** @namespace ts.gap.app.controller */',
        'export default class Gap extends MessageBox {',
        '  public make(): Card { return new Card(); }',
        '}',
        '',
      ].join('\n'),
    );
  });

  test('a TS controller importing an UNDECLARED lib surfaces a baseline-unpreloaded-libs gap', async () => {
    const layout = detectTestLayout(root);
    const graph = await buildProjectGraph({
      projectRoot: root,
      testLayout: layout,
      projectLanguage: 'ts',
    });

    // The controller was enumerated and its ES imports parsed.
    expect(graph.controllers.map((c) => c.controllerRel)).toContain(
      'webapp/controller/Gap.controller.ts',
    );

    const gapLibs = graph.unpreloadedLibs.map((g) => g.lib);
    // sap.f is the genuine gap — declared nowhere, imported by the controller.
    expect(gapLibs).toContain('sap.f');
    const sapF = graph.unpreloadedLibs.find((g) => g.lib === 'sap.f');
    expect(sapF?.importedBy).toContain('webapp/controller/Gap.controller.ts');

    // Negative guards: the declared lib, the relative import, and the
    // type-only import must NOT appear as gaps.
    expect(gapLibs).not.toContain('sap.m'); // declared
    expect(gapLibs).not.toContain('sap.tnt'); // type-only → erased, never loaded
    expect(gapLibs.some((l) => l.startsWith('..'))).toBe(false); // relative excluded
  });

  test('FAIL-ON-REVERT (GA1-04 dimension): the JS lane reads zero controllers on a pure-TS project → no gap', async () => {
    const layout = detectTestLayout(root);
    const graphJs = await buildProjectGraph({
      projectRoot: root,
      testLayout: layout,
      projectLanguage: 'js',
    });
    expect(graphJs.controllers).toEqual([]);
    expect(graphJs.unpreloadedLibs).toEqual([]);
  });
});
