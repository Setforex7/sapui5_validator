/**
 * V1.9.8 Phase 1 — fail-on-revert guards for the cross-run detection result
 * cache (`validate --cache`), plus the fully-cache-hot determinism witness.
 *
 * Written RED-FIRST: every guard here fails on the pre-cache tree (the
 * `cache: true` option is ignored, so a "warm" run still dispatches every
 * batch call). The guards, one test each:
 *   G1 same-content re-run with --cache dispatches 0 batch-detection calls
 *      (the non-batched loop checks — missing-teardown, manifest-component-drift
 *      — are NOT cached in Phase 1 and may still call; the guard counts BATCH
 *      prompts only).
 *   G2 content change ⇒ MISS (the changed file's batch redispatches live).
 *   G3 PROMPT_VERSION participates in the key (unit-level sensitivity lives in
 *      checks-cache.test.ts; here the ratchet test pins the builder source).
 *   G4 tampered / corrupt cache entries ⇒ MISS, never a crash.
 *   G5 --force bypasses cache READS but still WRITES fresh entries.
 *   W  determinism witness: the cache-hot report is byte-identical to the
 *      populating run's report minus timestamps/usage/cached-markers.
 *
 * Model: test/integration/validate.test.ts (mkdtemp + cpSync of the shared
 * fixture — NEVER the fixture root itself as projectRoot).
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Command } from 'commander';
import { runValidate } from '../../src/commands/validate.js';
import { program } from '../../src/cli.js';
import { FakeClaudeRunner } from '../../src/claude/fake-runner.js';
import type { ProbeAdapter } from '../../src/project/tooling.js';
import type { VerifyAdapters } from '../../src/verify/pipeline.js';
import type { RunReport } from '../../src/types.js';

const FIXTURE_ROOT = join(process.cwd(), 'test', 'fixtures', 'minimal-project');
const CONTROLLER_REL = 'webapp/controller/Main.controller.js';
const CACHE_FILE_REL = join('.sapui5-validator', 'cache', 'detection-cache.json');
const BATCH_PROMPT = /Batched static analysis/;

const ALL_TOOLS_OK: ProbeAdapter = {
  probe: () => ({ present: true, version: '1.0.0', source: 'node_modules' }),
};

function adaptersOk(): VerifyAdapters {
  return {
    ui5lint: async () => ({ ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1 }),
    eslint: async () => ({ ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1 }),
    karma: async () => ({ ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1, testFiles: [] }),
  };
}

interface Project {
  readonly root: string;
  cleanup(): void;
}

function setupProject(): Project {
  const root = mkdtempSync(join(tmpdir(), 'sapui5-cache-'));
  cpSync(FIXTURE_ROOT, root, { recursive: true });
  return {
    root,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Fresh runner per run — `calls` isolates each run's dispatch record. */
function checksCleanRunner(): FakeClaudeRunner {
  return new FakeClaudeRunner([
    { match: /Static check:|Batched static analysis/, response: { raw: JSON.stringify({ findings: [] }) } },
  ]);
}

function batchCalls(runner: FakeClaudeRunner): number {
  return runner.calls.filter((c) => BATCH_PROMPT.test(c.prompt)).length;
}

async function runCached(
  root: string,
  runner: FakeClaudeRunner,
  extra: { force?: boolean; cache?: boolean } = {},
): Promise<RunReport> {
  const result = await runValidate({
    projectRoot: root,
    runner,
    probeAdapter: ALL_TOOLS_OK,
    verifyAdapters: adaptersOk(),
    cache: extra.cache ?? true,
    // force is OMITTED by default: the tmpdir is not a git repository and the
    // clean-tree gate treats "no repository" as proceed (COR-1) — so cache
    // READS stay enabled (G5 asserts --force disables them).
    ...(extra.force !== undefined ? { force: extra.force } : {}),
  });
  return result.report;
}

describe('validate --cache CLI default (V1.9.8 Phase 3 — evidence-gated flip)', () => {
  test('the CLI defaults --cache ON; --no-cache is the opt-out', () => {
    // The Phase-3 real gate (docs/runs/v1.9.8-phase3/) earned the default:
    // 17/17 hits on unchanged trees, byte-identical served findings, zero
    // stale incidents, 32→15 calls / ~$11.5→~$1.0 per project. Reverting the
    // default silently un-ships that without re-running the gate — hence
    // this guard (mirrors cliConcurrencyDefault in validate.test.ts).
    const cmd = program.commands.find((c: Command) => c.name() === 'validate');
    const cacheOpt = cmd?.options.find((o) => o.long === '--cache');
    const noCacheOpt = cmd?.options.find((o) => o.long === '--no-cache');
    expect(cacheOpt, '--cache not registered on validate').toBeDefined();
    expect(noCacheOpt, '--no-cache not registered on validate').toBeDefined();
    expect(cacheOpt?.defaultValue, '--cache must default ON (Phase 3 flip)').toBe(true);
  });
});

