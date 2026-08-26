/**
 * V1.9.1 — Fix C (I4) integration witness: deterministic coverage triage.
 *
 * On the fresh 2026-06-24 `cap_try_ts` gate run, 85 of 89 findings were
 * `missing-test-coverage`, every one `proposedFix:null`, on a project whose
 * only test is a smoke probe that imports no controller. ~13 of the 49 LLM
 * calls were spent enumerating per-method coverage gaps that `validate` cannot
 * act on (multi-file → `generate`, which refuses TS). Coverage is a STRUCTURAL
 * fact: if no in-scope test references a source module, every method is
 * trivially uncovered and no LLM call is needed.
 *
 * Fix C parses the imports of the in-scope test files into a coveredModuleIds
 * set; controllers no in-scope test imports roll up into ONE deterministic
 * finding (0 LLM calls); controllers a test DOES import keep the per-method LLM
 * check (per-method coverage is a genuine semantic question).
 *
 * Self-contained — a synthetic project is seeded into a tmpdir (never the
 * shared fixtures, per the fixture-pollution rule; a tmpdir is a non-repo so
 * COR-1 proceeds and `--force` bypasses the clean-tree gate). The controllers
 * import only `sap/ui/core/mvc/Controller` (core-bundled) so no
 * `baseline-unpreloaded-libs` noise enters the report.
 *
 * Two fail-on-revert dimensions:
 *   - No-covering-test: a smoke test imports no controller → both sources roll
 *     up into ONE finding and ZERO coverage LLM calls fire. PRE-FIX both
 *     controllers get a per-method coverage call (2 calls) and the rolled-up
 *     finding does not exist (the assertions are RED before the change).
 *   - Mapped source: a test imports controller A → A still gets its per-method
 *     coverage call while B (unimported) rolls up. PRE-FIX both A and B get a
 *     coverage call (the "exactly one call, for A" assertion is RED).
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

const MANIFEST = JSON.stringify(
  {
    _version: '1.40.0',
    'sap.app': { id: 'cov.app', type: 'application' },
    'sap.ui5': { dependencies: { libs: { 'sap.m': {}, 'sap.ui.core': {} } } },
  },
  null,
  2,
);

// A controller importing only a core-bundled lib → no unpreloaded gap noise.
function controller(name: string): string {
  return [
    'sap.ui.define([',
    '  "sap/ui/core/mvc/Controller"',
    '], function (Controller) {',
    '  "use strict";',
    `  return Controller.extend("cov.app.controller.${name}", {`,
    '    onInit: function () {}',
    '  });',
    '});',
    '',
  ].join('\n');
}

// A passing static-verify stub (ui5lint/eslint never run for real). The
// baseline phase drives this per file; returning ok keeps the baseline clean.
const verifyOk = async (): Promise<{
  ok: true;
  steps: readonly never[];
  feedbackForLlm: string;
}> => ({ ok: true, steps: [], feedbackForLlm: '' });

// No controller imports a lib the karma CDN would not serve, so this is never
// actually called; passed for parity with the production injection seam.
const probeLibAbsent = async (): Promise<boolean> => false;

// The literal head every missing-test-coverage prompt carries (the check
// builder emits 'Static check: `missing-test-coverage`.'). Counting these in
// `runner.calls` measures exactly how many coverage LLM calls fired.
const COVERAGE_PROMPT_HEAD = 'Static check: `missing-test-coverage`';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sapui5-cov-triage-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function seed(rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

function coverageFindings(report: RunReport): readonly Finding[] {
  return report.files
    .flatMap((f) => f.findings)
    .filter((f) => f.checkId === 'missing-test-coverage');
}

function coverageCallPrompts(runner: FakeClaudeRunner): readonly string[] {
  return runner.calls.map((c) => c.prompt).filter((p) => p.includes(COVERAGE_PROMPT_HEAD));
}

function noFindingsRunner(): FakeClaudeRunner {
  return new FakeClaudeRunner([
    { match: /Static check:/, response: { raw: JSON.stringify({ findings: [] }) } },
  ]);
}

describe('runValidate — V1.9.1 Fix C: deterministic coverage triage (I4)', () => {
  test('no in-scope test imports any source → ONE rolled-up finding, 0 coverage LLM calls', async () => {
    seed('webapp/manifest.json', MANIFEST);
    seed('webapp/Component.js', 'sap.ui.define([], function () { "use strict"; });\n');
    seed('webapp/controller/A.controller.js', controller('A'));
    seed('webapp/controller/B.controller.js', controller('B'));
    // The cap_try_ts shape: an in-scope smoke test that imports NO controller.
    seed(
      'webapp/test/unit/AllTests.qunit.js',
      'QUnit.test("smoke", function (assert) { assert.ok(true); });\n',
    );

    const runner = noFindingsRunner();
    const result = await runValidate({
      projectRoot: root,
      all: true,
      force: true,
      noPrompt: true,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyFn: verifyOk,
      probeLib: probeLibAbsent,
    });

    // Exactly ONE rolled-up finding (not one per controller, not one per method).
    const cov = coverageFindings(result.report);
    expect(cov).toHaveLength(1);
    const rolled = cov[0]!;
    expect(rolled.proposedFix).toBeNull();
    // It names BOTH uncovered sources in its explanation (the documented
    // report-shape change: per-method outlines collapse into one finding).
    if (rolled.proposedFix === null) {
      expect(rolled.explanation).toContain('webapp/controller/A.controller.js');
      expect(rolled.explanation).toContain('webapp/controller/B.controller.js');
    }
    // The whole point of Fix C: zero LLM budget spent on coverage. Reverting the
    // triage makes both controllers get a per-method coverage call (2) and emits
    // no rolled-up finding — so this and the length assertion above go RED.
    expect(coverageCallPrompts(runner)).toHaveLength(0);
  });

  test('a test imports one source → that source keeps the per-method LLM check; the other rolls up', async () => {
    seed('webapp/manifest.json', MANIFEST);
    seed('webapp/Component.js', 'sap.ui.define([], function () { "use strict"; });\n');
    seed('webapp/controller/A.controller.js', controller('A'));
    seed('webapp/controller/B.controller.js', controller('B'));
    // A test that imports ONLY A's controller module id (the computeModuleId
    // form `<ns-slashes>/<webapp-rel-no-ext>`). B is imported by no test.
    seed(
      'webapp/test/unit/controller/A.controller.qunit.js',
      'sap.ui.define(["cov/app/controller/A.controller"], function (A) {\n' +
        '  "use strict";\n' +
        '  QUnit.test("loads", function (assert) { assert.ok(A); });\n' +
        '});\n',
    );

    const runner = noFindingsRunner();
    const result = await runValidate({
      projectRoot: root,
      all: true,
      force: true,
      noPrompt: true,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyFn: verifyOk,
      probeLib: probeLibAbsent,
    });

    // Exactly ONE coverage LLM call fired, and it was for A (the mapped source).
    // Reverting the triage makes B get a coverage call too → 2 calls, one
    // referencing B → both assertions below go RED. This is the load-bearing
    // proof that the triage skips ONLY the unmapped source.
    const covPrompts = coverageCallPrompts(runner);
    expect(covPrompts).toHaveLength(1);
    expect(covPrompts[0]).toContain('webapp/controller/A.controller.js');
    expect(covPrompts.some((p) => p.includes('webapp/controller/B.controller.js'))).toBe(false);

    // B (unmapped) rolled up into the deterministic finding; A (mapped) is NOT
    // named there — it took the per-method path instead.
    const cov = coverageFindings(result.report);
    const rolled = cov.filter(
      (f) => f.proposedFix === null && f.explanation.includes('webapp/controller/B.controller.js'),
    );
    expect(rolled).toHaveLength(1);
    expect(rolled[0]?.proposedFix === null && rolled[0].explanation.includes('A.controller.js')).toBe(
      false,
    );
  });
});
