/**
 * V1.9.4 PERF-2 / PERF-8 — batched check dispatch (fail-on-revert guards).
 *
 * Four dimensions, each RED if its part of the batch is reverted:
 *   1. The batch prompts carry every included check's `Static check: `<id>`` header
 *      + its substantive instructions, embed the source ONCE, and gate coverage on
 *      the `coverage` arg (so an unmapped controller's batch omits
 *      missing-test-coverage — mirroring the per-check world).
 *   2. callLlmForFindingsBatch cap accounting: fires IFF every included checkId is
 *      under cap; ONE budget call + ONE recordCall per checkId on a fire.
 *   3. Partial-cap → the WHOLE batch is skipped: no call, no budget, ONE skip per
 *      included checkId, no peer over-call.
 *   4. runCheckBatches collapses the fan-out 3N→N / 2M→M: N controllers + M views
 *      = N + M LLM calls (the per-check world would be 3N + 2M).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { CallBudget } from '../../src/claude/budget.js';
import {
  createCapState,
  getSkippedCounts,
  recordCallForCategory,
} from '../../src/budget/cap.js';
import { FakeClaudeRunner } from '../../src/claude/fake-runner.js';
import { RateLimitSignal } from '../../src/claude/rate-limit-signal.js';
import type { ClaudeRunArgs, ClaudeRunResult, ClaudeRunner } from '../../src/claude/runner.js';
import { callLlmForFindingsBatch } from '../../src/checks/_shared.js';
import {
  BATCHED_CHECK_IDS,
  CONTROLLER_BATCH_CHECK_IDS,
  VIEW_BATCH_CHECK_IDS,
  buildControllerBatchPrompt,
  buildViewBatchPrompt,
  runCheckBatches,
} from '../../src/checks/batch.js';
import type { CheckContext } from '../../src/checks/types.js';

const CONTROLLER_REL = 'webapp/controller/Main.controller.js';
const CONTROLLER_SRC =
  'sap.ui.define([], function () {\n' +
  '  var BATCH_DOM_MARKER = document.getElementById("x");\n' +
  '  return { onInit: function () {} };\n' +
  '});';

function noFindingsRunner(): FakeClaudeRunner {
  return new FakeClaudeRunner([
    { match: /./, response: { raw: JSON.stringify({ findings: [] }) } },
  ]);
}

function ctxOf(runner: FakeClaudeRunner, budget: CallBudget, capPercent = 100): CheckContext {
  return {
    projectRoot: '/proj',
    runner,
    budget,
    capState: createCapState(capPercent, budget.maxCalls),
  };
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('buildControllerBatchPrompt (PERF-2)', () => {
  test('covers all 3 controller checks (with coverage), embeds the source ONCE', () => {
    const prompt = buildControllerBatchPrompt({
      relPath: CONTROLLER_REL,
      content: CONTROLLER_SRC,
      coverage: {
        testRel: 'webapp/test/unit/controller/Main.controller.qunit.js',
        testContent: 'QUnit.test("onInit", function (a) { a.ok(true); });',
      },
    });
    // Each check's header + a distinctive instruction phrase (reverting any check
    // out of the batch drops its phrase → RED; this also pins detection quality).
    expect(prompt).toContain('Static check: `no-direct-dom`');
    expect(prompt).toContain('document.getElementById');
    expect(prompt).toContain('Static check: `no-sync-odata`');
    expect(prompt).toContain('synchronous OData');
    expect(prompt).toContain('Static check: `missing-test-coverage`');
    expect(prompt).toContain('public methods');
    // The schema instruction names all three ids.
    expect(prompt).toContain('"missing-test-coverage"');
    // The controller source is embedded EXACTLY ONCE (the whole point of the
    // batch — 3 checks share one embed; reverting to per-check sends it 3×).
    expect(occurrences(prompt, 'BATCH_DOM_MARKER')).toBe(1);
    // The existing test file is embedded for coverage.
    expect(prompt).toContain('Existing test file: webapp/test/unit/controller/Main.controller.qunit.js');
    expect(prompt).toContain('```javascript');
  });

  test('omits missing-test-coverage when coverage is absent (unmapped controller)', () => {
    const prompt = buildControllerBatchPrompt({ relPath: CONTROLLER_REL, content: CONTROLLER_SRC });
    expect(prompt).toContain('Static check: `no-direct-dom`');
    expect(prompt).toContain('Static check: `no-sync-odata`');
    expect(prompt).not.toContain('Static check: `missing-test-coverage`');
    expect(prompt).not.toContain('"missing-test-coverage"');
  });

  test('TS framing uses the typescript fence + ES-module guidance, never the JS fence', () => {
    const prompt = buildControllerBatchPrompt({
      relPath: 'webapp/controller/App.controller.ts',
      content: CONTROLLER_SRC,
      language: 'ts',
    });
    expect(prompt).toContain('```typescript');
    expect(prompt).not.toContain('```javascript');
    expect(prompt).toContain('TypeScript SAPUI5 project'); // tsSourceGuidance
  });
});

describe('buildViewBatchPrompt (PERF-8)', () => {
  const VIEW_REL = 'webapp/view/Main.view.xml';
  const VIEW_SRC = '<mvc:View xmlns:mvc="sap.ui.core.mvc"><Button id="VIEW_MARKER_btn" /></mvc:View>';
  const CTRL_SRC = 'sap.ui.define([], function () { return { onPress: function () {} }; });';

  test('covers both view checks; embeds view + paired controller once; preserves the globals null-fix instruction', () => {
    const prompt = buildViewBatchPrompt({
      viewRel: VIEW_REL,
      viewContent: VIEW_SRC,
      controllerRel: CONTROLLER_REL,
      controllerContent: CTRL_SRC,
    });
    expect(prompt).toContain('Static check: `missing-i18n`');
    expect(prompt).toContain('{i18n>key}');
    expect(prompt).toContain('Static check: `globals-in-views`');
    expect(prompt).toContain(`Paired controller: ${CONTROLLER_REL}`);
    expect(occurrences(prompt, 'VIEW_MARKER_btn')).toBe(1);
    // The PERF-8 invariant: globals-in-views keeps its "null when the fix needs
    // the controller" instruction verbatim.
    expect(prompt).toContain('touch the controller');
  });

  test('renders the no-paired-controller fallback when none resolves', () => {
    const prompt = buildViewBatchPrompt({
      viewRel: VIEW_REL,
      viewContent: VIEW_SRC,
      controllerRel: null,
      controllerContent: null,
    });
    expect(prompt).toContain('No paired controller could be located deterministically.');
  });
});

describe('callLlmForFindingsBatch — cap accounting (PERF-2/8)', () => {
  test('fires once when every included checkId is under cap; records ONE call per checkId', async () => {
    const runner = noFindingsRunner();
    const budget = new CallBudget({ maxCalls: 10 });
    const ctx = ctxOf(runner, budget, 100); // cap = 10, never binds
    const findings = await callLlmForFindingsBatch({
      checkIds: [...CONTROLLER_BATCH_CHECK_IDS],
      file: CONTROLLER_REL,
      prompt: 'Static check: `no-direct-dom`. (batch)',
      ctx,
    });
    // ONE LLM call covering 3 categories (not 3 calls).
    expect(runner.calls).toHaveLength(1);
    // V1.9.4 PERF-7: the batch is a read-only findings call → trimmed grant.
    // Reverting `tools: READ_ONLY_CHECK_TOOLS` in callLlmForFindingsBatch
    // restores the full ALLOWED_TOOLS and turns this red.
    expect([...runner.calls[0]!.allowedTools]).toEqual(['Read', 'Grep', 'Glob']);
    expect(budget.callsUsed).toBe(1);
    // ...but ONE cap increment per included checkId.
    expect(ctx.capState.consumedByCategory['no-direct-dom']).toBe(1);
    expect(ctx.capState.consumedByCategory['no-sync-odata']).toBe(1);
    expect(ctx.capState.consumedByCategory['missing-test-coverage']).toBe(1);
    expect(findings).toEqual([]);
  });

  test('a PARTIALLY-capped batch is skipped WHOLE: no call, no budget, one skip per checkId, no peer over-call', async () => {
    const runner = noFindingsRunner();
    const budget = new CallBudget({ maxCalls: 10 });
    const ctx = ctxOf(runner, budget, 10); // perCategoryCap = floor(10*10/100) = 1
    // Drive ONLY no-direct-dom to its cap; the other two still have budget.
    recordCallForCategory(ctx.capState, 'no-direct-dom');

    const findings = await callLlmForFindingsBatch({
      checkIds: [...CONTROLLER_BATCH_CHECK_IDS],
      file: CONTROLLER_REL,
      prompt: 'Static check: `no-direct-dom`. (batch)',
      ctx,
    });

    // The whole batch is skipped — never over-calls the capped category.
    expect(runner.calls).toHaveLength(0);
    expect(budget.callsUsed).toBe(0);
    expect(findings).toEqual([]);
    // One skip recorded per INCLUDED checkId (matches the per-check cappedChecks
    // accounting the validate integration suite pins on the cap-0 path).
    expect(getSkippedCounts(ctx.capState)).toEqual({
      'no-direct-dom': 1,
      'no-sync-odata': 1,
      'missing-test-coverage': 1,
    });
    // The non-capped peers were NOT consumed (skip-whole, not skip-the-capped-one).
    expect(ctx.capState.consumedByCategory['no-sync-odata']).toBeUndefined();
    expect(ctx.capState.consumedByCategory['missing-test-coverage']).toBeUndefined();
  });
});

describe('runCheckBatches — fan-out collapse 3N→N / 2M→M (PERF-2/8)', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sapui5-batch-count-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('N controllers + M views dispatch exactly N + M LLM calls (was 3N + 2M)', async () => {
    const N = 3;
    const M = 2;
    const controllers: string[] = [];
    for (let i = 0; i < N; i += 1) {
      const rel = `webapp/controller/C${i}.controller.js`;
      const abs = join(root, rel);
      mkdirSync(join(root, 'webapp', 'controller'), { recursive: true });
      writeFileSync(abs, `sap.ui.define([], function () { return { m${i}: function () {} }; });\n`, 'utf8');
      controllers.push(abs);
    }
    const views: string[] = [];
    for (let i = 0; i < M; i += 1) {
      const rel = `webapp/view/V${i}.view.xml`;
      const abs = join(root, rel);
      mkdirSync(join(root, 'webapp', 'view'), { recursive: true });
      // No controllerName → no paired controller (keeps the witness self-contained).
      writeFileSync(abs, `<mvc:View xmlns:mvc="sap.ui.core.mvc"><Button id="b${i}" /></mvc:View>\n`, 'utf8');
      views.push(abs);
    }

    const runner = noFindingsRunner();
    const budget = new CallBudget({ maxCalls: 50 });
    const ctx: CheckContext = {
      projectRoot: root,
      runner,
      budget,
      capState: createCapState(100, 50),
      projectLanguage: 'js',
    };

    const result = await runCheckBatches({
      ctx,
      controllers,
      coverageMapped: new Set(), // unmapped → 2-check controller batches; still 1 call each
      views,
    });

    // The load-bearing assertion: ONE call per controller + ONE per view. The
    // per-check world would be 3*N + 2*M = 13 here; batching makes it N + M = 5.
    expect(runner.calls).toHaveLength(N + M);
    expect(budget.callsUsed).toBe(N + M);
    expect(result.budgetExhausted).toBe(false);
    expect(result.rateLimitExhausted).toBeNull();
    expect(result.findings).toEqual([]);
  });
});

describe('BATCHED_CHECK_IDS registry contract', () => {
  test('names exactly the 3 controller + 2 view batched ids', () => {
    expect([...BATCHED_CHECK_IDS].sort()).toEqual(
      [...CONTROLLER_BATCH_CHECK_IDS, ...VIEW_BATCH_CHECK_IDS].sort(),
    );
    // missing-teardown + manifest-component-drift stay in the per-check loop.
    expect(BATCHED_CHECK_IDS.has('missing-teardown')).toBe(false);
    expect(BATCHED_CHECK_IDS.has('manifest-component-drift')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// V1.9.7 (THR-2) — parallel batch dispatch interleaving witnesses.

/** Seed N controllers + M views on disk (runControllerBatch/runViewBatch read them). */
function seedControllersAndViews(
  root: string,
  nControllers: number,
  nViews: number,
): { controllers: string[]; views: string[] } {
  const controllers: string[] = [];
  if (nControllers > 0) mkdirSync(join(root, 'webapp', 'controller'), { recursive: true });
  for (let i = 0; i < nControllers; i += 1) {
    const abs = join(root, 'webapp', 'controller', `C${i}.controller.js`);
    writeFileSync(
      abs,
      `sap.ui.define([], function () { return { m${i}: function () {} }; });\n`,
      'utf8',
    );
    controllers.push(abs);
  }
  const views: string[] = [];
  if (nViews > 0) mkdirSync(join(root, 'webapp', 'view'), { recursive: true });
  for (let i = 0; i < nViews; i += 1) {
    const abs = join(root, 'webapp', 'view', `V${i}.view.xml`);
    writeFileSync(
      abs,
      `<mvc:View xmlns:mvc="sap.ui.core.mvc"><Button id="b${i}" /></mvc:View>\n`,
      'utf8',
    );
    views.push(abs);
  }
  return { controllers, views };
}

