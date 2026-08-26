/**
 * V1.4-10 witnesses — `checkUnpreloadedLibs` splits gaps by CDN
 * availability: a `cdnServed: true` gap gets a manifest auto-fix, a
 * `cdnServed: false` gap surfaces as a manual finding (no manifest fix —
 * declaring a CDN-absent lib would only make karma hang) and is excluded
 * from the manifest patch.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  buildPatchedManifest,
  checkUnpreloadedLibs,
} from '../../src/checks/unpreloaded-libs.js';
import type {
  ProjectGraph,
  UnpreloadedLib,
} from '../../src/project/dependency-graph.js';

const MANIFEST = JSON.stringify(
  {
    'sap.app': { id: 'demo', type: 'application' },
    'sap.ui5': { dependencies: { libs: { 'sap.m': {}, 'sap.ui.core': {} } } },
  },
  null,
  2,
);

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'unpreloaded-'));
  mkdirSync(join(root, 'webapp'), { recursive: true });
  writeFileSync(join(root, 'webapp', 'manifest.json'), MANIFEST);
});
afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function graphWith(gaps: readonly UnpreloadedLib[]): ProjectGraph {
  return {
    controllers: [],
    manifestLibs: ['sap.m', 'sap.ui.core'],
    karmaClientLibs: [],
    alwaysAvailableLibs: ['sap.ui.core', 'sap.ui.thirdparty'],
    unpreloadedLibs: gaps,
    projectNamespace: 'demo',
  };
}

describe('checkUnpreloadedLibs — V1.4-10 CDN-availability split', () => {
  test('cdnServed: true → manifest auto-fix that declares the lib', () => {
    const { findings } = checkUnpreloadedLibs({
      projectRoot: root,
      projectGraph: graphWith([
        { lib: 'sap.f', importedBy: ['webapp/controller/A.js'], suggestedFix: 'manifest', cdnServed: true, cdnProbed: true },
      ]),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.proposedFix).not.toBeNull();
    expect(findings[0]?.proposedFix?.newFileContent ?? '').toContain('"sap.f"');
  });

  test('cdnServed: false → manual finding (no fix) explaining the CDN gap; lib NOT declared', () => {
    const { findings } = checkUnpreloadedLibs({
      projectRoot: root,
      projectGraph: graphWith([
        { lib: 'sap.ui.export', importedBy: ['webapp/controller/Reports.controller.js'], suggestedFix: 'manifest', cdnServed: false, cdnProbed: true },
      ]),
    });
    expect(findings).toHaveLength(1);
    const finding = findings[0];
    expect(finding?.proposedFix).toBeNull();
    const explanation = finding && finding.proposedFix === null ? finding.explanation : '';
    expect(explanation).toContain('not served by the karma test CDN');
  });

  test('mixed gaps → the patch declares only the CDN-served lib; the stub-only lib stays out', () => {
    const { findings } = checkUnpreloadedLibs({
      projectRoot: root,
      projectGraph: graphWith([
        { lib: 'sap.f', importedBy: ['webapp/controller/Reports.controller.js'], suggestedFix: 'manifest', cdnServed: true, cdnProbed: true },
        { lib: 'sap.ui.export', importedBy: ['webapp/controller/Reports.controller.js'], suggestedFix: 'manifest', cdnServed: false, cdnProbed: true },
      ]),
    });
    const served = findings.find((f) => f.message.includes("'sap.f'"));
    const stubOnly = findings.find((f) => f.message.includes("'sap.ui.export'"));
    expect(served?.proposedFix).not.toBeNull();
    const patch = served?.proposedFix?.newFileContent ?? '';
    expect(patch).toContain('"sap.f"');
    expect(patch).not.toContain('"sap.ui.export"');
    expect(stubOnly?.proposedFix).toBeNull();
  });
});

/**
 * R2.4 witnesses (AUDIT §5.5) — the offline auto-apply guard. A gap whose
 * `cdnServed: true` is only the no-probe default (`cdnProbed: false`) AND
 * whose namespace is not in KNOWN_SAP_UI5_LIBRARIES was never confirmed by
 * anything real: the check must refuse the manifest auto-fix
 * (`proposedFix: null`) and keep the namespace out of the combined patch —
 * otherwise `--auto-apply-baseline-fixes` offline writes a phantom library
 * that karma-ui5 404s on and hangs (the exact failure class V1.4/V1.5 exist
 * to prevent). Reverting the guard turns the first two tests red.
 */