describe('validate --cache — fail-on-revert guards (V1.9.8 Phase 1)', () => {
  let project: Project;
  beforeEach(() => {
    project = setupProject();
  });
  afterEach(() => {
    project.cleanup();
  });

  test('G1: same-content re-run dispatches 0 batch-detection calls and reports the hits', async () => {
    const cold = checksCleanRunner();
    const coldReport = await runCached(project.root, cold);
    const coldBatchCalls = batchCalls(cold);
    expect(coldBatchCalls).toBeGreaterThan(0); // fixture must actually exercise the batch phase

    const warm = checksCleanRunner();
    const warmReport = await runCached(project.root, warm);
    expect(batchCalls(warm)).toBe(0);
    expect(warmReport.cache).toBeDefined();
    expect(warmReport.cache?.hits).toBe(coldBatchCalls);
    expect(coldReport.cache).toBeDefined();
    expect(coldReport.cache?.hits).toBe(0);
    expect(coldReport.cache?.misses).toBe(coldBatchCalls);
  });

  test('G2: content change ⇒ MISS — the changed file redispatches live', async () => {
    const cold = checksCleanRunner();
    await runCached(project.root, cold);
    const coldBatchCalls = batchCalls(cold);

    appendFileSync(join(project.root, CONTROLLER_REL), '\n// developer edit\n');

    const warm = checksCleanRunner();
    const warmReport = await runCached(project.root, warm);
    // BOTH batch targets re-fire: the edited controller's own batch AND the
    // view batch, whose prompt embeds the PAIRED CONTROLLER content
    // (invariant 1 — the dependency effect Phase 0 measured on the real
    // projects: a controller edit must MISS the views that embed it, or a
    // stale globals-in-views finding would be served).
    expect(batchCalls(warm)).toBe(2);
    expect(warmReport.cache?.hits).toBe(coldBatchCalls - 2);
    expect(warmReport.cache?.misses).toBe(2);
  });

  test('G4a: corrupt cache file ⇒ all MISS, never a crash', async () => {
    const cold = checksCleanRunner();
    await runCached(project.root, cold);
    const coldBatchCalls = batchCalls(cold);

    writeFileSync(join(project.root, CACHE_FILE_REL), '{not json at all', 'utf8');

    const warm = checksCleanRunner();
    const warmReport = await runCached(project.root, warm);
    expect(batchCalls(warm)).toBe(coldBatchCalls);
    expect(warmReport.cache?.hits).toBe(0);
  });

  test('G4b: tampered entry (invalid finding shape) ⇒ MISS for that entry, never a crash', async () => {
    const cold = checksCleanRunner();
    await runCached(project.root, cold);
    const coldBatchCalls = batchCalls(cold);

    const cacheAbs = join(project.root, CACHE_FILE_REL);
    const parsed = JSON.parse(readFileSync(cacheAbs, 'utf8')) as {
      entries: { findings: unknown[] }[];
    };
    expect(parsed.entries.length).toBe(coldBatchCalls);
    // Tamper EVERY entry with a finding that fails the zod schema (unknown
    // checkId) — served-from-tampered-content must never happen.
    for (const entry of parsed.entries) {
      entry.findings = [{ checkId: 'evil-injected', file: 'x', message: 'x', source: 'check', proposedFix: null }];
    }
    writeFileSync(cacheAbs, JSON.stringify(parsed), 'utf8');

    const warm = checksCleanRunner();
    const warmReport = await runCached(project.root, warm);
    expect(batchCalls(warm)).toBe(coldBatchCalls);
    expect(warmReport.cache?.hits).toBe(0);
    // The tampered findings must not have leaked into the report.
    const allMessages = warmReport.files.flatMap((f) => f.findings.map((x) => x.message));
    expect(allMessages.join('\n')).not.toContain('evil-injected');
  });

  test('G5: --force bypasses cache reads but still writes fresh entries', async () => {
    // Forced populate run: writes entries even though reads are bypassed.
    const forced = checksCleanRunner();
    const forcedReport = await runCached(project.root, forced, { force: true });
    const forcedBatchCalls = batchCalls(forced);
    expect(forcedBatchCalls).toBeGreaterThan(0);
    expect(forcedReport.cache?.hits).toBe(0);
    expect(existsSync(join(project.root, CACHE_FILE_REL))).toBe(true);

    // A second forced run must STILL dispatch live (reads bypassed)…
    const forcedAgain = checksCleanRunner();
    const forcedAgainReport = await runCached(project.root, forcedAgain, { force: true });
    expect(batchCalls(forcedAgain)).toBe(forcedBatchCalls);
    expect(forcedAgainReport.cache?.hits).toBe(0);

    // …while an unforced run proves the forced runs wrote usable entries.
    const warm = checksCleanRunner();
    const warmReport = await runCached(project.root, warm);
    expect(batchCalls(warm)).toBe(0);
    expect(warmReport.cache?.hits).toBe(forcedBatchCalls);
  });

  test('no --cache ⇒ no cache dir, no cache counters (byte-identical legacy dispatch)', async () => {
    const first = checksCleanRunner();
    const firstReport = await runCached(project.root, first, { cache: false });
    expect(firstReport.cache).toBeUndefined();
    expect(existsSync(join(project.root, CACHE_FILE_REL))).toBe(false);

    const second = checksCleanRunner();
    const secondReport = await runCached(project.root, second, { cache: false });
    expect(batchCalls(second)).toBe(batchCalls(first));
    expect(secondReport.cache).toBeUndefined();
  });

  test('H1 (Phase 2): served findings carry cached:true + servedRunIds; the populating run carries neither', async () => {
    // Non-empty findings runner: the controller batch reports one advisory
    // finding, the view batch is clean — so the cached payload has CONTENT
    // (the Phase-1 auditor observation) and the marker path is exercised.
    const advisoryRunner = (): FakeClaudeRunner =>
      new FakeClaudeRunner([
        {
          match: /Batched static analysis: run the checks below over ONE SAPUI5 controller/,
          response: {
            raw: JSON.stringify({
              findings: [
                {
                  checkId: 'no-direct-dom',
                  file: CONTROLLER_REL,
                  line: 3,
                  message: 'direct DOM access',
                  proposedFix: null,
                  explanation: 'advisory — rewrite via byId()',
                },
              ],
            }),
          },
        },
        { match: /Static check:|Batched static analysis/, response: { raw: JSON.stringify({ findings: [] }) } },
      ]);

    const cold = advisoryRunner();
    const coldReport = await runCached(project.root, cold);
    const coldFindings = coldReport.files.flatMap((f) => f.findings);
    expect(coldFindings).toHaveLength(1);
    expect(coldFindings[0]?.cached).toBeUndefined(); // the populating run is live — no marker
    expect(coldReport.cache?.servedRunIds).toBeUndefined();

    const warm = advisoryRunner();
    const warmReport = await runCached(project.root, warm);
    expect(batchCalls(warm)).toBe(0);
    const warmFindings = warmReport.files.flatMap((f) => f.findings);
    expect(warmFindings).toHaveLength(1);
    expect(warmFindings[0]?.cached).toBe(true); // served ⇒ marked
    expect(warmFindings[0]?.message).toBe('direct DOM access');
    // The run-level counter moves together with the marker (D1 rule) and
    // names the populating run.
    expect(warmReport.cache?.hits).toBe(2);
    expect(warmReport.cache?.servedRunIds).toEqual([coldReport.startedAt]);
  });

  test('H2 (Phase 2): the warm run announces the hits on the summary stream', async () => {
    const cold = checksCleanRunner();
    await runCached(project.root, cold);

    const captured = new PassThrough();
    let summary = '';
    captured.on('data', (chunk: Buffer) => {
      summary += chunk.toString('utf8');
    });
    const warm = checksCleanRunner();
    await runValidate({
      projectRoot: project.root,
      runner: warm,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adaptersOk(),
      cache: true,
      warningStream: captured,
    });
    expect(summary).toMatch(/2 of 2 check calls served from cache \(run /);
  });

  test('W: fully-cache-hot report is byte-identical minus timestamps/usage/cached-markers', async () => {
    const cold = checksCleanRunner();
    const coldReport = await runCached(project.root, cold);
    const warm = checksCleanRunner();
    const warmReport = await runCached(project.root, warm);
    expect(batchCalls(warm)).toBe(0); // fully cache-hot, or the witness is vacuous

    const normalise = (r: RunReport): string => {
      const clone = JSON.parse(JSON.stringify(r)) as Record<string, unknown> & {
        files?: { findings?: Record<string, unknown>[] }[];
      };
      // Timestamps + usage + cached-markers — the ONLY tolerated variance
      // (llmCallCount/usage/totalCostUsd ARE the usage surface: a cache-hot
      // run honestly makes fewer live calls; the per-finding `cached` marker
      // is Phase 2's honesty surface — everything else about a served finding
      // must be byte-identical to the populating run's).
      delete clone['startedAt'];
      delete clone['finishedAt'];
      delete clone['durationMs'];
      delete clone['llmCallCount'];
      delete clone['usage'];
      delete clone['totalCostUsd'];
      delete clone['cache'];
      for (const f of clone.files ?? []) {
        for (const finding of f.findings ?? []) delete finding['cached'];
      }
      return JSON.stringify(clone);
    };
    expect(normalise(warmReport)).toBe(normalise(coldReport));
  });
});
