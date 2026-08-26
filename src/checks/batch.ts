/**
 * V1.9.4 PERF-2 / PERF-8 — batched check dispatch.
 *
 * The three controller-js checks (`no-direct-dom`, `no-sync-odata`,
 * `missing-test-coverage`) and the two view-xml checks (`missing-i18n`,
 * `globals-in-views`) are dispatched as ONE `claude -p` call per file instead of
 * one per check: the embedded source and the per-call overhead are sent ONCE,
 * cutting the controller fan-out 3N→N and the view fan-out 2M→M. Findings come
 * back in the existing `{"findings":[…]}` envelope (parsed by `findingsSchema`,
 * normalised by `normalizeFinding` — the `file` pin and the verify-then-accept
 * flow are unchanged); each finding names its own `checkId`. `missing-teardown`
 * (qunit-test) and `manifest-component-drift` (project) are NOT batched — they
 * keep their per-check `runCheckLoop` dispatch.
 *
 * The batch prompts deliberately carry each check's full instruction text and its
 * literal ``Static check: `<id>` `` header: detection quality is preserved (the
 * diagnosis warns that dropping context the model needs costs more in extra
 * retries than it saves), and the per-check phrasing keeps the existing
 * fake-runner test matchers — keyed on those headers + the embedded source —
 * firing against the batch prompt.
 *
 * Cap accounting + the run-terminating signals (budget / rate-limit) are handled
 * by {@link callLlmForFindingsBatch} (`_shared.ts`) and {@link runCheckBatches}
 * below, which mirrors `runCheckLoop`'s halt contract.
 */

import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { BudgetExhaustedError } from '../claude/budget.js';
import { RateLimitExhaustedError } from '../claude/binary-runner.js';
import { resolveControllerRelFromView } from '../project/controller-resolve.js';
import { FALLBACK_LAYOUT, resolveQUnitRoot } from '../project/test-layout.js';
import type { ProjectLanguage } from '../project/detect.js';
import type { CheckId, Finding } from '../types.js';
import { computeCacheKey } from './cache.js';
import { expectedTestPath } from './missing-test-coverage.js';
import { callLlmForFindingsBatch, sourceFence, tsSourceGuidance } from './_shared.js';
import type { CheckContext } from './types.js';

/**
 * V1.9.8 (CA-2) — the batch prompt builders' version, a component of the
 * detection cache key. BUMP THIS on ANY semantic change to the prompts the
 * builders below assemble (wording, check instructions, output contract,
 * embedded-content framing) — even one that leaves some prompts textually
 * identical — so stale cached findings from the old prompt regime can never
 * be served against the new one. The `prompt-version-ratchet` unit test pins
 * this file's content hash and fails on any drift without a conscious
 * decision here.
 */
export const PROMPT_VERSION = 1;

/** The checks the controller batch covers (PERF-2). One LLM call per controller. */
export const CONTROLLER_BATCH_CHECK_IDS = [
  'no-direct-dom',
  'no-sync-odata',
  'missing-test-coverage',
] as const satisfies readonly CheckId[];

/** The checks the view batch covers (PERF-8). One LLM call per view. */
export const VIEW_BATCH_CHECK_IDS = [
  'missing-i18n',
  'globals-in-views',
] as const satisfies readonly CheckId[];

/**
 * The 5 checkIds dispatched as batches. `validate.ts` filters these out of the
 * `runCheckLoop` target sets so they fire once-per-file via the batch phase,
 * never once-per-check via the loop. They REMAIN in the `CHECKS` registry (so
 * `checksByScope`/`checkById`/the estimator and their tests are unchanged); only
 * the per-check loop dispatch is suppressed.
 */
export const BATCHED_CHECK_IDS: ReadonlySet<CheckId> = new Set<CheckId>([
  ...CONTROLLER_BATCH_CHECK_IDS,
  ...VIEW_BATCH_CHECK_IDS,
]);

// ---------------------------------------------------------------------------
// Prompt builders