describe('checkUnpreloadedLibs — R2.4 offline auto-apply guard', () => {
  test('unprobed non-table namespace → REFUSED (no proposedFix; explanation names the probe gap)', () => {
    const { findings } = checkUnpreloadedLibs({
      projectRoot: root,
      projectGraph: graphWith([
        // `sap.suite.ui` is the audit's exact phantom: a heuristic-capped
        // prefix of sap.suite.ui.commons that is not a real library.
        { lib: 'sap.suite.ui', importedBy: ['webapp/controller/Chart.controller.js'], suggestedFix: 'manifest', cdnServed: true, cdnProbed: false },
      ]),
    });
    expect(findings).toHaveLength(1);
    const finding = findings[0];
    expect(finding?.proposedFix).toBeNull();
    const explanation = finding && finding.proposedFix === null ? finding.explanation : '';
    expect(explanation).toContain('no CDN probe ran');
  });

  test('mixed: the refused namespace stays OUT of the patch written for verified gaps', () => {
    const { findings } = checkUnpreloadedLibs({
      projectRoot: root,
      projectGraph: graphWith([
        { lib: 'sap.f', importedBy: ['webapp/controller/A.controller.js'], suggestedFix: 'manifest', cdnServed: true, cdnProbed: false },
        { lib: 'sap.suite.ui', importedBy: ['webapp/controller/Chart.controller.js'], suggestedFix: 'manifest', cdnServed: true, cdnProbed: false },
      ]),
    });
    const tableLib = findings.find((f) => f.message.includes("'sap.f'"));
    const refused = findings.find((f) => f.message.includes("'sap.suite.ui'"));
    expect(tableLib?.proposedFix).not.toBeNull();
    const patch = tableLib?.proposedFix?.newFileContent ?? '';
    expect(patch).toContain('"sap.f"');
    expect(patch).not.toContain('"sap.suite.ui"');
    expect(refused?.proposedFix).toBeNull();
  });

  test('unprobed TABLE namespace → still auto-fixable (the table vouches for it)', () => {
    const { findings } = checkUnpreloadedLibs({
      projectRoot: root,
      projectGraph: graphWith([
        { lib: 'sap.suite.ui.commons', importedBy: ['webapp/controller/Chart.controller.js'], suggestedFix: 'manifest', cdnServed: true, cdnProbed: false },
      ]),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.proposedFix).not.toBeNull();
    expect(findings[0]?.proposedFix?.newFileContent ?? '').toContain('"sap.suite.ui.commons"');
  });

  test('PROBED non-table namespace → still auto-fixable (the probe vouches for it)', () => {
    const { findings } = checkUnpreloadedLibs({
      projectRoot: root,
      projectGraph: graphWith([
        { lib: 'sap.ui.layout', importedBy: ['webapp/controller/A.controller.js'], suggestedFix: 'manifest', cdnServed: true, cdnProbed: true },
      ]),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.proposedFix).not.toBeNull();
    expect(findings[0]?.proposedFix?.newFileContent ?? '').toContain('"sap.ui.layout"');
  });
});

/**
 * V1.4-11 — direct witnesses for `buildPatchedManifest`. The integration
 * tests only assert key presence; these pin the claims the JSDoc makes
 * (whole-object alphabetisation, indent + trailing-newline preservation,
 * the absent-`sap.ui5` → null path, intermediate-object creation, and
 * idempotence) so a regression in any of them fails the suite.
 */
describe('buildPatchedManifest — serialisation contract', () => {
  function libsOf(json: string | null): string[] {
    if (json === null) throw new Error('expected a patched manifest, got null');
    const parsed = JSON.parse(json) as {
      'sap.ui5'?: { dependencies?: { libs?: Record<string, unknown> } };
    };
    return Object.keys(parsed['sap.ui5']?.dependencies?.libs ?? {});
  }

  test('AM2 — the ENTIRE libs object is alphabetised, not just the new key', () => {
    const raw = JSON.stringify(
      {
        'sap.app': { id: 'demo' },
        'sap.ui5': { dependencies: { libs: { 'sap.m': {}, 'sap.f': {}, 'sap.ui.core': {} } } },
      },
      null,
      2,
    );
    const patched = buildPatchedManifest(raw, ['sap.ui.layout']);
    expect(libsOf(patched)).toEqual(['sap.f', 'sap.m', 'sap.ui.core', 'sap.ui.layout']);
  });

  test('multiple libs added in one patch, all alphabetised', () => {
    const patched = buildPatchedManifest(MANIFEST, ['sap.ui.table', 'sap.f']);
    expect(libsOf(patched)).toEqual(['sap.f', 'sap.m', 'sap.ui.core', 'sap.ui.table']);
  });

  test('a 4-space indent is preserved', () => {
    const raw = JSON.stringify(
      { 'sap.ui5': { dependencies: { libs: { 'sap.m': {} } } } },
      null,
      4,
    );
    const patched = buildPatchedManifest(raw, ['sap.f']);
    expect(patched).not.toBeNull();
    // A 4-space indent serialises the top-level key at 4 spaces.
    expect(patched).toContain('\n    "sap.ui5"');
  });

  test('a trailing newline is preserved when present and absent when not', () => {
    const compact = JSON.stringify({ 'sap.ui5': { dependencies: { libs: {} } } }, null, 2);
    expect(buildPatchedManifest(compact, ['sap.f'])?.endsWith('\n')).toBe(false);
    expect(buildPatchedManifest(`${compact}\n`, ['sap.f'])?.endsWith('\n')).toBe(true);
  });

  test('AM3 — absent sap.ui5 section → null (manual-only finding)', () => {
    const raw = JSON.stringify({ 'sap.app': { id: 'demo' } }, null, 2);
    expect(buildPatchedManifest(raw, ['sap.f'])).toBeNull();
  });

  test('AM3 — absent dependencies/libs intermediates are created', () => {
    const raw = JSON.stringify({ 'sap.ui5': {} }, null, 2);
    expect(libsOf(buildPatchedManifest(raw, ['sap.f']))).toEqual(['sap.f']);
  });

  test('unparseable JSON → null', () => {
    expect(buildPatchedManifest('{ not json', ['sap.f'])).toBeNull();
    expect(buildPatchedManifest('', ['sap.f'])).toBeNull();
  });

  test('idempotent — re-patching an already-declared lib changes nothing', () => {
    const once = buildPatchedManifest(MANIFEST, ['sap.f']);
    expect(once).not.toBeNull();
    const twice = buildPatchedManifest(once ?? '', ['sap.f']);
    expect(twice).toBe(once);
  });
});