/**
 * A runner that finishes LATER-arrived calls in FEWER microtask ticks, so the
 * completion order deliberately differs from claim/target order. This exercises
 * the per-index result slots in runCheckBatches: a completion-order append (the
 * regression this guards) would scramble `findings`; per-index slots keep them
 * in target order regardless of when each call resolves. One finding per call
 * (its `file` is pinned by the normalizer to the scanned target).
 */
class ReorderingRunner implements ClaudeRunner {
  readonly calls: ClaudeRunArgs[] = [];
  private arrival = 0;
  async run(args: ClaudeRunArgs): Promise<ClaudeRunResult> {
    this.calls.push(args);
    const j = this.arrival;
    this.arrival += 1;
    for (let t = 32 - j; t > 0; t -= 1) await Promise.resolve();
    const isView = /Static check: `missing-i18n`/.test(args.prompt);
    return {
      ok: true,
      json: {},
      raw: JSON.stringify({
        findings: [
          {
            checkId: isView ? 'missing-i18n' : 'no-direct-dom',
            file: 'pinned-by-normalizer',
            message: 'interleave-witness',
            proposedFix: null,
            explanation: 'e',
          },
        ],
      }),
      stderr: '',
      exitCode: 0,
      durationMs: 0,
      callId: `reorder-${j.toString(10)}`,
    };
  }
}