export interface ControllerBatchPromptArgs {
  readonly relPath: string;
  readonly content: string;
  readonly language?: ProjectLanguage;
  /**
   * Present iff `missing-test-coverage` is included for this controller — i.e. an
   * in-scope test imports it (the V1.9.1 coverage triage's `mapped` set). When
   * absent the batch covers only `no-direct-dom` + `no-sync-odata`, exactly
   * mirroring the per-check world where an unmapped controller never gets a
   * coverage call (it rolls up into one deterministic finding instead).
   */
  readonly coverage?: {
    readonly testRel: string;
    readonly testContent: string | null;
  };
}

/**
 * PERF-2 — one prompt covering the controller-js checks. The controller source is
 * embedded ONCE (raw — comment stripping is a generate-only change, PERF-3; a
 * check reports 1-based line numbers, so the verbatim source keeps them honest).
 */
export function buildControllerBatchPrompt(args: ControllerBatchPromptArgs): string {
  const language = args.language ?? 'js';
  const fence = '```' + sourceFence(language);
  const lines: string[] = [
    'Batched static analysis: run the checks below over ONE SAPUI5 controller in a',
    'single pass and return all findings together. Each finding MUST set its',
    '"checkId" to the id of the check that produced it.',
    '',
    ...tsSourceGuidance(language),
    'Static check: `no-direct-dom`.',
    'Flag direct DOM access that should be `this.byId(...)` or a stored control',
    'reference: `document.querySelector`, `document.getElementById`,',
    '`document.getElementsBy*`, and jQuery selectors (`$(...)`, `jQuery(...)`) that',
    'target DOM nodes the controller owns. Do NOT flag `byId()` calls or property',
    'reads on framework objects (e.g. `this.getView().byId(...)`).',
    '',
    'Static check: `no-sync-odata`.',
    'Flag synchronous OData / model usage: `async: false` in options to',
    '`new ODataModel(...)`, `new JSONModel(...)`, `loadData`, `read`, `create`,',
    '`update`, or `remove`; a `loadData(...)` whose last positional argument is the',
    'literal `false`; or `bSynchronous = true` / `useBatch = false` on an OData v2',
    'model that awaits no promise. Do NOT flag idiomatic async usage',
    '(Promise-returning calls, `requestObject`, `requestProperty`, …).',
    '',
  ];
  if (args.coverage !== undefined) {
    lines.push(
      'Static check: `missing-test-coverage`.',
      'Enumerate the public methods this controller exports and identify which are',
      'NOT covered by a QUnit test. Lifecycle hooks (`onInit`, `onExit`,',
      '`onBeforeRendering`, `onAfterRendering`) are public and DO count toward',
      'coverage. Ignore methods whose name begins with `_`. A method is covered when',
      'the test file has a `QUnit.test(...)` whose body references it, or a',
      '`QUnit.module(...)` whose `beforeEach` constructs the controller and exercises',
      'it. Every `missing-test-coverage` finding is multi-file (a new test must be',
      'created), so it MUST set "proposedFix": null with the rationale + a sketch of',
      'what the test should assert in "explanation".',
      '',
    );
  }
  lines.push(`File: ${args.relPath}`, fence, args.content, '```', '');
  if (args.coverage !== undefined) {
    if (args.coverage.testContent === null) {
      lines.push(`No test file exists at ${args.coverage.testRel}.`, '');
    } else {
      lines.push(
        `Existing test file: ${args.coverage.testRel}`,
        fence,
        args.coverage.testContent,
        '```',
        '',
      );
    }
  }
  const idUnion =
    args.coverage !== undefined
      ? '"no-direct-dom" | "no-sync-odata" | "missing-test-coverage"'
      : '"no-direct-dom" | "no-sync-odata"';
  lines.push(
    'Output: a single JSON object {"findings": [Finding, ...]} covering ALL the',
    'checks above. Each Finding has:',
    `  - "checkId": ${idUnion}`,
    `  - "file": "${args.relPath}"`,
    '  - "line": <1-based line number>',
    '  - "message": short description of the violation',
    '  - EITHER "proposedFix": {"newFileContent": "<full rewritten file content>"}',
    '    when a safe single-file rewrite exists, OR "proposedFix": null with an',
    '    "explanation" when it does not (ALWAYS null for `missing-test-coverage`).',
    'Coalesce multiple violations of the SAME check in this file into one finding.',
    'Return {"findings": []} if every check is clean.',
  );
  return lines.join('\n');
}

