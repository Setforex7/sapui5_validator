/**
 * SPEC §2.10 / PLAN.md Session 8 end-to-end coverage for the `validate`
 * orchestrator. The fixture is the static `minimal-project`; we copy it into
 * a fresh tmpdir per test, run `runValidate` with a fake `ClaudeRunner` and
 * deterministic verify adapters, then inspect the on-disk report and audit
 * log. Two scenarios:
 *   1. happy path — the LLM proposes a fix, verify accepts it, exit 0,
 *      report.json reflects the applied fix, audit-log skeleton exists.
 *   2. retry-then-revert — the LLM proposes broken fixes 3×; the file is
 *      restored byte-for-byte, the finding is recorded as reverted, exit 1.
 */

import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { REFINE_CONTENT_CAP_BYTES, runValidate } from '../../src/commands/validate.js';
import { program } from '../../src/cli.js';
import { FakeClaudeRunner } from '../../src/claude/fake-runner.js';
import { RateLimitExhaustedError } from '../../src/claude/binary-runner.js';
import { formatExitMessage } from '../../src/output/messages.js';
import type { MenuIo } from '../../src/budget/menu.js';
import type { ProbeAdapter } from '../../src/project/tooling.js';
import type { VerifyAdapters } from '../../src/verify/pipeline.js';
import type { RunReport } from '../../src/types.js';

const FIXTURE_ROOT = join(process.cwd(), 'test', 'fixtures', 'minimal-project');
const DIRTY_FIXTURE_ROOT = join(process.cwd(), 'test', 'fixtures', 'dirty-baseline');
const CONTROLLER_REL = 'webapp/controller/Main.controller.js';
const DIRTY_CONTROLLER_REL = 'webapp/controller/Broken.controller.js';

/**
 * V1.9.7 (THR-1) — the effective `--concurrency` default commander applies for a
 * command, read off the registered CLI option (mirrors cli-concurrency.test.ts).
 * The equivalence witness passes THIS to the orchestrator so it tracks the real
 * CLI default; the `> 1` guard fails loudly if it is ever reset to 1 (which would
 * silently turn the witness into a vacuous K=1-vs-K=1 compare).
 */
function cliConcurrencyDefault(command: 'validate' | 'generate'): number {
  const cmd = program.commands.find((c: Command) => c.name() === command);
  const opt = cmd?.options.find((o) => o.long === '--concurrency');
  if (opt === undefined) throw new Error(`--concurrency not registered on ${command}`);
  return opt.defaultValue as number;
}

const ALL_TOOLS_OK: ProbeAdapter = {
  probe: () => ({ present: true, version: '1.0.0', source: 'node_modules' }),
};

function adaptersOk(): VerifyAdapters {
  return {
    ui5lint: async () => ({ ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1 }),
    eslint: async () => ({ ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1 }),
    karma: async () => ({
      ok: true,
      stdout: '',
      stderr: '',
      exitCode: 0,
      durationMs: 1,
      testFiles: [],
    }),
  };
}

interface Project {
  readonly root: string;
  cleanup(): void;
}

function setupProject(): Project {
  return setupFrom(FIXTURE_ROOT);
}