describe('runCheckBatches — V1.9.7 THR-2 interleaving witnesses (K>1)', () => {
  const K = 3;
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sapui5-thr2-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('partial-cap skip-whole stays EXACT under K=3 interleaving: a capped category is never over-called', async () => {
    const { controllers } = seedControllersAndViews(root, 5, 0);
    const runner = noFindingsRunner();
    const budget = new CallBudget({ maxCalls: 20 });
    // per-category cap = floor(10 * 20 / 100) = 2. Unmapped controllers → each
    // batch covers [no-direct-dom, no-sync-odata], both capped at 2. Budget (20)
    // is deliberately NOT the binding constraint here — the cap is.
    const ctx: CheckContext = {
      projectRoot: root,
      runner,
      budget,
      capState: createCapState(10, 20),
      projectLanguage: 'js',
    };

    const result = await runCheckBatches({
      ctx,
      controllers,
      coverageMapped: new Set(),
      views: [],
      concurrency: K,
    });

    // The load-bearing interleaving assertion: EXACTLY 2 batches fire (the cap),
    // never 3. The cap-check → budget.consume() → recordCall prelude in
    // callLlmForFindingsBatch is fully synchronous (first await is the LLM call),
    // so no two in-flight workers can both pass the check on the last free slot.
    // Inserting an await between the check and the record would let a 3rd call
    // slip through at K=3 and turn this red.
    expect(runner.calls).toHaveLength(2);
    expect(budget.callsUsed).toBe(2);
    expect(ctx.capState.consumedByCategory['no-direct-dom']).toBe(2);
    expect(ctx.capState.consumedByCategory['no-sync-odata']).toBe(2);
    // The 3 batches that could not fire were each skipped WHOLE — one skip per
    // included checkId, no peer over-call (skip-whole, not skip-the-capped-one).
    expect(getSkippedCounts(ctx.capState)).toEqual({
      'no-direct-dom': 3,
      'no-sync-odata': 3,
    });
    expect(result.findings).toEqual([]);
    expect(result.budgetExhausted).toBe(false);
    expect(result.rateLimitExhausted).toBeNull();
  });

  test('CallBudget is never over-consumed at the boundary under K=3', async () => {
    const { controllers } = seedControllersAndViews(root, 5, 0);
    const runner = noFindingsRunner();
    const budget = new CallBudget({ maxCalls: 2 });
    // Cap non-binding (100% of a 100-call basis = 100) so the BUDGET is the
    // boundary; 5 controllers contend for 2 call slots at K=3.
    const ctx: CheckContext = {
      projectRoot: root,
      runner,
      budget,
      capState: createCapState(100, 100),
      projectLanguage: 'js',
    };

    const result = await runCheckBatches({
      ctx,
      controllers,
      coverageMapped: new Set(),
      views: [],
      concurrency: K,
    });

    // budget.consume() checks-then-increments, so callsUsed can never exceed
    // maxCalls; K=3 in-flight workers still consume EXACTLY 2 slots (the 3rd
    // consume throws BudgetExhaustedError before any runner.run).
    expect(budget.callsUsed).toBe(2);
    expect(runner.calls).toHaveLength(2);
    expect(result.budgetExhausted).toBe(true);
    expect(result.rateLimitExhausted).toBeNull();
  });

  test('findings stay byte-stable in TARGET order despite out-of-order completion (K=3)', async () => {
    const { controllers, views } = seedControllersAndViews(root, 3, 2);
    const runner = new ReorderingRunner();
    const budget = new CallBudget({ maxCalls: 50 });
    const ctx: CheckContext = {
      projectRoot: root,
      runner,
      budget,
      capState: createCapState(100, 50),
      projectLanguage: 'js',
    };

    const result = await runCheckBatches({
      ctx,
      controllers,
      coverageMapped: new Set(),
      views,
      concurrency: K,
    });

    // Per-index result slots → findings in TARGET order (controllers, then
    // views), NOT the reversed completion order the runner produced. A revert to
    // completion-order appending would scramble this list.
    expect(result.findings.map((f) => f.file)).toEqual([
      'webapp/controller/C0.controller.js',
      'webapp/controller/C1.controller.js',
      'webapp/controller/C2.controller.js',
      'webapp/view/V0.view.xml',
      'webapp/view/V1.view.xml',
    ]);
  });

  test('an unexpected error in one batch does not poison siblings — it rethrows after drain (K=3)', async () => {
    const { controllers } = seedControllersAndViews(root, 5, 0);
    // C1's batch throws a NON-typed error (not a rate-limit / budget halt).
    const runner = new FakeClaudeRunner([
      {
        match: /C1\.controller\.js/,
        response: () => {
          throw new Error('boom-c1');
        },
      },
      { match: /Static check:/, response: { raw: JSON.stringify({ findings: [] }) } },
    ]);
    const budget = new CallBudget({ maxCalls: 50 });
    const ctx: CheckContext = {
      projectRoot: root,
      runner,
      budget,
      capState: createCapState(100, 50),
      projectLanguage: 'js',
    };

    // The unexpected error propagates exactly like the sequential loop's
    // `throw err`: the worker captures it (rather than throwing out of the
    // worker, which would leave a sibling's resolution an unhandled rejection)
    // and runCheckBatches rethrows it AFTER the in-flight workers drain.
    await expect(
      runCheckBatches({
        ctx,
        controllers,
        coverageMapped: new Set(),
        views: [],
        concurrency: K,
      }),
    ).rejects.toThrow('boom-c1');
  });

  test('THR-4 gate: no batch is claimed while a peer 429 window is open; dispatch resumes when it clears (K=3)', async () => {
    const { controllers } = seedControllersAndViews(root, 4, 0);
    const runner = noFindingsRunner();
    const budget = new CallBudget({ maxCalls: 50 });
    const signal = new RateLimitSignal();
    const ctx: CheckContext = {
      projectRoot: root,
      runner,
      budget,
      capState: createCapState(100, 50),
      projectLanguage: 'js',
      rateLimitSignal: signal,
    };

    signal.enterBackoff(); // a peer is backing off before dispatch begins
    const pending = runCheckBatches({
      ctx,
      controllers,
      coverageMapped: new Set(),
      views: [],
      concurrency: K,
    });
    // Flush microtasks — every worker parks on waitUntilClear() before claiming,
    // so NO batch is dispatched while the window is open (the claim-loop gate).
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    expect(runner.calls).toHaveLength(0);

    signal.exitBackoff(); // window clears → parked workers wake and dispatch
    const result = await pending;
    expect(runner.calls).toHaveLength(4);
    expect(result.findings).toEqual([]);
    expect(result.rateLimitExhausted).toBeNull();
  });
});
