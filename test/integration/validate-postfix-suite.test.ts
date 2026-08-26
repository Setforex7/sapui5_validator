/**
 * R2.2 (AUDIT §5.1, the top audit finding) — post-fix karma suite gate on
 * `validate`. Pre-R2.2, `applyAndVerifyFix` built its verify input without
 * `testFiles`, so EVERY applied fix was accepted on lint alone — `generate`
 * ran karma per artifact, `validate` never did (SPEC §2.10 step 3 / DoD
 * item 5 held for only half the product). Minimum correct version under
 * test here:
 *
 *   - fixes applied + qunit tests in scope → the suite runs ONCE (zero LLM
 *     spend); red ⇒ ALL applied fixes are reverted BYTE-EXACT and re-booked
 *     under `revertedFixes`; `report.postFixSuite` records the gate.
 *   - runner-unavailable / no qunit scope ⇒ fixes are retained and the
 *     report honestly says the gate did not run.
 *   - a failing restore during revert-all is NEVER silent: it lands in
 *     `revertFailedFiles`, on stderr, and in an `error` exit naming the
 *     file (the R2.3/Step-3 worst-case witness).
 *
 * Same harness as validate.test.ts: minimal-project copied to a tmpdir,
 * fake runner, deterministic verify adapters.
 */

import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { runValidate } from '../../src/commands/validate.js';
import { FakeClaudeRunner } from '../../src/claude/fake-runner.js';
import type { ProbeAdapter } from '../../src/project/tooling.js';
import type { VerifyAdapters } from '../../src/verify/pipeline.js';

const FIXTURE_ROOT = join(process.cwd(), 'test', 'fixtures', 'minimal-project');
const CONTROLLER_REL = 'webapp/controller/Main.controller.js';

const ALL_TOOLS_OK: ProbeAdapter = {
  probe: () => ({ present: true, version: '1.0.0', source: 'node_modules' }),
};

interface Project {
  readonly root: string;
  cleanup(): void;
}