function setupFrom(fixture: string): Project {
  const root = mkdtempSync(join(tmpdir(), 'sapui5-validate-'));
  cpSync(fixture, root, { recursive: true });
  return {
    root,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe('runValidate — audit log routing (SPEC §2.18)', () => {
  let project: Project;
  beforeEach(() => {
    project = setupProject();
  });
  afterEach(() => {
    project.cleanup();
  });

  test('default writes audit log to last-run/ (and not runs/)', async () => {
    const runner = new FakeClaudeRunner([
      { match: /Static check:/, response: { raw: JSON.stringify({ findings: [] }) } },
    ]);
    await runValidate({
      projectRoot: project.root,
      force: true,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adaptersOk(),
    });
    expect(
      statSync(join(project.root, '.sapui5-validator', 'last-run')).isDirectory(),
    ).toBe(true);
    expect(existsSync(join(project.root, '.sapui5-validator', 'runs'))).toBe(false);
  });

  test('--keep-history writes audit log to runs/<ISO>/ (and not last-run/)', async () => {
    const runner = new FakeClaudeRunner([
      { match: /Static check:/, response: { raw: JSON.stringify({ findings: [] }) } },
    ]);
    await runValidate({
      projectRoot: project.root,
      force: true,
      keepHistory: true,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adaptersOk(),
    });
    const runsDir = join(project.root, '.sapui5-validator', 'runs');
    expect(statSync(runsDir).isDirectory()).toBe(true);
    // exactly one ISO-timestamped subdirectory
    const { readdirSync } = await import('node:fs');
    const subdirs = readdirSync(runsDir);
    expect(subdirs).toHaveLength(1);
    expect(subdirs[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/);
    expect(
      existsSync(join(project.root, '.sapui5-validator', 'last-run')),
    ).toBe(false);
  });
});

describe('runValidate — budget exhausted (SPEC §2.12, DoD #9)', () => {
  let project: Project;
  beforeEach(() => {
    project = setupProject();
  });
  afterEach(() => {
    project.cleanup();
  });
  test('maxLlmCalls=1 on a multi-check fixture → budget-exhausted, exit 1, partial progress', async () => {
    const runner = new FakeClaudeRunner([
      { match: /Static check:/, response: { raw: JSON.stringify({ findings: [] }) } },
    ]);
    const result = await runValidate({
      projectRoot: project.root,
      force: true,
      maxLlmCalls: 1,
      // V1.2-2: the default --per-check-cap 35% on a budget of 1 yields a
      // per-category cap of 0 (all calls skipped before any LLM is invoked),
      // which would short-circuit the budget exhaustion this test exists to
      // exercise. Disable the cap by setting it to 100% so the budget is the
      // only constraint, matching the pre-V1.2-2 semantics this test targets.
      perCheckCap: 100,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adaptersOk(),
    });
    expect(result.exitCode).toBe(1);
    expect(result.report.exitReason.kind).toBe('budget-exhausted');
    if (result.report.exitReason.kind === 'budget-exhausted') {
      expect(result.report.exitReason.calls).toBeGreaterThan(0);
    }
    expect(result.report.llmCallBudget).toBe(1);
    // Partial progress: at least one LLM call was attempted before exhaustion.
    expect(result.report.llmCallCount).toBe(1);
    // report.json was written even though we exited non-zero.
    expect(
      existsSync(join(project.root, '.sapui5-validator', 'report.json')),
    ).toBe(true);
  });
});

describe('runValidate — missing-claude hard fail (SPEC §2.12)', () => {
  let project: Project;
  beforeEach(() => {
    project = setupProject();
  });
  afterEach(() => {
    project.cleanup();
  });
  test('availabilityProbe returning ok:false short-circuits with missing-claude', async () => {
    const runner = new FakeClaudeRunner([]);
    const result = await runValidate({
      projectRoot: project.root,
      force: true,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adaptersOk(),
      availabilityProbe: async () => ({
        ok: false,
        reason: 'command not found',
        message: 'Install: npm i -g @anthropic-ai/claude-code, then run `claude /login` to authenticate.',
      }),
    });
    expect(result.exitCode).toBe(1);
    expect(result.report.exitReason).toEqual({ kind: 'missing-claude' });
    expect(result.report.llmCallCount).toBe(0);
    expect(result.report.files).toEqual([]);
  });

  test('TR-2 (V1.9.6): a successful availability probe records claudeVersion in the report, on disk, and in the audit trail', async () => {
    const controllerAbs = join(project.root, CONTROLLER_REL);
    // Catch-all: every check returns no findings, so the run completes cleanly
    // (exit 0, no fixes) and the only thing under test is the recorded version.
    const runner = new FakeClaudeRunner([
      { match: () => true, response: { raw: JSON.stringify({ findings: [] }) } },
    ]);
    const result = await runValidate({
      projectRoot: project.root,
      path: controllerAbs,
      force: true,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adaptersOk(),
      availabilityProbe: async () => ({ ok: true, version: '2.1.200 (Claude Code)' }),
    });

    // Fail-on-revert guard (b): the probed CLI version must land in the report
    // object, in the written report.json, and in the audit trail. If the wiring
    // is reverted, all three assertions fail.
    expect(result.report.claudeVersion).toBe('2.1.200 (Claude Code)');
    // Additive field must NOT bump the schema version.
    expect(result.report.schemaVersion).toBe(2);

    const reportPath = join(project.root, '.sapui5-validator', 'report.json');
    const reportFromDisk = JSON.parse(readFileSync(reportPath, 'utf8')) as RunReport;
    expect(reportFromDisk.claudeVersion).toBe('2.1.200 (Claude Code)');

    const versionStamp = join(project.root, '.sapui5-validator', 'last-run', 'cli-version.txt');
    expect(existsSync(versionStamp)).toBe(true);
    expect(readFileSync(versionStamp, 'utf8').trim()).toBe('2.1.200 (Claude Code)');
  });
});

describe('runValidate — happy path on minimal-project (no-direct-dom)', () => {
  let project: Project;

  beforeEach(() => {
    project = setupProject();
  });

  afterEach(() => {
    project.cleanup();
  });

  test('applies the proposed fix, exits 0, writes report.json + last-run/', async () => {
    const controllerAbs = join(project.root, CONTROLLER_REL);
    const fixedContent = readFileSync(controllerAbs, 'utf8').replace(
      'document.getElementById("app")',
      'this.byId("app")',
    );

    const runner = new FakeClaudeRunner([
      {
        match: /Static check: `no-direct-dom`/,
        response: {
          raw: JSON.stringify({
            findings: [
              {
                checkId: 'no-direct-dom',
                file: CONTROLLER_REL,
                line: 11,
                message: 'Uses document.getElementById; replace with this.byId().',
                proposedFix: { newFileContent: fixedContent },
              },
            ],
          }),
        },
      },
      {
        match: /Static check: `no-sync-odata`/,
        response: { raw: JSON.stringify({ findings: [] }) },
      },
      {
        match: /Static check: `missing-test-coverage`/,
        response: { raw: JSON.stringify({ findings: [] }) },
      },
    ]);

    const result = await runValidate({
      projectRoot: project.root,
      path: controllerAbs,
      force: true,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adaptersOk(),
    });

    expect(result.exitCode).toBe(0);
    expect(result.report.exitReason).toEqual({ kind: 'success' });
    expect(result.report.schemaVersion).toBe(2);
    expect(result.report.command).toBe('validate');
    // V1.9.4 PERF-2: the 3 controller-js checks (no-direct-dom, no-sync-odata,
    // missing-test-coverage) now share ONE batched LLM call for this single
    // controller (was 3 separate calls). 3N→N.
    expect(result.report.llmCallCount).toBe(1);
    // One file entry, one applied no-direct-dom fix, no reverts.
    expect(result.report.files).toHaveLength(1);
    const entry = result.report.files[0]!;
    expect(entry.file).toBe(CONTROLLER_REL);
    expect(entry.appliedFixes).toEqual([{ checkId: 'no-direct-dom', source: 'check' }]);
    expect(entry.revertedFixes).toEqual([]);

    // The fix actually landed on disk.
    expect(readFileSync(controllerAbs, 'utf8')).toBe(fixedContent);

    // report.json + last-run/ structure
    const reportPath = join(project.root, '.sapui5-validator', 'report.json');
    expect(existsSync(reportPath)).toBe(true);
    const reportFromDisk = JSON.parse(readFileSync(reportPath, 'utf8')) as RunReport;
    expect(reportFromDisk.exitCode).toBe(0);
    const lastRun = join(project.root, '.sapui5-validator', 'last-run');
    expect(statSync(lastRun).isDirectory()).toBe(true);
    for (const sub of ['prompts', 'responses', 'verify']) {
      expect(statSync(join(lastRun, sub)).isDirectory()).toBe(true);
    }
  });

  test('PERF-1: report.json sums per-call envelope usage/cost (schemaVersion stays 2)', async () => {
    // Every LLM call carries an envelope `usage`/`total_cost_usd`
    // (FakeRunnerResponse = Partial<ClaudeRunResult> — PERF-15 needs no fake
    // change once the fields exist). finish() must SUM all four token fields
    // across the run and keep the report additive at schemaVersion 2. Reverting
    // the accumulator / finish() wiring drops `report.usage` and goes red.
    // V1.9.4 PERF-2/8: `--all` exercises a genuine MULTI-call sum after batching —
    // 1 controller batch + 1 view batch + 2 missing-teardown + 1 manifest-drift =
    // 5 LLM calls on minimal-project (1 controller + 1 view + 2 qunit + project).
    const perCallUsage = {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 100,
      cacheCreationTokens: 200,
    };
    const runner = new FakeClaudeRunner([
      {
        match: /Static check:/,
        response: {
          raw: JSON.stringify({ findings: [] }),
          usage: perCallUsage,
          totalCostUsd: 0.01,
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
      verifyAdapters: adaptersOk(),
    });

    expect(result.report.llmCallCount).toBe(5);
    expect(result.report.schemaVersion).toBe(2);
    const expectedSum = {
      inputTokens: 50,
      outputTokens: 25,
      cacheReadTokens: 500,
      cacheCreationTokens: 1000,
    };
    expect(result.report.usage).toEqual(expectedSum);
    expect(result.report.totalCostUsd).toBeCloseTo(0.05, 8);

    // The persisted report.json carries the additive fields too.
    const reportFromDisk = JSON.parse(
      readFileSync(join(project.root, '.sapui5-validator', 'report.json'), 'utf8'),
    ) as RunReport;
    expect(reportFromDisk.usage).toEqual(expectedSum);
    expect(reportFromDisk.schemaVersion).toBe(2);
  });
});

describe('runValidate — retry-then-revert', () => {
  let project: Project;

  beforeEach(() => {
    project = setupProject();
  });

  afterEach(() => {
    project.cleanup();
  });

  test('3× broken fix → file restored byte-for-byte, finding reverted, exit 1', async () => {
    const controllerAbs = join(project.root, CONTROLLER_REL);
    const original = readFileSync(controllerAbs, 'utf8');

    // First call: initial proposedFix (broken). Refinements (2 more LLM
    // calls) also return broken `newFileContent` payloads. After 3 attempts
    // the orchestrator reverts.
    let initialCall = 0;
    let refineCall = 0;
    const runner = new FakeClaudeRunner([
      // Most-specific matcher first: refinement prompts have a distinctive
      // header that none of the check prompts include.
      {
        match: (args) => args.prompt.includes('did not pass verification'),
        response: () => {
          refineCall += 1;
          return {
            raw: JSON.stringify({ newFileContent: `// BROKEN REFINEMENT ${refineCall}\n` }),
          };
        },
      },
      {
        match: /Static check: `no-direct-dom`/,
        response: () => {
          initialCall += 1;
          return {
            raw: JSON.stringify({
              findings: [
                {
                  checkId: 'no-direct-dom',
                  file: CONTROLLER_REL,
                  message: 'Uses document.getElementById.',
                  proposedFix: { newFileContent: '// BROKEN INITIAL\n' },
                },
              ],
            }),
          };
        },
      },
      {
        match: /Static check: `no-sync-odata`/,
        response: { raw: JSON.stringify({ findings: [] }) },
      },
      {
        match: /Static check: `missing-test-coverage`/,
        response: { raw: JSON.stringify({ findings: [] }) },
      },
    ]);

    // Baseline (pre-fix) verify needs to pass so we even enter the check
    // loop. We special-case the first ui5lint call (baseline probe) to
    // return ok, and the subsequent ones (during fix attempts) to fail.
    let ui5LintCalls = 0;
    const failingAdapters: VerifyAdapters = {
      ui5lint: async () => {
        ui5LintCalls += 1;
        if (ui5LintCalls === 1) {
          return { ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1 };
        }
        return {
          ok: false,
          stdout: '',
          stderr: 'ui5lint error: parse failure',
          exitCode: 1,
          durationMs: 1,
        };
      },
      eslint: async () => ({ ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1 }),
      karma: async () => ({
        ok: true,
        stdout: '',
        stderr: '',
        exitCode: 0,
        durationMs: 1,
        testFiles: [],
      }),
    };

    const result = await runValidate({
      projectRoot: project.root,
      path: controllerAbs,
      force: true,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: failingAdapters,
    });

    expect(result.exitCode).toBe(1);
    expect(result.report.exitReason.kind).toBe('unfixed-findings');
    if (result.report.exitReason.kind === 'unfixed-findings') {
      expect(result.report.exitReason.remaining).toBe(1);
    }

    // File restored to its original bytes.
    expect(readFileSync(controllerAbs, 'utf8')).toBe(original);

    // The finding was recorded as reverted, not applied.
    expect(result.report.files).toHaveLength(1);
    const entry = result.report.files[0]!;
    expect(entry.appliedFixes).toEqual([]);
    expect(entry.revertedFixes).toHaveLength(1);
    expect(entry.revertedFixes[0]?.checkId).toBe('no-direct-dom');
    expect(entry.revertedFixes[0]?.reason).toMatch(/ui5lint|verification/i);

    // The LLM was hit once for the initial finding and twice for refinements
    // (rounds 2 and 3 of the apply-and-verify loop).
    expect(initialCall).toBe(1);
    expect(refineCall).toBe(2);
    // V1.9.4 PERF-2: the 3 controller checks are ONE batched call now (which
    // matched the no-direct-dom script entry and returned the broken finding),
    // so the budget is 1 batch + 2 refinements = 3 (was 3 checks + 2 = 5).
    expect(result.report.llmCallCount).toBe(3);
  });

  test('V1.9.4 PERF-12: an oversized broken fix → report.contentTruncations is recorded', async () => {
    const controllerAbs = join(project.root, CONTROLLER_REL);
    const original = readFileSync(controllerAbs, 'utf8');

    // An OVER-cap broken initial proposedFix → the first refinement prompt embeds
    // it and byte-caps it (count 1). The refinements return small broken content
    // (under cap, no further truncation), so the run reverts after 3 attempts.
    const padding = '  // padding to exceed the refinement content byte cap ------------\n';
    const oversizedFix = `sap.ui.define([], function () {\n${padding.repeat(
      Math.ceil((REFINE_CONTENT_CAP_BYTES * 2) / padding.length),
    )}});\n`;
    expect(Buffer.byteLength(oversizedFix, 'utf8')).toBeGreaterThan(REFINE_CONTENT_CAP_BYTES);

    let refineCall = 0;
    const runner = new FakeClaudeRunner([
      {
        match: (args) => args.prompt.includes('did not pass verification'),
        response: () => {
          refineCall += 1;
          return { raw: JSON.stringify({ newFileContent: `// BROKEN REFINEMENT ${refineCall}\n` }) };
        },
      },
      {
        match: /Static check: `no-direct-dom`/,
        response: {
          raw: JSON.stringify({
            findings: [
              {
                checkId: 'no-direct-dom',
                file: CONTROLLER_REL,
                message: 'Uses document.getElementById.',
                proposedFix: { newFileContent: oversizedFix },
              },
            ],
          }),
        },
      },
      { match: /Static check: `no-sync-odata`/, response: { raw: JSON.stringify({ findings: [] }) } },
      {
        match: /Static check: `missing-test-coverage`/,
        response: { raw: JSON.stringify({ findings: [] }) },
      },
    ]);

    let ui5LintCalls = 0;
    const failingAdapters: VerifyAdapters = {
      ui5lint: async () => {
        ui5LintCalls += 1;
        if (ui5LintCalls === 1) {
          return { ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1 };
        }
        return { ok: false, stdout: '', stderr: 'ui5lint error: parse failure', exitCode: 1, durationMs: 1 };
      },
      eslint: async () => ({ ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1 }),
      karma: async () => ({ ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1, testFiles: [] }),
    };

    const result = await runValidate({
      projectRoot: project.root,
      path: controllerAbs,
      force: true,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: failingAdapters,
    });

    // The fix still reverts (the broken content never verifies) — truncation does
    // not change the acceptance bar — but the truncation is now visible in the
    // report (exactly one: the first refinement embedded the oversized fix).
    expect(result.report.exitReason.kind).toBe('unfixed-findings');
    expect(readFileSync(controllerAbs, 'utf8')).toBe(original);
    expect(result.report.contentTruncations).toBe(1);
    expect(refineCall).toBe(2);
  });
});

describe('runValidate — SPEC §2.3 baseline-fix-via-LLM (dirty-baseline)', () => {
  let project: Project;

  beforeEach(() => {
    project = setupFrom(DIRTY_FIXTURE_ROOT);
  });

  afterEach(() => {
    project.cleanup();
  });

  test('baseline ui5lint failure flows through the fix loop, LLM bootstraps a fix, exit 0', async () => {
    const controllerAbs = join(project.root, DIRTY_CONTROLLER_REL);
    const original = readFileSync(controllerAbs, 'utf8');
    const fixedContent = `${original}\n// Fixed by LLM (baseline-ui5lint)\n`;

    // Baseline pre-pass: ui5lint fails on the controller. Once the LLM-
    // proposed fix is written, the next ui5lint call (during the verify
    // step of the fix loop) succeeds. We toggle behaviour by inspecting
    // disk so the orchestrator's write+verify sequence is honoured.
    let ui5LintCalls = 0;
    const baselineStderr =
      'webapp/controller/Broken.controller.js:13:7 - error  unused: declared but never used';
    const verifyAdapters: VerifyAdapters = {
      ui5lint: async ({ file }) => {
        ui5LintCalls += 1;
        if (file === undefined) throw new Error('ui5lint adapter called without a file');
        const current = readFileSync(file, 'utf8');
        if (current === original) {
          return {
            ok: false,
            stdout: '',
            stderr: baselineStderr,
            exitCode: 1,
            durationMs: 1,
          };
        }
        return { ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1 };
      },
      eslint: async () => ({ ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1 }),
      karma: async () => ({
        ok: true,
        stdout: '',
        stderr: '',
        exitCode: 0,
        durationMs: 1,
        testFiles: [],
      }),
    };

    let baselineFixCalls = 0;
    let semanticChecks = 0;
    const runner = new FakeClaudeRunner([
      // Refinement / bootstrap matches first: the prompt for the baseline
      // initial fix call uses the same template as a check-fix refinement,
      // so we route both through this branch.
      {
        match: (args) => args.prompt.includes('did not pass verification'),
        response: () => {
          baselineFixCalls += 1;
          return { raw: JSON.stringify({ newFileContent: fixedContent }) };
        },
      },
      // The check loop's prompts come next; we return empty findings since
      // this test focuses on the baseline path.
      {
        match: /Static check:/,
        response: () => {
          semanticChecks += 1;
          return { raw: JSON.stringify({ findings: [] }) };
        },
      },
    ]);

    const result = await runValidate({
      projectRoot: project.root,
      path: controllerAbs,
      force: true,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters,
    });

    expect(result.exitCode).toBe(0);
    expect(result.report.exitReason).toEqual({ kind: 'success' });

    // The baseline finding was synthesised and recorded with source 'baseline'.
    const entries = result.report.files;
    expect(entries).toHaveLength(1);
    const fileEntry = entries[0]!;
    expect(fileEntry.file).toBe(DIRTY_CONTROLLER_REL);
    expect(fileEntry.findings).toHaveLength(1);
    const baselineFinding = fileEntry.findings[0]!;
    expect(baselineFinding.checkId).toBe('baseline-ui5lint');
    expect(baselineFinding.source).toBe('baseline');
    expect(baselineFinding.proposedFix).toBeNull();
    if (baselineFinding.proposedFix === null) {
      expect(baselineFinding.explanation).toBe(baselineStderr);
    }
    expect(fileEntry.appliedFixes).toEqual([
      { checkId: 'baseline-ui5lint', source: 'baseline' },
    ]);
    expect(fileEntry.revertedFixes).toEqual([]);

    // The LLM bootstrapped exactly one initial baseline fix (no refinements
    // needed because verify passed after the first attempt).
    expect(baselineFixCalls).toBe(1);
    // V1.9.4 PERF-2: the controller-js checks (no-direct-dom, no-sync-odata,
    // missing-test-coverage) now share ONE batched call (was 3), so 1 bootstrap
    // + 1 batch = 2. The batch prompt still carries each "Static check: `<id>`"
    // header, so the `/Static check:/` counter sees exactly 1 match.
    expect(semanticChecks).toBe(1);
    expect(result.report.llmCallCount).toBe(2);

    // The fix is on disk.
    expect(readFileSync(controllerAbs, 'utf8')).toBe(fixedContent);
    // ui5lint was called: once during baseline collection (failed),
    // and once during the fix-loop verify (passed).
    expect(ui5LintCalls).toBe(2);
  });

  test('karma config error during baseline is unattributable → baseline-failed exit', async () => {
    const verifyAdapters: VerifyAdapters = {
      ui5lint: async () => ({ ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1 }),
      eslint: async () => ({ ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1 }),
      karma: async () => ({
        ok: false,
        stdout: '',
        stderr: 'karma config error: missing reporter package',
        exitCode: 1,
        durationMs: 1,
        testFiles: [],
      }),
    };
    // Trigger karma in the baseline probe by including a qunit test file in
    // scope. We point validate at a real .qunit.js path from the fixture
    // (the dirty-baseline fixture has none, so synthesize one on disk).
    const testRel = 'webapp/test/unit/controller/Broken.controller.qunit.js';
    const testAbs = join(project.root, testRel);
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(project.root, 'webapp', 'test', 'unit', 'controller'), {
      recursive: true,
    });
    writeFileSync(testAbs, 'QUnit.test("noop", function () {});\n', 'utf8');

    const runner = new FakeClaudeRunner([
      { match: /./, response: { raw: JSON.stringify({ findings: [] }) } },
    ]);

    const result = await runValidate({
      projectRoot: project.root,
      path: testAbs,
      force: true,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters,
    });

    expect(result.exitCode).toBe(1);
    expect(result.report.exitReason).toEqual({ kind: 'baseline-failed' });
    // No LLM calls — the run aborted before the fix loop.
    expect(result.report.llmCallCount).toBe(0);
  });
});

describe('runValidate — V1.2-2 per-category call cap', () => {
  let project: Project;
  beforeEach(() => {
    project = setupProject();
  });
  afterEach(() => {
    project.cleanup();
  });

  function noFindingsRunner(): FakeClaudeRunner {
    return new FakeClaudeRunner([
      { match: /Static check:/, response: { raw: JSON.stringify({ findings: [] }) } },
    ]);
  }

  function memWritable(sink: string[]): NodeJS.WritableStream {
    return new Writable({
      write(chunk: Buffer | string, _enc, cb) {
        sink.push(chunk.toString());
        cb();
      },
    });
  }

  test('cap of 10% on budget=10 caps missing-teardown (2 qunit targets, cap=1) and records the skip', async () => {
    // minimal-project has 2 qunit tests; missing-teardown runs once per
    // qunit file. perCheckCap = floor(10 × 10 / 100) = 1, so the second
    // qunit-scope call for missing-teardown must be skipped and recorded.
    const result = await runValidate({
      projectRoot: project.root,
      force: true,
      maxLlmCalls: 10,
      perCheckCap: 10,
      runner: noFindingsRunner(),
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adaptersOk(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.report.exitReason).toEqual({ kind: 'success' });
    // missing-teardown is the only check with > 1 target on this fixture, so
    // it is the only category that should hit the cap.
    expect(result.report.cappedChecks).toEqual({ 'missing-teardown': 1 });
  });

  test('cap of 100% behaves identically to no-cap (no cappedChecks in report)', async () => {
    const result = await runValidate({
      projectRoot: project.root,
      force: true,
      maxLlmCalls: 50,
      perCheckCap: 100,
      runner: noFindingsRunner(),
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adaptersOk(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.report.exitReason).toEqual({ kind: 'success' });
    expect(result.report.cappedChecks).toBeUndefined();
  });

  test('cap of 5% on budget=10 produces per-category cap of 0, emits warning, runs no LLM calls', async () => {
    const warnings: string[] = [];
    const result = await runValidate({
      projectRoot: project.root,
      force: true,
      maxLlmCalls: 10,
      perCheckCap: 5,
      runner: noFindingsRunner(),
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adaptersOk(),
      warningStream: memWritable(warnings),
    });
    // The cap-0 warning must be emitted with the user-actionable phrasing
    // from the V1.2 plan ("Increase --per-check-cap or --max-llm-calls").
    expect(warnings.join('')).toMatch(/per-check-cap of 5% on 10 total calls/);
    expect(warnings.join('')).toMatch(/no LLM analysis will run/);
    expect(warnings.join('')).toMatch(/Increase --per-check-cap or --max-llm-calls/);
    // No LLM calls were consumed because every category was capped at 0.
    expect(result.report.llmCallCount).toBe(0);
    // Every dispatched check was skipped; per-category skip counts mirror the
    // estimator's controller-js/view-xml/qunit-test/project breakdown for the
    // minimal-project fixture (1 controller × 3 checks, 1 view × 2 checks,
    // 2 qunit tests × 1 check, project × 1 check).
    expect(result.report.cappedChecks).toEqual({
      'no-direct-dom': 1,
      'no-sync-odata': 1,
      'missing-test-coverage': 1,
      'missing-i18n': 1,
      'globals-in-views': 1,
      'missing-teardown': 2,
      'manifest-component-drift': 1,
    });
    // C2 (V1.5): a per-category cap of 0 disabled every check BEFORE any
    // budget.consume(), so the run must NOT report a vacuous `success` — it
    // exits budget-exhausted (SPEC DoD item 9), even though no call was made.
    expect(result.exitCode).toBe(1);
    expect(result.report.exitReason).toEqual({ kind: 'budget-exhausted', calls: 0 });
  });

  test('C2 (V1.5): --max-llm-calls 1 with the default cap exits budget-exhausted, not success (DoD item 9)', async () => {
    // Default --per-check-cap 35 → perCategoryCap = floor(35 × 1 / 100) = 0, so
    // every semantic check short-circuits before consuming the single call.
    // Pre-fix this exited 0/success with zero analysis; it must exit non-zero
    // with the budget reason on a non-empty scope.
    const result = await runValidate({
      projectRoot: project.root,
      force: true,
      maxLlmCalls: 1,
      noPrompt: true,
      runner: noFindingsRunner(),
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adaptersOk(),
    });
    expect(result.exitCode).toBe(1);
    expect(result.report.exitReason).toEqual({ kind: 'budget-exhausted', calls: 0 });
    expect(result.report.llmCallCount).toBe(0);
  });

  test('default --per-check-cap (35) applies when the orchestrator caller omits perCheckCap', async () => {
    // With maxLlmCalls=10 and the implicit default of 35, perCategoryCap =
    // floor(35 × 10 / 100) = 3. missing-teardown has 2 qunit targets, well
    // under 3, so no skips occur and cappedChecks remains absent.
    const result = await runValidate({
      projectRoot: project.root,
      force: true,
      maxLlmCalls: 10,
      // perCheckCap intentionally omitted — orchestrator must use the default.
      runner: noFindingsRunner(),
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adaptersOk(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.report.cappedChecks).toBeUndefined();
  });
});

describe('runValidate — V1.2-1 dynamic call-limit menu wiring', () => {
  let project: Project;
  beforeEach(() => {
    project = setupProject();
  });
  afterEach(() => {
    project.cleanup();
  });

  function noFindingsRunner(): FakeClaudeRunner {
    return new FakeClaudeRunner([
      { match: /Static check:/, response: { raw: JSON.stringify({ findings: [] }) } },
    ]);
  }

  function memoryWritable(sink: string[]): NodeJS.WritableStream {
    return new Writable({
      write(chunk: Buffer | string, _enc, cb) {
        sink.push(chunk.toString());
        cb();
      },
    });
  }

  function ttyIo(lines: readonly string[]): {
    readonly menuIo: MenuIo;
    readonly stdout: string[];
    readonly stderr: string[];
  } {
    const stdin = new PassThrough();
    const stdout: string[] = [];
    const stderr: string[] = [];
    for (const line of lines) stdin.write(`${line}\n`);
    stdin.end();
    return {
      menuIo: {
        stdin,
        stdout: memoryWritable(stdout),
        stderr: memoryWritable(stderr),
        isTty: true,
      },
      stdout,
      stderr,
    };
  }

  test('menu fires when recommended > maxLlmCalls and "continue" keeps the original budget', async () => {
    // minimal-project resolves to 1 controller + 1 view + 2 qunit tests (4
    // files), includesProjectScope=true. Estimator math:
    //   controllerJs(1) × 3 + viewXml(1) × 2 + qunitTest(2) × 1 + project = 8
    //   recommended = ceil(8 × 1.5) = 12
    // Setting maxLlmCalls=3 forces recommended (12) > current (3) → menu shown.
    const io = ttyIo(['1']);
    const result = await runValidate({
      projectRoot: project.root,
      force: true,
      maxLlmCalls: 3,
      runner: noFindingsRunner(),
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adaptersOk(),
      menuIo: io.menuIo,
    });
    // Menu was printed.
    expect(io.stdout.join('')).toMatch(/Estimated 8-12 LLM calls/);
    // User chose continue → budget stays at 3; first three checks burn the
    // budget, the rest report budget-exhausted.
    expect(result.report.llmCallBudget).toBe(3);
    expect(result.report.exitReason.kind).toBe('budget-exhausted');
  });

  test('option 2 (accept) raises the limit to recommended for the rest of the run', async () => {
    const io = ttyIo(['2']);
    const result = await runValidate({
      projectRoot: project.root,
      force: true,
      maxLlmCalls: 3,
      runner: noFindingsRunner(),
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adaptersOk(),
      menuIo: io.menuIo,
    });
    // recommended for the minimal fixture is 12 (see math above).
    expect(result.report.llmCallBudget).toBe(12);
    expect(result.report.exitReason).toEqual({ kind: 'success' });
  });

  test('option 4 (cancel) exits with cancelled-by-user and exit code 0 (no LLM calls)', async () => {
    const io = ttyIo(['4']);
    const result = await runValidate({
      projectRoot: project.root,
      force: true,
      maxLlmCalls: 3,
      runner: noFindingsRunner(),
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adaptersOk(),
      menuIo: io.menuIo,
    });
    expect(result.exitCode).toBe(0);
    expect(result.report.exitReason).toEqual({ kind: 'cancelled-by-user' });
    expect(result.report.llmCallCount).toBe(0);
    expect(result.report.files).toEqual([]);
  });

  test('C1 (V1.5): --json suppresses the menu so stdout stays a clean report contract', async () => {
    // Same trigger as the menu-fires test (recommended 12 > maxLlmCalls 3) and
    // stdin is a TTY, but --json must treat the run as non-interactive: the
    // menu must NOT render to stdout (it would corrupt the JSON a
    // `validate --json | jq` consumer reads). Mirrors generate's guard.
    const io = ttyIo(['1']);
    const result = await runValidate({
      projectRoot: project.root,
      force: true,
      maxLlmCalls: 3,
      json: true,
      runner: noFindingsRunner(),
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adaptersOk(),
      menuIo: io.menuIo,
    });
    expect(io.stdout.join('')).not.toMatch(/Estimated .* LLM calls/);
    expect(io.stdout.join('')).not.toMatch(/Choose \[1-4\]/);
    // Menu was skipped, so the budget was never raised from its initial value.
    expect(result.report.llmCallBudget).toBe(3);
  });

  test('--no-prompt (noPrompt:true) skips the menu entirely even when current < recommended', async () => {
    // No stdin lines supplied — if the menu fired, the run would hang or
    // fall back to cancel. The test passes only if the menu is bypassed.
    const result = await runValidate({
      projectRoot: project.root,
      force: true,
      maxLlmCalls: 3,
      noPrompt: true,
      runner: noFindingsRunner(),
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adaptersOk(),
    });
    expect(result.report.llmCallBudget).toBe(3);
    // The 3-call budget is exhausted before all checks complete.
    expect(result.report.exitReason.kind).toBe('budget-exhausted');
  });

  test('menu is suppressed when recommended <= current (no user prompt needed)', async () => {
    // Default budget is 50; recommended for the minimal fixture is 11.
    // 11 ≤ 50 → menu must not appear. No stdin lines supplied; the run would
    // hang if the menu fired.
    const result = await runValidate({
      projectRoot: project.root,
      force: true,
      runner: noFindingsRunner(),
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adaptersOk(),
    });
    expect(result.report.llmCallBudget).toBe(50);
    expect(result.report.exitReason).toEqual({ kind: 'success' });
  });
});

describe('runValidate — V1.2-3 graceful rate-limit handling', () => {
  let project: Project;
  beforeEach(() => {
    project = setupProject();
  });
  afterEach(() => {
    project.cleanup();
  });

  test('rate-limit during the check phase: exitReason rate-limited, exit 1, partial files preserved, audit log intact', async () => {
    // V1.9.7 (THR-2): the mock keys off PROMPT CONTENT, never a global call
    // counter, so the witness is invariant to batch dispatch order (a pooled
    // runCheckBatches may complete the controller and view batches in either
    // order). The controller batch — the only prompt naming `no-direct-dom` —
    // surfaces one manual-only finding; a loop-phase check (`missing-teardown`,
    // which always runs AFTER every batch) throws the run-terminating
    // rate-limit. So the finding is provably recorded before the throw
    // regardless of scheduling. callsCompleted stays 3 (controller batch + view
    // batch + the throwing first missing-teardown call).
    const runner = new FakeClaudeRunner([
      {
        // Controller batch → one non-auto-fixable finding, recorded before the throw.
        match: /Static check: `no-direct-dom`/,
        response: {
          raw: JSON.stringify({
            findings: [
              {
                checkId: 'no-direct-dom',
                file: CONTROLLER_REL,
                message: 'Pre-throw finding (manual only).',
                proposedFix: null,
                explanation: 'Surfaced by the controller batch before the rate-limit hit.',
              },
            ],
          }),
        },
      },
      {
        // A loop-phase check (runs after every batch) → the terminating rate-limit.
        match: /Static check: `missing-teardown`/,
        response: () => {
          throw new RateLimitExhaustedError('cid-third', 4, 'API Error: 429 Too Many Requests');
        },
      },
      { match: /Static check:/, response: { raw: JSON.stringify({ findings: [] }) } },
    ]);
    const result = await runValidate({
      projectRoot: project.root,
      force: true,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adaptersOk(),
    });

    expect(result.exitCode).toBe(1);
    expect(result.report.exitReason.kind).toBe('rate-limited');
    if (result.report.exitReason.kind === 'rate-limited') {
      // 2 batch calls (controller + view) + the throwing first missing-teardown
      // call = 3; `consume()` runs BEFORE the throw so the attempted call counts.
      expect(result.report.exitReason.callsCompleted).toBe(3);
      // V1.2-4: RateLimitExhaustedError's message was reworded to lead
      // with a human-friendly framing ("Claude's rate limit was hit ...").
      // The call id, attempt count, and last-attempt detail are still
      // present in the technical parenthetical.
      expect(result.report.exitReason.lastError).toMatch(/rate limit/i);
      expect(result.report.exitReason.lastError).toMatch(/cid-third/);
      expect(result.report.exitReason.lastError).toMatch(/429/);
    }
    expect(result.report.llmCallCount).toBe(3);
    // No data loss: the finding the first check produced before the throw
    // is on report.files.
    expect(result.report.files).toHaveLength(1);
    expect(result.report.files[0]?.file).toBe(CONTROLLER_REL);
    expect(result.report.files[0]?.findings).toHaveLength(1);
    expect(result.report.files[0]?.findings[0]?.message).toMatch(/Pre-throw finding/);
    // No data loss: report.json was still written and the audit-log skeleton
    // (last-run/{prompts,responses,verify}) was still initialised.
    const reportPath = join(project.root, '.sapui5-validator', 'report.json');
    expect(existsSync(reportPath)).toBe(true);
    const reportFromDisk = JSON.parse(readFileSync(reportPath, 'utf8')) as RunReport;
    expect(reportFromDisk.exitReason.kind).toBe('rate-limited');
    const lastRun = join(project.root, '.sapui5-validator', 'last-run');
    expect(statSync(lastRun).isDirectory()).toBe(true);
    for (const sub of ['prompts', 'responses', 'verify']) {
      expect(statSync(join(lastRun, sub)).isDirectory()).toBe(true);
    }
  });

  test('combines with V1.2-2 per-category cap: report carries BOTH cappedChecks AND rate-limited exit', async () => {
    // Budget 10, cap 10% → per-category cap of 1. missing-teardown has 2 qunit
    // targets so its second call is skipped (a cap entry is recorded). V1.9.7
    // (THR-2): the terminating rate-limit is keyed off PROMPT CONTENT — thrown
    // from `manifest-component-drift`, a loop-phase check that always runs AFTER
    // every batch AND after missing-teardown (the loop phase stays sequential;
    // only the batch phase is pooled). So the cap skip is provably recorded
    // before the throw, independent of batch dispatch order. llmCallCount stays
    // 4 (controller batch + view batch + missing-teardown[0] + the throwing
    // manifest-component-drift call; missing-teardown[1] is the cap skip).
    const runner = new FakeClaudeRunner([
      {
        match: /Static check: `manifest-component-drift`/,
        response: () => {
          throw new RateLimitExhaustedError('cid-cap-rl', 4, 'rate limit hit mid-run');
        },
      },
      { match: /Static check:/, response: { raw: JSON.stringify({ findings: [] }) } },
    ]);
    const result = await runValidate({
      projectRoot: project.root,
      force: true,
      maxLlmCalls: 10,
      perCheckCap: 10,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adaptersOk(),
    });

    expect(result.exitCode).toBe(1);
    expect(result.report.exitReason.kind).toBe('rate-limited');
    // The per-category cap accounting populated BEFORE the throw must
    // survive into the final report (V1.2-2 invariant from CLAUDE.md).
    expect(result.report.cappedChecks).toEqual({ 'missing-teardown': 1 });
    expect(result.report.llmCallCount).toBe(4);
  });

  test('rate-limit during refinement reverts the in-progress file before exit', async () => {
    const controllerAbs = join(project.root, CONTROLLER_REL);
    const original = readFileSync(controllerAbs, 'utf8');

    // 1st LLM call: a check that returns a finding with a (broken) initial
    //   proposedFix. Verify will fail, so the orchestrator asks for a
    //   refinement.
    // 2nd LLM call: the refinement throws RateLimitExhaustedError. The
    //   orchestrator must revert the file to its original bytes before
    //   exiting with rate-limited.
    const runner = new FakeClaudeRunner([
      {
        match: (args) => args.prompt.includes('did not pass verification'),
        response: () => {
          throw new RateLimitExhaustedError(
            'cid-refine',
            4,
            'rate limit during refinement',
          );
        },
      },
      {
        match: /Static check: `no-direct-dom`/,
        response: {
          raw: JSON.stringify({
            findings: [
              {
                checkId: 'no-direct-dom',
                file: CONTROLLER_REL,
                message: 'broken initial fix',
                proposedFix: { newFileContent: '// BROKEN INITIAL\n' },
              },
            ],
          }),
        },
      },
      {
        match: /Static check:/,
        response: { raw: JSON.stringify({ findings: [] }) },
      },
    ]);

    // Baseline verify must pass (call 1). The first fix-loop verify (call 2)
    // must fail to trigger refinement.
    let ui5LintCalls = 0;
    const failingAdapters: VerifyAdapters = {
      ui5lint: async () => {
        ui5LintCalls += 1;
        if (ui5LintCalls === 1) {
          return { ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1 };
        }
        return {
          ok: false,
          stdout: '',
          stderr: 'ui5lint: broken',
          exitCode: 1,
          durationMs: 1,
        };
      },
      eslint: async () => ({ ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1 }),
      karma: async () => ({
        ok: true,
        stdout: '',
        stderr: '',
        exitCode: 0,
        durationMs: 1,
        testFiles: [],
      }),
    };

    const result = await runValidate({
      projectRoot: project.root,
      path: controllerAbs,
      force: true,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: failingAdapters,
    });

    expect(result.exitCode).toBe(1);
    expect(result.report.exitReason.kind).toBe('rate-limited');
    // The file was reverted to its original bytes before the run exited.
    expect(readFileSync(controllerAbs, 'utf8')).toBe(original);
  });
});

/**
 * V1.2-4 (Feature 2). Each scenario above asserts the orchestrator produced
 * the expected `ExitReason.kind`; this describe block closes the loop on
 * the stderr surface by feeding the *real* orchestrator-emitted exit
 * reasons through `formatExitMessage`. Per-kind text contracts live in
 * test/unit/error-messages.test.ts — here we only verify the binding:
 * every real exit reason yields a non-null, accessible explanation.
 */
describe('runValidate — V1.2-6 --html flag wiring', () => {
  let project: Project;
  beforeEach(() => {
    project = setupProject();
  });
  afterEach(() => {
    project.cleanup();
  });

  test('html:true writes report.html next to report.json', async () => {
    const runner = new FakeClaudeRunner([
      { match: /Static check:/, response: { raw: JSON.stringify({ findings: [] }) } },
    ]);
    const result = await runValidate({
      projectRoot: project.root,
      force: true,
      html: true,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adaptersOk(),
    });
    expect(result.exitCode).toBe(0);
    const reportJsonPath = join(project.root, '.sapui5-validator', 'report.json');
    const reportHtmlPath = join(project.root, '.sapui5-validator', 'report.html');
    expect(existsSync(reportJsonPath)).toBe(true);
    expect(existsSync(reportHtmlPath)).toBe(true);
    const html = readFileSync(reportHtmlPath, 'utf8');
    // Basic shape check — full document, expected sections, project name in title.
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<title>SAPUI5 Validator Report');
    expect(html).toContain('Baseline Findings');
    expect(html).toContain('Check Findings');
    expect(html).toContain('Applied Fixes');
    expect(html).toContain('Reverted Fixes');
    expect(html.endsWith('</html>\n')).toBe(true);
  });

  test('html flag omitted does NOT write report.html (default behaviour preserved)', async () => {
    const runner = new FakeClaudeRunner([
      { match: /Static check:/, response: { raw: JSON.stringify({ findings: [] }) } },
    ]);
    const result = await runValidate({
      projectRoot: project.root,
      force: true,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adaptersOk(),
    });
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(project.root, '.sapui5-validator', 'report.json'))).toBe(true);
    expect(existsSync(join(project.root, '.sapui5-validator', 'report.html'))).toBe(false);
  });

  test('html:true on a non-success run still writes report.html', async () => {
    // Force a budget-exhausted exit to confirm the HTML render fires even on
    // non-success — same lifecycle as report.json (also written on non-zero).
    const runner = new FakeClaudeRunner([
      { match: /Static check:/, response: { raw: JSON.stringify({ findings: [] }) } },
    ]);
    const result = await runValidate({
      projectRoot: project.root,
      force: true,
      maxLlmCalls: 1,
      perCheckCap: 100,
      html: true,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adaptersOk(),
    });
    expect(result.exitCode).toBe(1);
    expect(result.report.exitReason.kind).toBe('budget-exhausted');
    expect(existsSync(join(project.root, '.sapui5-validator', 'report.html'))).toBe(true);
  });
});

describe('runValidate — V1.2-4: orchestrator exit reasons render via formatExitMessage', () => {
  let project: Project;
  beforeEach(() => {
    project = setupProject();
  });
  afterEach(() => {
    project.cleanup();
  });

  test('success: formatExitMessage returns null (no stderr line)', async () => {
    const runner = new FakeClaudeRunner([
      { match: /Static check:/, response: { raw: JSON.stringify({ findings: [] }) } },
    ]);
    const result = await runValidate({
      projectRoot: project.root,
      force: true,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adaptersOk(),
    });
    expect(result.report.exitReason.kind).toBe('success');
    expect(formatExitMessage(result.report.exitReason)).toBeNull();
  });

  test('budget-exhausted: message names the cap flags', async () => {
    const runner = new FakeClaudeRunner([
      { match: /Static check:/, response: { raw: JSON.stringify({ findings: [] }) } },
    ]);
    const result = await runValidate({
      projectRoot: project.root,
      force: true,
      maxLlmCalls: 1,
      perCheckCap: 100,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adaptersOk(),
    });
    expect(result.report.exitReason.kind).toBe('budget-exhausted');
    const msg = formatExitMessage(result.report.exitReason);
    expect(msg).not.toBeNull();
    expect(msg).toContain('--max-llm-calls');
    expect(msg).toContain('--per-check-cap');
  });

  test('missing-claude: message points at the install + login step', async () => {
    const runner = new FakeClaudeRunner([]);
    const result = await runValidate({
      projectRoot: project.root,
      force: true,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adaptersOk(),
      availabilityProbe: async () => ({
        ok: false,
        reason: 'command not found',
        message: 'unused — formatExitMessage drives the stderr text',
      }),
    });
    expect(result.report.exitReason.kind).toBe('missing-claude');
    const msg = formatExitMessage(result.report.exitReason);
    expect(msg).toMatch(/claude cli was not found/i);
    expect(msg).toMatch(/npm i -g @anthropic-ai\/claude-code/);
    expect(msg).toMatch(/claude \/login/);
  });

  test('rate-limited: default message hides lastError; --verbose appends it', async () => {
    const runner = new FakeClaudeRunner([
      {
        match: /Static check:/,
        response: () => {
          throw new RateLimitExhaustedError('cid-int', 4, 'API Error: 429');
        },
      },
    ]);
    const result = await runValidate({
      projectRoot: project.root,
      force: true,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adaptersOk(),
    });
    expect(result.report.exitReason.kind).toBe('rate-limited');
    const plain = formatExitMessage(result.report.exitReason, { verbose: false });
    const verbose = formatExitMessage(result.report.exitReason, { verbose: true });
    expect(plain).toMatch(/rate limit/i);
    expect(plain).toMatch(/5 minutes/);
    expect(plain).not.toContain('cid-int');
    expect(verbose).toContain('Technical detail:');
    expect(verbose).toContain('cid-int');
    expect(verbose).toContain('429');
  });
});

describe('runValidate — V1.9.4 PERF-17 user-selectable model (--model)', () => {
  let project: Project;
  beforeEach(() => {
    project = setupProject();
  });
  afterEach(() => {
    project.cleanup();
  });

  test('an explicit model threads onto EVERY check call and is recorded on report.model', async () => {
    const runner = new FakeClaudeRunner([
      { match: /Static check:/, response: { raw: JSON.stringify({ findings: [] }) } },
    ]);
    const result = await runValidate({
      projectRoot: project.root,
      force: true,
      model: 'cheaper-model-x',
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adaptersOk(),
    });
    // Fail-on-revert guard: drop the `CheckContext.model` thread or the
    // `finish()` recording and one of these goes red.
    expect(result.report.model).toBe('cheaper-model-x');
    expect(runner.calls.length).toBeGreaterThan(0);
    for (const call of runner.calls) {
      expect(call.model).toBe('cheaper-model-x');
    }
  });

  test('default run forwards NO model and records none (byte-identical to today)', async () => {
    const runner = new FakeClaudeRunner([
      { match: /Static check:/, response: { raw: JSON.stringify({ findings: [] }) } },
    ]);
    const result = await runValidate({
      projectRoot: project.root,
      force: true,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adaptersOk(),
    });
    expect('model' in result.report).toBe(false);
    expect(runner.calls.length).toBeGreaterThan(0);
    for (const call of runner.calls) {
      expect('model' in call).toBe(false);
    }
  });
});

describe('runValidate — V1.9.7 THR-1 default-concurrency equivalence', () => {
  // Content-keyed fake: the controller batch surfaces one manual-only finding;
  // every other batch/check returns empty. Responses are invariant to dispatch
  // order and validate's per-index result slots keep report order stable, so a
  // K>1 run must be byte-identical to a K=1 run.
  function equivalenceRunner(): FakeClaudeRunner {
    return new FakeClaudeRunner([
      {
        match: /Static check: `no-direct-dom`/,
        response: {
          raw: JSON.stringify({
            findings: [
              {
                checkId: 'no-direct-dom',
                file: CONTROLLER_REL,
                message: 'DOM finding (manual only).',
                proposedFix: null,
                explanation: 'Surfaced by the controller batch.',
              },
            ],
          }),
        },
      },
      { match: /Static check:/, response: { raw: JSON.stringify({ findings: [] }) } },
    ]);
  }

  // V1.9.7 (THR-1) — the Phase-3 exit-criteria witness for validate: running at
  // the CLI's DEFAULT `--concurrency` (K>1 after the flip) produces results
  // identical to an explicit `--concurrency 1` run on the same fixture. validate
  // has NO lane restriction, so its effective K equals the request — the default
  // run genuinely dispatches the controller + view batches in parallel.
  test('the CLI default --concurrency (K>1) yields results identical to --concurrency 1', async () => {
    const defaultK = cliConcurrencyDefault('validate');
    expect(defaultK).toBeGreaterThan(1);

    const seq = setupProject();
    const par = setupProject();
    try {
      const k1 = await runValidate({
        projectRoot: seq.root,
        force: true,
        concurrency: 1,
        runner: equivalenceRunner(),
        probeAdapter: ALL_TOOLS_OK,
        verifyAdapters: adaptersOk(),
      });
      const atDefault = await runValidate({
        projectRoot: par.root,
        force: true,
        concurrency: defaultK,
        runner: equivalenceRunner(),
        probeAdapter: ALL_TOOLS_OK,
        verifyAdapters: adaptersOk(),
      });

      // The effective width is recorded and actually differs.
      expect(k1.report.concurrency).toBe(1);
      expect(atDefault.report.concurrency).toBe(defaultK);

      // Identical RESULTS: same exit code, same call count, and a byte-identical
      // report.files array (file order + within-file finding order).
      expect(atDefault.exitCode).toBe(k1.exitCode);
      expect(atDefault.report.llmCallCount).toBe(k1.report.llmCallCount);
      expect(atDefault.report.files).toEqual(k1.report.files);
      // Non-vacuous: the run actually surfaced a finding (not an all-empty compare).
      expect(k1.report.files.some((f) => f.findings.length > 0)).toBe(true);
    } finally {
      seq.cleanup();
      par.cleanup();
    }
  });
});