export interface ViewBatchPromptArgs {
  readonly viewRel: string;
  readonly viewContent: string;
  readonly controllerRel: string | null;
  readonly controllerContent: string | null;
  readonly language?: ProjectLanguage;
}

/**
 * PERF-8 — one prompt covering the view-xml checks. The view XML is embedded once
 * (full — the OPA5 surface-summary reduction is generate-only, PERF-11; the view
 * checks need the literal attributes), and the paired controller (which only
 * `globals-in-views` needs) is embedded once. The `globals-in-views`
 * "proposedFix: null when the fix needs the controller" instruction is preserved
 * verbatim (diagnosis §3 PERF-8 invariant).
 */
export function buildViewBatchPrompt(args: ViewBatchPromptArgs): string {
  const language = args.language ?? 'js';
  const controllerBlock =
    args.controllerRel !== null && args.controllerContent !== null
      ? [
          `Paired controller: ${args.controllerRel}`,
          '```' + sourceFence(language),
          args.controllerContent,
          '```',
        ]
      : ['No paired controller could be located deterministically.'];
  return [
    'Batched static analysis: run the checks below over ONE SAPUI5 XML view in a',
    'single pass and return all findings together. Each finding MUST set its',
    '"checkId" to the id of the check that produced it.',
    '',
    'Static check: `missing-i18n`.',
    'Flag hardcoded human-readable string attributes that should be an `{i18n>key}`',
    'binding: `text`, `title`, `placeholder`, `tooltip`, `description`,',
    '`headerText`, `footerText`, `label`. Do NOT flag values that already look like',
    'a binding (start with `{` and end with `}`), pure-numeric values,',
    'single-character icons, or identifier-like values (no spaces, camelCase,',
    'ALL_CAPS). A `missing-i18n` proposedFix rewrites ONLY the .view.xml — never',
    'i18n.properties.',
    '',
    'Static check: `globals-in-views`.',
    'Flag bindings or event handlers that point at things the project does not own:',
    '`press=".handler"` / `change=".handler"` etc. where `.handler` is NOT defined',
    'on the paired controller; bindings whose path includes `window.`,',
    '`globalThis.`, `top.`, `parent.`, or `undefined`; formatter references to',
    'functions not present on the controller. Do NOT flag bindings into a declared',
    'model (`{i18n>...}`, `{/path}`, `{namedModel>/path}`) when no global is',
    'involved. A `globals-in-views` proposedFix is possible ONLY when the fix is',
    'confined to the view file (e.g. removing a stray `window.` reference); return',
    '"proposedFix": null with an "explanation" whenever the fix would also need to',
    'touch the controller.',
    '',
    `View: ${args.viewRel}`,
    '```xml',
    args.viewContent,
    '```',
    '',
    ...controllerBlock,
    '',
    'Output: a single JSON object {"findings": [Finding, ...]} covering BOTH checks.',
    'Each Finding has:',
    '  - "checkId": "missing-i18n" | "globals-in-views"',
    `  - "file": "${args.viewRel}"`,
    '  - "line": <1-based line number in the view>',
    '  - "message": short description of the violation',
    '  - EITHER "proposedFix": {"newFileContent": "<full rewritten view content>"}',
    '    when the fix is confined to the view file, OR "proposedFix": null with an',
    '    "explanation".',
    'Coalesce multiple violations of the SAME check in this file into one finding.',
    'Return {"findings": []} if both checks are clean.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Batch dispatch

export interface BatchPhaseResult {
  readonly findings: readonly Finding[];
  /** True when a `budget.consume()` threw mid-phase (mirrors runCheckLoop). */
  readonly budgetExhausted: boolean;
  /** Set when a batch call surfaced a run-terminating rate-limit (mirrors runCheckLoop). */
  readonly rateLimitExhausted: RateLimitExhaustedError | null;
}

/**
 * Drive the controller batches then the view batches, sharing the run's budget /
 * cap / rate-limit handling with `runCheckLoop`. A `RateLimitExhaustedError` halts
 * the phase and surfaces via `rateLimitExhausted`; a `BudgetExhaustedError` halts
 * via `budgetExhausted`. Findings collected before a halt are preserved (no data
 * loss), exactly like `runCheckLoop`.
 */
export async function runCheckBatches(args: {
  readonly ctx: CheckContext;
  readonly controllers: readonly string[];
  /**
   * The subset of `controllers` an in-scope test imports (the coverage triage's
   * `mapped` set). A controller in this set has `missing-test-coverage` included
   * in its batch; one not in it does not (it rolls up deterministically upstream).
   */
  readonly coverageMapped: ReadonlySet<string>;
  readonly views: readonly string[];
  /**
   * V1.9.7 (THR-2) — bounded batch-dispatch width. Default 1 = one worker
   * pulling batches in target order, byte-identical to the pre-V1.9.7 two-loop
   * dispatch. At K>1 up to K controller/view batches run concurrently; results
   * land in per-index slots so `findings` stays in target order regardless of
   * completion order, and `ctx.rateLimitSignal` (set only at K>1) drains new
   * dispatch during a peer's 429 backoff window. Findings-only calls have no
   * verify/write hazard, so — unlike generate — there is no serialization lane;
   * the only shared state is the (synchronously-guarded) budget + cap accounting
   * inside `callLlmForFindingsBatch`.
   */
  readonly concurrency?: number;
}): Promise<BatchPhaseResult> {
  // Flat, TARGET-ORDERED work-list: every controller batch, then every view
  // batch — the exact order the sequential loop dispatched them. Per-index
  // result slots (below) reproduce the sequential findings order byte-for-byte
  // no matter which worker finishes first.
  const jobs: ReadonlyArray<() => Promise<readonly Finding[]>> = [
    ...args.controllers.map(
      (target) => (): Promise<readonly Finding[]> =>
        runControllerBatch(target, args.ctx, args.coverageMapped.has(target)),
    ),
    ...args.views.map(
      (target) => (): Promise<readonly Finding[]> => runViewBatch(target, args.ctx),
    ),
  ];

  const results = new Array<readonly Finding[] | undefined>(jobs.length);
  let cursor = 0;
  let stop = false;
  let budgetExhausted = false;
  let rateLimitExhausted: RateLimitExhaustedError | null = null;
  let unexpected: unknown = null;

  const claimNext = (): number => {
    if (stop || cursor >= jobs.length) return -1;
    const i = cursor;
    cursor += 1;
    return i;
  };

  const signal = args.ctx.rateLimitSignal;

  const worker = async (): Promise<void> => {
    for (;;) {
      // THR-2/THR-4: drain NEW dispatch while any peer is in a 429 backoff
      // window, BEFORE claiming — a paused worker holds no batch, and the budget
      // (charged synchronously inside callLlmForFindingsBatch) is untouched: the
      // batch is drained, not dispatched. Instant when `signal` is undefined
      // (sequential path) or no window is active. On a terminal halt the
      // backing-off schedule's `finally` reopens the window, so a parked worker
      // wakes, sees `stop`, and exits via claimNext() → -1 (no deadlock).
      if (signal !== undefined) await signal.waitUntilClear();
      const i = claimNext();
      if (i < 0) return;
      const job = jobs[i]!;
      try {
        results[i] = await job();
      } catch (err) {
        const halt = classifyHalt(err);
        if (halt === null) {
          // Unexpected error: stop the pool and rethrow AFTER in-flight workers
          // drain (mirrors the sequential loop's `throw err`; capturing rather
          // than throwing out of the worker keeps a sibling's resolution from
          // becoming an unhandled rejection).
          unexpected = err;
          stop = true;
          return;
        }
        // Typed run-terminating halt (rate-limit / budget). Stop claiming NEW
        // batches; in-flight peers finish and keep their slot findings — no data
        // loss, exactly like the sequential loop's early return. Rate-limit is
        // recorded once (first seen); both flags may set if two peers halt.
        if (halt.rateLimitExhausted !== null && rateLimitExhausted === null) {
          rateLimitExhausted = halt.rateLimitExhausted;
        }
        if (halt.budgetExhausted) budgetExhausted = true;
        stop = true;
      }
    }
  };

  const degree = Math.min(Math.max(1, args.concurrency ?? 1), Math.max(1, jobs.length));
  await Promise.all(Array.from({ length: degree }, () => worker()));
  if (unexpected !== null) throw unexpected;

  // Flatten completed per-index slots in TARGET order. An undefined slot is a
  // batch that was never claimed because the pool halted first (or the one whose
  // throw triggered the halt) — dropped, like the sequential loop's un-run
  // remainder.
  const findings: Finding[] = [];
  for (const slot of results) {
    if (slot !== undefined) findings.push(...slot);
  }
  return { findings, budgetExhausted, rateLimitExhausted };
}

function classifyHalt(
  err: unknown,
): Pick<BatchPhaseResult, 'budgetExhausted' | 'rateLimitExhausted'> | null {
  if (err instanceof RateLimitExhaustedError) {
    return { budgetExhausted: false, rateLimitExhausted: err };
  }
  if (err instanceof BudgetExhaustedError) {
    return { budgetExhausted: true, rateLimitExhausted: null };
  }
  return null;
}

async function runControllerBatch(
  target: string,
  ctx: CheckContext,
  includeCoverage: boolean,
): Promise<readonly Finding[]> {
  const content = await readFile(target, 'utf8');
  const relPath = toPosix(relative(ctx.projectRoot, target));
  const language = ctx.projectLanguage ?? 'js';
  const checkIds: CheckId[] = ['no-direct-dom', 'no-sync-odata'];
  let coverage: ControllerBatchPromptArgs['coverage'];
  if (includeCoverage) {
    checkIds.push('missing-test-coverage');
    const qunitRoot =
      ctx.testLayout !== undefined ? resolveQUnitRoot(ctx.testLayout) : FALLBACK_LAYOUT.qunit;
    const testRel = expectedTestPath(relPath, qunitRoot);
    const testAbs = join(ctx.projectRoot, testRel);
    const testContent = existsSync(testAbs) ? readFileSync(testAbs, 'utf8') : null;
    coverage = { testRel, testContent };
  }
  const prompt = buildControllerBatchPrompt({
    relPath,
    content,
    language,
    ...(coverage !== undefined ? { coverage } : {}),
  });
  return callLlmForFindingsBatch({
    checkIds,
    file: relPath,
    prompt,
    ctx,
    ...cacheKeyFor(checkIds, prompt, ctx),
  });
}

async function runViewBatch(target: string, ctx: CheckContext): Promise<readonly Finding[]> {
  const viewContent = await readFile(target, 'utf8');
  const viewRel = toPosix(relative(ctx.projectRoot, target));
  const language = ctx.projectLanguage ?? 'js';
  // Layout-aware paired-controller resolution (existence-gated by the resolver),
  // mirroring globals-in-views' findPairedController.
  const controllerRel = resolveControllerRelFromView({
    projectRoot: ctx.projectRoot,
    viewContent,
  });
  const controllerContent =
    controllerRel !== null ? readFileSync(join(ctx.projectRoot, controllerRel), 'utf8') : null;
  const prompt = buildViewBatchPrompt({
    viewRel,
    viewContent,
    controllerRel,
    controllerContent,
    language,
  });
  return callLlmForFindingsBatch({
    checkIds: [...VIEW_BATCH_CHECK_IDS],
    file: viewRel,
    prompt,
    ctx,
    ...cacheKeyFor(VIEW_BATCH_CHECK_IDS, prompt, ctx),
  });
}

/**
 * V1.9.8 — the detection cache key, computed NEXT TO prompt assembly (the
 * prompt string subsumes every embedded input: primary file bytes, paired
 * test/controller content, the coverage flag — invariant 1). Present iff the
 * run carries a detection cache, so the uncached path pays no hashing.
 */
function cacheKeyFor(
  checkIds: readonly CheckId[],
  prompt: string,
  ctx: CheckContext,
): { cacheKey: string } | Record<string, never> {
  if (ctx.detectionCache === undefined) return {};
  return {
    cacheKey: computeCacheKey({
      promptVersion: PROMPT_VERSION,
      checkIds,
      model: ctx.model ?? 'default',
      claudeVersion: ctx.claudeVersion ?? 'unknown',
      prompt,
    }),
  };
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}