function setupProject(): Project {
  const root = mkdtempSync(join(tmpdir(), 'sapui5-validate-r22-'));
  cpSync(FIXTURE_ROOT, root, { recursive: true });
  return {
    root,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const lintOk = async () => ({
  ok: true,
  stdout: '',
  stderr: '',
  exitCode: 0,
  durationMs: 1,
});

const KARMA_OK = {
  ok: true,
  stdout: 'Executed 2 of 2 SUCCESS',
  stderr: '',
  exitCode: 0,
  durationMs: 1,
  testFiles: [],
};

const KARMA_RED = {
  ok: false,
  stdout: 'Executed 2 of 2 (1 FAILED)',
  stderr: 'expected this.byId not to explode',
  exitCode: 1,
  durationMs: 1,
  testFiles: [],
};

/** A runner whose every prompt is a no-findings check call except the
 *  matchers supplied first. Lets `--all` runs satisfy every check. */
function runnerWith(
  matchers: ConstructorParameters<typeof FakeClaudeRunner>[0],
): FakeClaudeRunner {
  return new FakeClaudeRunner([
    ...(matchers ?? []),
    { match: /./, response: { raw: JSON.stringify({ findings: [] }) } },
  ]);
}

function domFinding(file: string, newFileContent: string) {
  return {
    checkId: 'no-direct-dom',
    file,
    line: 11,
    message: 'Uses document.getElementById; replace with this.byId().',
    proposedFix: { newFileContent },
  };
}

describe('runValidate — R2.2 post-fix suite gate', () => {
  let project: Project;

  beforeEach(() => {
    project = setupProject();
  });

  afterEach(() => {
    project.cleanup();
  });

  test('lint-clean but suite-breaking fixes → ONE suite run, ALL fixes reverted byte-exact, revertedFixes recorded, exit 1', async () => {
    const controllerAbs = join(project.root, CONTROLLER_REL);
    const originalBytes = readFileSync(controllerAbs);
    const original = originalBytes.toString('utf8');
    // Two stacked lint-clean fixes on the same file: revert-all must restore
    // the USER's original (first-write-wins snapshot), not fix 1.
    const fix1 = original.replace('document.getElementById("app")', 'this.byId("app")');
    const fix2 = fix1.replace('"data-ready"', '"data-broken"');

    let karmaCalls = 0;
    const adapters: VerifyAdapters = {
      ui5lint: lintOk,
      eslint: lintOk,
      karma: async () => {
        karmaCalls += 1;
        // Baseline probe sees the original tree (green); the post-fix gate
        // sees a fixed tree (red) — keyed off disk content, not call order.
        return readFileSync(controllerAbs, 'utf8') === original ? KARMA_OK : KARMA_RED;
      },
    };

    const runner = runnerWith([
      {
        match: (a) =>
          a.prompt.includes('Static check: `no-direct-dom`') &&
          a.prompt.includes('data-ready'),
        response: {
          raw: JSON.stringify({
            findings: [
              domFinding(CONTROLLER_REL, fix1),
              domFinding(CONTROLLER_REL, fix2),
            ],
          }),
        },
      },
    ]);

    const result = await runValidate({
      projectRoot: project.root,
      all: true,
      force: true,
      noPrompt: true,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adapters,
    });

    // Red gate ⇒ the applied fixes count as unfixed findings.
    expect(result.exitCode).toBe(1);
    expect(result.report.exitReason).toEqual({
      kind: 'unfixed-findings',
      remaining: 2,
    });

    // BYTE-EXACT restoration of the user's original — raw Buffer compare.
    expect(readFileSync(controllerAbs)).toEqual(originalBytes);

    // The gate outcome is on the report, with the reverted file listed.
    expect(result.report.postFixSuite).toBeDefined();
    expect(result.report.postFixSuite?.status).toBe('failed');
    expect(result.report.postFixSuite?.revertedFiles).toEqual([CONTROLLER_REL]);
    expect(result.report.postFixSuite?.revertFailedFiles).toBeUndefined();

    // Both applied fixes were re-booked as reverted, with the suite reason.
    const entry = result.report.files.find((f) => f.file === CONTROLLER_REL);
    expect(entry?.appliedFixes).toEqual([]);
    expect(entry?.revertedFixes).toHaveLength(2);
    for (const rf of entry?.revertedFixes ?? []) {
      expect(rf.checkId).toBe('no-direct-dom');
      expect(rf.reason).toMatch(/post-fix suite run failed/);
    }

    // Cost bound: EXACTLY one suite run beyond the baseline probe, even with
    // two applied fixes (per-fix suite runs stay deferred)...
    expect(karmaCalls).toBe(2);
    // ...and the gate consumed ZERO LLM budget: every runner call is a check
    // call (no refinement, no gate-originated prompt shape).
    expect(runner.calls.length).toBeGreaterThan(0);
    for (const call of runner.calls) {
      expect(call.prompt).toMatch(/Static check:/);
    }
  });

  test('control: a green post-fix suite retains the fixes and reports passed, exit 0', async () => {
    const controllerAbs = join(project.root, CONTROLLER_REL);
    const original = readFileSync(controllerAbs, 'utf8');
    const fix1 = original.replace('document.getElementById("app")', 'this.byId("app")');

    let karmaCalls = 0;
    const adapters: VerifyAdapters = {
      ui5lint: lintOk,
      eslint: lintOk,
      karma: async () => {
        karmaCalls += 1;
        return KARMA_OK;
      },
    };

    const runner = runnerWith([
      {
        match: (a) =>
          a.prompt.includes('Static check: `no-direct-dom`') &&
          a.prompt.includes('data-ready'),
        response: {
          raw: JSON.stringify({ findings: [domFinding(CONTROLLER_REL, fix1)] }),
        },
      },
    ]);

    const result = await runValidate({
      projectRoot: project.root,
      all: true,
      force: true,
      noPrompt: true,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adapters,
    });

    expect(result.exitCode).toBe(0);
    expect(result.report.exitReason).toEqual({ kind: 'success' });
    expect(result.report.postFixSuite).toEqual({ status: 'passed' });
    expect(readFileSync(controllerAbs, 'utf8')).toBe(fix1); // fix retained
    expect(karmaCalls).toBe(2); // baseline probe + the single gate run
    const entry = result.report.files.find((f) => f.file === CONTROLLER_REL);
    expect(entry?.appliedFixes).toEqual([
      { checkId: 'no-direct-dom', source: 'check' },
    ]);
    expect(entry?.revertedFixes).toEqual([]);
  });

  test('karma runner unavailable at the gate → fixes RETAINED, report honestly says not-run, never reverts on an env failure', async () => {
    const controllerAbs = join(project.root, CONTROLLER_REL);
    const original = readFileSync(controllerAbs, 'utf8');
    const fix1 = original.replace('document.getElementById("app")', 'this.byId("app")');

    const adapters: VerifyAdapters = {
      ui5lint: lintOk,
      eslint: lintOk,
      karma: async () =>
        readFileSync(controllerAbs, 'utf8') === original
          ? KARMA_OK
          : {
              // exitCode < 0 is exec.ts's spawn-failure/timeout contract —
              // classifyKarmaFailure reads it as runner-unavailable.
              ok: false,
              stdout: '',
              stderr: 'spawn karma ENOENT',
              exitCode: -1,
              durationMs: 1,
              testFiles: [],
            },
    };

    const runner = runnerWith([
      {
        match: (a) =>
          a.prompt.includes('Static check: `no-direct-dom`') &&
          a.prompt.includes('data-ready'),
        response: {
          raw: JSON.stringify({ findings: [domFinding(CONTROLLER_REL, fix1)] }),
        },
      },
    ]);

    const result = await runValidate({
      projectRoot: project.root,
      all: true,
      force: true,
      noPrompt: true,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adapters,
    });

    expect(result.exitCode).toBe(0);
    expect(readFileSync(controllerAbs, 'utf8')).toBe(fix1); // retained
    expect(result.report.postFixSuite?.status).toBe('not-run');
    expect(result.report.postFixSuite?.reason).toMatch(/runner unavailable/i);
    const entry = result.report.files.find((f) => f.file === CONTROLLER_REL);
    expect(entry?.appliedFixes).toHaveLength(1); // NOT reverted
  });

  test('no qunit tests in scope → gate not-run, fix retained on lint-only verification, report says so', async () => {
    const controllerAbs = join(project.root, CONTROLLER_REL);
    const original = readFileSync(controllerAbs, 'utf8');
    const fix1 = original.replace('document.getElementById("app")', 'this.byId("app")');

    let karmaCalls = 0;
    const adapters: VerifyAdapters = {
      ui5lint: lintOk,
      eslint: lintOk,
      karma: async () => {
        karmaCalls += 1;
        return KARMA_OK;
      },
    };

    const runner = runnerWith([
      {
        match: (a) => a.prompt.includes('Static check: `no-direct-dom`'),
        response: {
          raw: JSON.stringify({ findings: [domFinding(CONTROLLER_REL, fix1)] }),
        },
      },
    ]);

    const result = await runValidate({
      projectRoot: project.root,
      path: controllerAbs, // single-file scope: no qunit tests
      force: true,
      noPrompt: true,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adapters,
    });

    expect(result.exitCode).toBe(0);
    expect(readFileSync(controllerAbs, 'utf8')).toBe(fix1); // retained
    expect(result.report.postFixSuite?.status).toBe('not-run');
    expect(result.report.postFixSuite?.reason).toMatch(/no qunit test files in scope/);
    expect(karmaCalls).toBe(0); // no baseline probe, no gate — karma never ran
  });

  test('WORST CASE: a restore failure mid-revert-all is fully REPORTED — error exit names the file, the rest still revert', async () => {
    const SECOND_REL = 'webapp/controller/Second.controller.js';
    const mainAbs = join(project.root, CONTROLLER_REL);
    const secondAbs = join(project.root, SECOND_REL);
    const secondOriginal = [
      'sap.ui.define([',
      '  "sap/ui/core/mvc/Controller"',
      '], function (Controller) {',
      '  "use strict";',
      '  // SECOND-CONTROLLER-MARKER',
      '  return Controller.extend("minimal.project.controller.Second", {',
      '    onInit: function () {',
      '      var el = document.getElementById("second");',
      '      if (el) { el.setAttribute("data-x", "1"); }',
      '    }',
      '  });',
      '});',
      '',
    ].join('\n');
    writeFileSync(secondAbs, secondOriginal, 'utf8');

    const mainOriginalBytes = readFileSync(mainAbs);
    const mainOriginal = mainOriginalBytes.toString('utf8');
    const mainFix = mainOriginal.replace(
      'document.getElementById("app")',
      'this.byId("app")',
    );
    const secondFix = secondOriginal.replace(
      'document.getElementById("second")',
      'this.byId("second")',
    );

    const adapters: VerifyAdapters = {
      ui5lint: lintOk,
      eslint: lintOk,
      karma: async () => {
        if (readFileSync(mainAbs, 'utf8') === mainOriginal) return KARMA_OK; // baseline
        // The post-fix gate: report red AND sabotage the upcoming revert of
        // Second.controller.js by replacing the file with a directory —
        // writeFile then fails (EISDIR), simulating a throw mid-revert-all.
        rmSync(secondAbs, { force: true });
        mkdirSync(secondAbs);
        return KARMA_RED;
      },
    };

    const runner = runnerWith([
      {
        match: (a) =>
          a.prompt.includes('Static check: `no-direct-dom`') &&
          a.prompt.includes('data-ready'),
        response: {
          raw: JSON.stringify({ findings: [domFinding(CONTROLLER_REL, mainFix)] }),
        },
      },
      {
        match: (a) =>
          a.prompt.includes('Static check: `no-direct-dom`') &&
          a.prompt.includes('SECOND-CONTROLLER-MARKER'),
        response: {
          raw: JSON.stringify({ findings: [domFinding(SECOND_REL, secondFix)] }),
        },
      },
    ]);

    const stderrChunks: string[] = [];
    const result = await runValidate({
      projectRoot: project.root,
      all: true,
      force: true,
      noPrompt: true,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adapters,
      warningStream: new (await import('node:stream')).Writable({
        write(chunk: Buffer | string, _enc, cb) {
          stderrChunks.push(String(chunk));
          cb();
        },
      }),
    });

    // NEVER silent: the run exits with an error reason NAMING the file whose
    // unverified fix is still on disk — it outranks unfixed-findings.
    expect(result.exitCode).toBe(1);
    expect(result.report.exitReason.kind).toBe('error');
    if (result.report.exitReason.kind === 'error') {
      expect(result.report.exitReason.message).toMatch(/could NOT be reverted/);
      expect(result.report.exitReason.message).toContain(SECOND_REL);
    }

    // Best-effort: the OTHER file still reverted, byte-exact.
    expect(readFileSync(mainAbs)).toEqual(mainOriginalBytes);

    // The report states exactly which reverted and which did not.
    expect(result.report.postFixSuite?.status).toBe('failed');
    expect(result.report.postFixSuite?.revertedFiles).toEqual([CONTROLLER_REL]);
    expect(result.report.postFixSuite?.revertFailedFiles).toEqual([SECOND_REL]);

    // Per-file booking is honest: Main's fix moved to revertedFixes; Second's
    // fix STAYS in appliedFixes (it is, factually, still applied on disk).
    const mainEntry = result.report.files.find((f) => f.file === CONTROLLER_REL);
    expect(mainEntry?.appliedFixes).toEqual([]);
    expect(mainEntry?.revertedFixes).toHaveLength(1);
    const secondEntry = result.report.files.find((f) => f.file === SECOND_REL);
    expect(secondEntry?.appliedFixes).toHaveLength(1);

    // ...and the warning stream named the failure too.
    expect(stderrChunks.join('')).toMatch(/reverting .*Second\.controller\.js also failed/);
  });
});
