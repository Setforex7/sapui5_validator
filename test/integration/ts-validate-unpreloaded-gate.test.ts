/**
 * V1.9.1 — Fix A (D1/D2) integration witness: the `baseline-unpreloaded-libs`
 * check (validate.ts step 6b) is a karma-ui5 PRELOAD-hang prediction. The
 * never-build firewall guarantees a TS run never executes karma, so the
 * predicted failure is structurally unreachable for TS — running it forced a
 * permanent exit-1 with no path to exit 0 (the fresh 2026-06-24 `cap_try_ts`
 * gate run). Fix A gates the step off for TS.
 *
 * This reproduces the `cap_try_ts` shape the V1.9 gate structurally could not
 * catch: a TS project WITH an undeclared / CDN-absent import (the e2e TS
 * fixture imports only declared/core-bundled libs, so it never exercised step
 * 6b for TS). Self-contained — a synthetic project is seeded into a tmpdir
 * (never the shared fixtures, per the fixture-pollution rule; a tmpdir is a
 * non-repo so COR-1 proceeds and `--force` bypasses the clean-tree gate).
 *
 * Two fail-on-revert dimensions:
 *   - TS case: with the gate, the unpreloaded check never runs for TS → no
 *     `baseline-unpreloaded-libs` finding and a clean TS project reaches exit 0.
 *     PRE-FIX this run emits the finding and exits `unfixed-findings` (the
 *     assertion is RED before the validate.ts change — proving it load-bearing).
 *   - CONTROL (JS): the SAME shape on a `.js` controller still emits the finding
 *     and still exits `unfixed-findings` — the JS path is byte-identical (Fix A
 *     is gated `projectLanguage !== 'ts'`).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { runValidate } from '../../src/commands/validate.js';
import { FakeClaudeRunner } from '../../src/claude/fake-runner.js';
import type { ProbeAdapter } from '../../src/project/tooling.js';
import type { Finding, RunReport } from '../../src/types.js';

const ALL_TOOLS_OK: ProbeAdapter = {
  probe: () => ({ present: true, version: '1.0.0', source: 'node_modules' }),
};

// Manifest declares ONLY sap.m + sap.ui.core, so the controller's imports of
// sap/f/Card (→ sap.f) and sap/ui/export/Spreadsheet (→ sap.ui.export) are both
// genuine gaps. Neither is core-bundled (sap.ui is exact-only — see Phase 1
// Fix B), so both stay flaggable on the JS lane.
const MANIFEST = JSON.stringify(
  {
    _version: '1.40.0',
    'sap.app': { id: 'gap.app', type: 'application' },
    'sap.ui5': { dependencies: { libs: { 'sap.m': {}, 'sap.ui.core': {} } } },
  },
  null,
  2,
);

// The TS controller: value imports (NOT type-only) of one declared lib (sap.m),
// and two undeclared libs (sap.f, sap.ui.export) that survive transpile and so
// are real preload gaps.
const TS_CONTROLLER = [
  'import MessageBox from "sap/m/MessageBox";',
  'import Card from "sap/f/Card";',
  'import Spreadsheet from "sap/ui/export/Spreadsheet";',
  '/** @namespace gap.app.controller */',
  'export default class Gap extends MessageBox {',
  '  public make(): Card { return new Card(); }',
  '  public sheet(): typeof Spreadsheet { return Spreadsheet; }',
  '}',
  '',
].join('\n');

// The JS control: the same gaps via a classic sap.ui.define dependency array.
const JS_CONTROLLER = [
  'sap.ui.define([',
  '  "sap/ui/core/mvc/Controller",',
  '  "sap/f/Card",',
  '  "sap/ui/export/Spreadsheet"',
  '], function (Controller, Card, Spreadsheet) {',
  '  "use strict";',
  '  return Controller.extend("gap.app.controller.Gap", {',
  '    onInit: function () {',
  '      this._card = new Card();',
  '      this._sheet = Spreadsheet;',
  '    }',
  '  });',
  '});',
  '',
].join('\n');

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sapui5-ts-validate-gate-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function seed(rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

function unpreloadedFindings(report: RunReport): readonly Finding[] {
  return report.files
    .flatMap((f) => f.findings)
    .filter((f) => f.checkId === 'baseline-unpreloaded-libs');
}

function noFindingsRunner(): FakeClaudeRunner {
  return new FakeClaudeRunner([
    { match: /Static check:/, response: { raw: JSON.stringify({ findings: [] }) } },
  ]);
}

// A passing static-verify stub (ui5lint + tsc + eslint never run for real). The
// baseline phase drives this per file; returning ok keeps the baseline clean so
// the run reaches the exit-accounting under test.
const verifyOk = async (): Promise<{
  ok: true;
  steps: readonly never[];
  feedbackForLlm: string;
}> => ({ ok: true, steps: [], feedbackForLlm: '' });

// Both gap libs are CDN-absent (the karma test CDN does not serve them as a
// library-preload) — exactly the cap_try_ts case (sap/ui/export/Spreadsheet).
// A CDN-absent gap is `proposedFix: null` and, without
// --auto-apply-baseline-fixes, every unpreloaded finding is counted unfixed.
const probeLibAbsent = async (): Promise<boolean> => false;

describe('runValidate — V1.9.1 Fix A: baseline-unpreloaded-libs gated off for TS (D1/D2)', () => {
  test('TS: the unpreloaded check does NOT run → no finding, verification lint-only, exit 0', async () => {
    seed('webapp/manifest.json', MANIFEST);
    seed('webapp/Component.ts', 'export default {};\n');
    seed('webapp/controller/Gap.controller.ts', TS_CONTROLLER);

    const result = await runValidate({
      projectRoot: root,
      all: true,
      force: true,
      noPrompt: true,
      runner: noFindingsRunner(),
      probeAdapter: ALL_TOOLS_OK,
      verifyFn: verifyOk,
      probeLib: probeLibAbsent,
    });

    // Fix A: step 6b never runs for TS, so no unpreloaded finding is surfaced.
    expect(unpreloadedFindings(result.report)).toEqual([]);
    // TS takes the static-only verify lane (the never-build firewall). V1.9.3 D1
    // — this synthetic project is seeded into a tmpdir with no
    // `node_modules/typescript`, so `tscEnabled=false`: `tsc` is skipped and the
    // marker honestly reads `'lint-only'` (ui5lint only), not `'static-only'`.
    // Reverting the D1 gate (always `'static-only'`) → RED.
    expect(result.report.verification).toBe('lint-only');
    // The clean TS project now reaches exit 0 — the whole point of the fix.
    expect(result.report.exitReason.kind).not.toBe('unfixed-findings');
    expect(result.report.exitReason).toEqual({ kind: 'success' });
    expect(result.exitCode).toBe(0);
  });

  test('CONTROL (JS, byte-identical path): the SAME shape still emits the finding and exits unfixed-findings', async () => {
    seed('webapp/manifest.json', MANIFEST);
    seed('webapp/Component.js', 'sap.ui.define([], function () { "use strict"; });\n');
    seed('webapp/controller/Gap.controller.js', JS_CONTROLLER);

    const result = await runValidate({
      projectRoot: root,
      all: true,
      force: true,
      noPrompt: true,
      runner: noFindingsRunner(),
      probeAdapter: ALL_TOOLS_OK,
      verifyFn: verifyOk,
      probeLib: probeLibAbsent,
    });

    // JS path is unchanged: the unpreloaded check runs, surfaces the gaps on the
    // manifest, and the unfixable findings force a non-zero exit.
    const findings = unpreloadedFindings(result.report);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f) => f.file === 'webapp/manifest.json')).toBe(true);
    expect(result.report.exitReason.kind).toBe('unfixed-findings');
    expect(result.exitCode).toBe(1);
  });
});
