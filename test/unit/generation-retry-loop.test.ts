import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { CallBudget } from '../../src/claude/budget.js';
import {
  ClaudeProcessKilledError,
  RateLimitExhaustedError,
} from '../../src/claude/binary-runner.js';
import { FakeClaudeRunner } from '../../src/claude/fake-runner.js';
import { generateAndVerify } from '../../src/generation/retry-loop.js';
import { checkTsTestShape } from '../../src/generation/qunit.js';
import { verifyArtifact } from '../../src/verify/pipeline.js';
import type {
  VerifyAdapters,
  VerifyPipelineInput,
  VerifyResult,
} from '../../src/verify/pipeline.js';
import type { Ui5LintRunArgs } from '../../src/verify/ui5lint.js';
import type { EslintRunArgs } from '../../src/verify/eslint.js';
import type { KarmaRunArgs } from '../../src/verify/karma.js';
import type { TscRunArgs } from '../../src/verify/tsc.js';
import { ALLOWED_TOOLS } from '../../src/claude/runner.js';
import { Semaphore } from '../../src/util/concurrency.js';

function passing(): VerifyResult {
  return { ok: true, steps: [], feedbackForLlm: '' };
}
function failed(stderr: string): VerifyResult {
  return {
    ok: false,
    steps: [],
    failedStep: 'karma',
    feedbackForLlm: stderr,
  };
}

describe('generateAndVerify — retry loop', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sapui5-gen-loop-'));
    mkdirSync(join(root, 'webapp', 'test', 'unit'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('attempt 1 verifies → writes file, returns generated', async () => {
    const target = join(root, 'webapp', 'test', 'unit', 'Foo.qunit.js');
    const runner = new FakeClaudeRunner([
      { match: /./, response: { raw: JSON.stringify({ newFileContent: '// PASS\n' }) } },
    ]);
    const outcome = await generateAndVerify(
      {
        initialPrompt: 'Generate Foo',
        buildRefinementPrompt: () => 'refine',
        targetTestFileAbs: target,
      },
      {
        projectRoot: root,
        runner,
        budget: new CallBudget({ maxCalls: 10 }),
        eslintEnabled: false,
        verifyFn: async () => passing(),
      },
    );
    expect(outcome.kind).toBe('generated');
    if (outcome.kind === 'generated') {
      expect(outcome.attempts).toBe(1);
      expect(outcome.testFileRel).toBe('webapp/test/unit/Foo.qunit.js');
    }
    expect(readFileSync(target, 'utf8')).toBe('// PASS\n');
    // Allowed-tools allowlist hard-coded by buildClaudeArgs (CLAUDE.md §1.7).
    expect(runner.calls[0]?.allowedTools).toBe(ALLOWED_TOOLS);
    expect(runner.calls[0]?.allowedTools).not.toContain('Bash(rm*)');
  });

  test('3× verify failures → file moved to webapp/test/_failing with .failing.qunit.js suffix', async () => {
    const target = join(root, 'webapp', 'test', 'unit', 'Bad.qunit.js');
    let initialCall = 0;
    let refineCall = 0;
    const runner = new FakeClaudeRunner([
      {
        match: (a) => a.prompt.includes('refine'),
        response: () => {
          refineCall += 1;
          return { raw: JSON.stringify({ newFileContent: `// BROKEN ${refineCall}\n` }) };
        },
      },
      {
        match: /./,
        response: () => {
          initialCall += 1;
          return { raw: JSON.stringify({ newFileContent: '// BROKEN initial\n' }) };
        },
      },
    ]);
    let verifyCalls = 0;
    const outcome = await generateAndVerify(
      {
        initialPrompt: 'Generate Bad',
        buildRefinementPrompt: () => 'refine please',
        targetTestFileAbs: target,
      },
      {
        projectRoot: root,
        runner,
        budget: new CallBudget({ maxCalls: 10 }),
        eslintEnabled: false,
        verifyFn: async () => {
          verifyCalls += 1;
          return failed(`karma error #${verifyCalls}`);
        },
      },
    );
    expect(outcome.kind).toBe('quarantined');
    if (outcome.kind === 'quarantined') {
      expect(outcome.attempts).toBe(3);
      expect(outcome.originalTestFileRel).toBe('webapp/test/unit/Bad.qunit.js');
      expect(outcome.quarantinedAtRel).toBe(
        'webapp/test/_failing/Bad.failing.qunit.js',
      );
      expect(outcome.reason).toMatch(/karma|verification/i);
    }
    expect(existsSync(target)).toBe(false);
    expect(
      existsSync(join(root, 'webapp', 'test', '_failing', 'Bad.failing.qunit.js')),
    ).toBe(true);
    expect(initialCall).toBe(1);
    expect(refineCall).toBe(2);
    expect(verifyCalls).toBe(3);
  });

  test('LLM returns malformed initial output → no-output, no file written', async () => {
    const target = join(root, 'webapp', 'test', 'unit', 'Garbage.qunit.js');
    const runner = new FakeClaudeRunner([
      { match: /./, response: { raw: 'not json at all' } },
    ]);
    const outcome = await generateAndVerify(
      {
        initialPrompt: 'Generate Garbage',
        buildRefinementPrompt: () => 'refine',
        targetTestFileAbs: target,
      },
      {
        projectRoot: root,
        runner,
        budget: new CallBudget({ maxCalls: 10 }),
        eslintEnabled: false,
        verifyFn: async () => passing(),
      },
    );
    expect(outcome.kind).toBe('no-output');
    expect(existsSync(target)).toBe(false);
  });

  test('V1.3-3: process killed on the initial call → no-output, no file written', async () => {
    const target = join(root, 'webapp', 'test', 'unit', 'Killed.qunit.js');
    const runner = new FakeClaudeRunner([
      {
        match: /./,
        response: () => {
          throw new ClaudeProcessKilledError(
            'cid-killed',
            137,
            'Killed',
            '/tmp/err.json',
          );
        },
      },
    ]);
    const outcome = await generateAndVerify(
      {
        initialPrompt: 'Generate Killed',
        buildRefinementPrompt: () => 'refine',
        targetTestFileAbs: target,
      },
      {
        projectRoot: root,
        runner,
        budget: new CallBudget({ maxCalls: 10 }),
        eslintEnabled: false,
        verifyFn: async () => passing(),
      },
    );
    expect(outcome.kind).toBe('no-output');
    if (outcome.kind === 'no-output') {
      expect(outcome.reason).toMatch(/process killed/i);
    }
    expect(existsSync(target)).toBe(false);
  });

  test('V1.3-3: process killed on the refinement call → quarantined', async () => {
    const target = join(root, 'webapp', 'test', 'unit', 'KilledRefine.qunit.js');
    const runner = new FakeClaudeRunner([
      {
        match: (a) => a.prompt.includes('refine'),
        response: () => {
          throw new ClaudeProcessKilledError(
            'cid-killed-refine',
            137,
            'Killed',
            '/tmp/err.json',
          );
        },
      },
      {
        match: /./,
        response: { raw: JSON.stringify({ newFileContent: '// BROKEN initial\n' }) },
      },
    ]);
    const outcome = await generateAndVerify(
      {
        initialPrompt: 'Generate KilledRefine',
        buildRefinementPrompt: () => 'refine please',
        targetTestFileAbs: target,
      },
      {
        projectRoot: root,
        runner,
        budget: new CallBudget({ maxCalls: 10 }),
        eslintEnabled: false,
        verifyFn: async () => failed('karma failed'),
      },
    );
    expect(outcome.kind).toBe('quarantined');
    if (outcome.kind === 'quarantined') {
      expect(outcome.reason).toMatch(/process killed/i);
    }
    expect(existsSync(target)).toBe(false);
    expect(
      existsSync(
        join(root, 'webapp', 'test', '_failing', 'KilledRefine.failing.qunit.js'),
      ),
    ).toBe(true);
  });

  test('COR-13c: a RESULT that stays rate-limited after backoff throws, never returns no-output content', async () => {
    // The thrown-error tests below cover a runner that THROWS
    // RateLimitExhaustedError. This locks the other half: a runner that RETURNS
    // a rate-limited RESULT on every attempt must, after the SPEC §2.12 backoff
    // is exhausted, throw via retry-loop's `throwOnExhaustion` wiring — rather
    // than returning the still-rate-limited result (which `safeJson` would then
    // fail to parse → a no-output, mis-attributing a quota cap as a content
    // failure). Reverting `throwOnExhaustion` in retry-loop.ts fails this.
    const target = join(root, 'webapp', 'test', 'unit', 'RateResult.qunit.js');
    const runner = new FakeClaudeRunner([
      {
        match: /./,
        response: { ok: false, raw: '429 too many requests', stderr: 'rate limit exceeded' },
      },
    ]);
    // An instant `backoffSleeper` drives the SPEC §2.12 schedule to exhaustion
    // without the real 1s/4s/16s waits.
    await expect(
      generateAndVerify(
        {
          initialPrompt: 'Generate RateResult',
          buildRefinementPrompt: () => 'refine',
          targetTestFileAbs: target,
        },
        {
          projectRoot: root,
          runner,
          budget: new CallBudget({ maxCalls: 10 }),
          eslintEnabled: false,
          verifyFn: async () => passing(),
          backoffSleeper: async () => {},
        },
      ),
    ).rejects.toBeInstanceOf(RateLimitExhaustedError);
    expect(existsSync(target)).toBe(false);
  });

  test('V1.3-3: rate-limit exhausted on the initial call → generateAndVerify rejects', async () => {
    const target = join(root, 'webapp', 'test', 'unit', 'RateInitial.qunit.js');
    const runner = new FakeClaudeRunner([
      {
        match: /./,
        response: () => {
          throw new RateLimitExhaustedError('cid-rate', 4, 'API Error: 429');
        },
      },
    ]);
    await expect(
      generateAndVerify(
        {
          initialPrompt: 'Generate RateInitial',
          buildRefinementPrompt: () => 'refine',
          targetTestFileAbs: target,
        },
        {
          projectRoot: root,
          runner,
          budget: new CallBudget({ maxCalls: 10 }),
          eslintEnabled: false,
          verifyFn: async () => passing(),
        },
      ),
    ).rejects.toBeInstanceOf(RateLimitExhaustedError);
    expect(existsSync(target)).toBe(false);
  });

  test('V1.3-3: rate-limit exhausted on the refinement call → rejects, attempt-1 file quarantined first', async () => {
    const target = join(root, 'webapp', 'test', 'unit', 'RateRefine.qunit.js');
    const runner = new FakeClaudeRunner([
      {
        match: (a) => a.prompt.includes('refine'),
        response: () => {
          throw new RateLimitExhaustedError('cid-rate-refine', 4, 'API Error: 429');
        },
      },
      {
        match: /./,
        response: { raw: JSON.stringify({ newFileContent: '// BROKEN initial\n' }) },
      },
    ]);
    await expect(
      generateAndVerify(
        {
          initialPrompt: 'Generate RateRefine',
          buildRefinementPrompt: () => 'refine please',
          targetTestFileAbs: target,
        },
        {
          projectRoot: root,
          runner,
          budget: new CallBudget({ maxCalls: 10 }),
          eslintEnabled: false,
          verifyFn: async () => failed('karma failed'),
        },
      ),
    ).rejects.toBeInstanceOf(RateLimitExhaustedError);
    // The attempt-1 file was quarantined before the throw propagated.
    expect(existsSync(target)).toBe(false);
    expect(
      existsSync(
        join(root, 'webapp', 'test', '_failing', 'RateRefine.failing.qunit.js'),
      ),
    ).toBe(true);
  });
});

describe('generateAndVerify — V1.6 verify lane', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sapui5-gen-lane-'));
    mkdirSync(join(root, 'webapp', 'test', 'unit'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const delay = (ms: number): Promise<void> =>
    new Promise((r) => setTimeout(r, ms));

  function passingRunner(): FakeClaudeRunner {
    return new FakeClaudeRunner([
      { match: /./, response: { raw: JSON.stringify({ newFileContent: '// PASS\n' }) } },
    ]);
  }

  /** Run two candidates (A, B) concurrently; `lane` is shared (or omitted). */
  function runTwoConcurrently(args: {
    readonly lane?: Semaphore;
    readonly verifyFn: () => Promise<VerifyResult>;
    readonly register?: (id: string) => () => Promise<void>;
  }): Promise<unknown[]> {
    const mk = (name: string): Promise<unknown> =>
      generateAndVerify(
        {
          initialPrompt: `Generate ${name}`,
          buildRefinementPrompt: () => 'refine',
          targetTestFileAbs: join(root, 'webapp', 'test', 'unit', `${name}.qunit.js`),
          ...(args.register !== undefined ? { register: args.register(name) } : {}),
        },
        {
          projectRoot: root,
          runner: passingRunner(),
          budget: new CallBudget({ maxCalls: 10 }),
          eslintEnabled: false,
          verifyFn: args.verifyFn,
          ...(args.lane !== undefined ? { verifyLane: args.lane } : {}),
        },
      );
    return Promise.all([mk('A'), mk('B')]);
  }

  test('a shared verify lane serialises verify across concurrent candidates (peak concurrency = 1)', async () => {
    const lane = new Semaphore(1);
    let active = 0;
    let peak = 0;
    const verifyFn = async (): Promise<VerifyResult> => {
      active += 1;
      peak = Math.max(peak, active);
      await delay(30);
      active -= 1;
      return passing();
    };

    const [a, b] = await runTwoConcurrently({ lane, verifyFn });
    expect((a as { kind: string }).kind).toBe('generated');
    expect((b as { kind: string }).kind).toBe('generated');
    // The lane held the two verifies apart — they never ran at the same time.
    expect(peak).toBe(1);
  });

  test('control: WITHOUT the lane the same two verifies overlap (peak = 2) — proves the lane is load-bearing', async () => {
    let active = 0;
    let peak = 0;
    const verifyFn = async (): Promise<VerifyResult> => {
      active += 1;
      peak = Math.max(peak, active);
      await delay(30);
      active -= 1;
      return passing();
    };

    await runTwoConcurrently({ verifyFn }); // no lane
    // With no lane both candidates verify concurrently. If a future refactor
    // dropped the lane wrapping, the test above would regress to this peak.
    expect(peak).toBe(2);
  });

  test('register runs inside the lane → no lost update when two candidates register concurrently', async () => {
    const lane = new Semaphore(1);
    // A deliberately non-atomic read-modify-write registry: read a snapshot,
    // yield, then write the mutated snapshot back. Without serialisation the
    // second writer clobbers the first (the V1.3-4 → V1.6 registration race).
    const registry: string[] = [];
    const register = (id: string) => async (): Promise<void> => {
      const snapshot = [...registry];
      await delay(15);
      snapshot.push(id);
      registry.length = 0;
      registry.push(...snapshot);
    };

    await runTwoConcurrently({
      lane,
      verifyFn: async () => passing(),
      register,
    });

    // Both registrations survived because the lane serialised the RMW.
    expect([...registry].sort()).toEqual(['A', 'B']);
  });

  test('under the lane, a candidate that fails then refines is UNREGISTERED during the refinement window', async () => {
    // The subtle contamination the lane-alone misses: a test registered at
    // attempt 1 that FAILS would, without this fix, stay registered (with its
    // failing content) while the candidate refines OUTSIDE the lane — so a peer
    // worker's whole-suite karma would execute it and fail a sound candidate.
    const lane = new Semaphore(1);
    const registry = new Set<string>();
    let snapshotAtRefinement: readonly string[] | null = null;

    const runner = new FakeClaudeRunner([
      {
        match: (a) => a.prompt.includes('refine'),
        response: () => {
          // Captured BETWEEN the failed attempt 1 and the attempt-2 verify.
          snapshotAtRefinement = [...registry];
          return { raw: JSON.stringify({ newFileContent: '// FIXED\n' }) };
        },
      },
      { match: /./, response: { raw: JSON.stringify({ newFileContent: '// initial broken\n' }) } },
    ]);

    let verifyN = 0;
    const outcome = await generateAndVerify(
      {
        initialPrompt: 'Generate Foo',
        buildRefinementPrompt: () => 'refine please',
        targetTestFileAbs: join(root, 'webapp', 'test', 'unit', 'Foo.qunit.js'),
        register: async () => {
          registry.add('Foo');
        },
        unregister: async () => {
          registry.delete('Foo');
        },
      },
      {
        projectRoot: root,
        runner,
        budget: new CallBudget({ maxCalls: 10 }),
        eslintEnabled: false,
        verifyFn: async () => {
          verifyN += 1;
          return verifyN === 1 ? failed('karma red attempt 1') : passing();
        },
        verifyLane: lane,
      },
    );

    expect(outcome.kind).toBe('generated'); // passed on attempt 2
    // The load-bearing assertion: nothing was registered while it refined.
    // Without the unregister-on-fail fix this snapshot would be ['Foo'].
    expect(snapshotAtRefinement).toEqual([]);
    // ...and the now-passing test ends registered.
    expect([...registry]).toEqual(['Foo']);
  });

  // R2.3(i) (AUDIT §5.4) — the SPEC §2.15 lane invariant ("the only
  // registered-but-unverified test is the worker's own") must hold on the
  // THROW path, not just the returned-!ok path. A production verifyFn can
  // throw (ui5lint adapter, audit decorator); pre-R2.3 the candidate stayed
  // registered while the error unwound.
  function throwPathHarness(args: { readonly lane?: Semaphore }) {
    const registry = new Set<string>();
    const boom = new Error('verify adapter exploded');
    const promise = generateAndVerify(
      {
        initialPrompt: 'Generate Boom',
        buildRefinementPrompt: () => 'refine',
        targetTestFileAbs: join(root, 'webapp', 'test', 'unit', 'Boom.qunit.js'),
        register: async () => {
          registry.add('Boom');
        },
        unregister: async () => {
          registry.delete('Boom');
        },
      },
      {
        projectRoot: root,
        runner: passingRunner(),
        budget: new CallBudget({ maxCalls: 10 }),
        eslintEnabled: false,
        verifyFn: async () => {
          throw boom;
        },
        ...(args.lane !== undefined ? { verifyLane: args.lane } : {}),
      },
    );
    return { registry, boom, promise };
  }

  test('R2.3(i): a THROWING verifyFn under the lane → test unregistered, permit released, original error propagates', async () => {
    const lane = new Semaphore(1);
    const { registry, boom, promise } = throwPathHarness({ lane });

    // The original error propagates unmasked (not an unregister side-effect).
    await expect(promise).rejects.toBe(boom);
    // §2.15 invariant on the throw path: nothing stays registered.
    expect([...registry]).toEqual([]);
    // The lane permit was released — a follow-up acquisition must not hang.
    // (Pinned even though Semaphore.run releases in `finally`: a refactor
    // away from `run` would surface here as a test timeout.)
    await expect(lane.run(async () => 'free')).resolves.toBe('free');
  });

  test('R2.3(i): sequential path (no lane) — a throwing verifyFn still removes the on-disk registration', async () => {
    const { registry, boom, promise } = throwPathHarness({});
    await expect(promise).rejects.toBe(boom);
    // The registration mutation must not persist after the run unwinds.
    expect([...registry]).toEqual([]);
  });

  test('R2.3(i): a failing best-effort unregister does not mask the verifyFn error', async () => {
    const lane = new Semaphore(1);
    const boom = new Error('verify adapter exploded');
    const promise = generateAndVerify(
      {
        initialPrompt: 'Generate Boom',
        buildRefinementPrompt: () => 'refine',
        targetTestFileAbs: join(root, 'webapp', 'test', 'unit', 'Boom.qunit.js'),
        register: async () => {},
        unregister: async () => {
          throw new Error('unregister also failed');
        },
      },
      {
        projectRoot: root,
        runner: passingRunner(),
        budget: new CallBudget({ maxCalls: 10 }),
        eslintEnabled: false,
        verifyFn: async () => {
          throw boom;
        },
        verifyLane: lane,
      },
    );
    // The ORIGINAL verify error wins; the unregister failure is swallowed.
    await expect(promise).rejects.toBe(boom);
    await expect(lane.run(async () => 'free')).resolves.toBe('free');
  });
});

/**
 * V1.9.2 TG-FW — the never-build firewall on the *generate* verify path.
 *
 * Phase 0's choke point: `generateAndVerify` builds its per-attempt verify input
 * at `retry-loop.ts:280-286`. If `ctx.projectLanguage:'ts'` is NOT threaded onto
 * that input (`language:'ts'`), a TS generate run takes the JS lane →
 * `runKarma` → in-process Babel = arbitrary code execution (the HB-FW breach
 * Phase 1's guard-lift would otherwise open). This guard drives the REAL
 * `verifyArtifact` (the production `verifyFn`) with karma-spy adapters and pins
 * `karma-call-count == 0 on the generate TS path` + the static-only step list
 * (`ui5lint → tsc → eslint`, no `karma` token — the behavioural form of the
 * TG-FW-SPEC hardening). It is a fail-on-revert guard: comment out the two
 * spread lines at `retry-loop.ts:280-286` and the firewall regresses to RED
 * (karma is called; the step list becomes the JS `ui5lint → eslint → karma`).
 * Mirrors `test/unit/verify-pipeline-ts.test.ts:80-101` at the generate layer.
 */
describe('generateAndVerify — TS firewall (TG-FW)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sapui5-gen-tsfw-'));
    mkdirSync(join(root, 'webapp', 'test', 'unit'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  interface CallLog {
    ui5lint: Ui5LintRunArgs[];
    eslint: EslintRunArgs[];
    karma: KarmaRunArgs[];
    tsc: TscRunArgs[];
  }

  /** All-passing spy adapters that record every call — a karma call is the breach witness. */
  function spyAdapters(): { adapters: VerifyAdapters; calls: CallLog } {
    const calls: CallLog = { ui5lint: [], eslint: [], karma: [], tsc: [] };
    const adapters: VerifyAdapters = {
      ui5lint: async (args) => {
        calls.ui5lint.push(args);
        return { ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1 };
      },
      eslint: async (args) => {
        calls.eslint.push(args);
        return { ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1 };
      },
      karma: async (args) => {
        calls.karma.push(args);
        return { ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1, testFiles: [] };
      },
      tsc: async (args) => {
        calls.tsc.push(args);
        return { ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1 };
      },
    };
    return { adapters, calls };
  }

  test('THE FIREWALL: a TS generate run threads language:ts onto the verify input → karma is NEVER called', async () => {
    const target = join(root, 'webapp', 'test', 'unit', 'App.controller.qunit.ts');
    const runner = new FakeClaudeRunner([
      { match: /./, response: { raw: JSON.stringify({ newFileContent: '// PASS\n' }) } },
    ]);
    const { adapters, calls } = spyAdapters();
    let capturedInput: VerifyPipelineInput | undefined;
    let capturedResult: VerifyResult | undefined;
    const outcome = await generateAndVerify(
      {
        initialPrompt: 'Generate App.controller test',
        buildRefinementPrompt: () => 'refine',
        targetTestFileAbs: target,
      },
      {
        projectRoot: root,
        runner,
        budget: new CallBudget({ maxCalls: 10 }),
        // eslintEnabled:true so a JS-lane regression would run BOTH eslint AND
        // karma — making the step-list assertion below discriminate the lanes.
        eslintEnabled: true,
        // The Phase-0 fields under test (TG-FW-THREAD).
        projectLanguage: 'ts',
        tscEnabled: true,
        // The production verifyFn IS verifyArtifact; wire spy adapters + capture
        // the input the retry-loop actually built and the steps the lane ran.
        verifyFn: async (input) => {
          capturedInput = input;
          const r = await verifyArtifact({ ...input, adapters });
          capturedResult = r;
          return r;
        },
      },
    );

    expect(outcome.kind).toBe('generated');
    // The load-bearing assertion: karma is structurally unreachable on the TS
    // generate path. A breach (JS lane on TS) records a karma call here.
    expect(calls.karma).toHaveLength(0);
    // The choke point carried the language + tsc gate onto the verify input
    // (TG-FW-THREAD) — these go undefined the instant the spread is reverted.
    expect(capturedInput?.language).toBe('ts');
    expect(capturedInput?.tscEnabled).toBe(true);
    // …so the real pipeline took the static-only lane: ui5lint → tsc → eslint,
    // with NO karma token at all (the behavioural form of TG-FW-SPEC).
    expect(capturedResult?.steps.map((s) => s.step)).toEqual([
      'ui5lint',
      'tsc',
      'eslint',
    ]);
    expect(calls.tsc).toHaveLength(1);
  });
});

/**
 * V1.9.2 Phase 3 (TG-ACCEPT / HB-VACUOUS / TG-QUARANTINE-TS) — the static
 * accept predicate for a generated `.qunit.ts`: `verify.ok` AND the shape gate,
 * with a 3×-failing TS test quarantining to a `.failing.qunit.ts` suffix. The
 * JS path is untouched: no `shapeCheck` is supplied and the suffix stays
 * `.failing.qunit.js` (the first describe's `Bad.failing.qunit.js` test is the
 * frozen JS witness).
 */
describe('generateAndVerify — TS static accept + quarantine (Phase 3)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sapui5-gen-p3-'));
    mkdirSync(join(root, 'webapp', 'test', 'unit'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // TG-QUARANTINE-TS — a 3×-failing `.qunit.ts` quarantines under the `.ts`
  // suffix. Revert the `paths.ts` suffix / `baseWithoutQunit` change and the
  // destination becomes `.failing.qunit.js` (or a broken name) → RED.
  test('3× failures on a .qunit.ts → moved to webapp/test/_failing with the .failing.qunit.ts suffix', async () => {
    const target = join(root, 'webapp', 'test', 'unit', 'App.controller.qunit.ts');
    const runner = new FakeClaudeRunner([
      {
        match: (a) => a.prompt.includes('refine'),
        response: { raw: JSON.stringify({ newFileContent: '// BROKEN refine\n' }) },
      },
      { match: /./, response: { raw: JSON.stringify({ newFileContent: '// BROKEN\n' }) } },
    ]);
    const outcome = await generateAndVerify(
      {
        initialPrompt: 'Generate App.controller test',
        buildRefinementPrompt: () => 'refine please',
        targetTestFileAbs: target,
      },
      {
        projectRoot: root,
        runner,
        budget: new CallBudget({ maxCalls: 10 }),
        eslintEnabled: false,
        projectLanguage: 'ts',
        tscEnabled: true,
        verifyFn: async () => failed('tsc error'),
      },
    );
    expect(outcome.kind).toBe('quarantined');
    if (outcome.kind === 'quarantined') {
      expect(outcome.attempts).toBe(3);
      expect(outcome.originalTestFileRel).toBe(
        'webapp/test/unit/App.controller.qunit.ts',
      );
      expect(outcome.quarantinedAtRel).toBe(
        'webapp/test/_failing/App.controller.failing.qunit.ts',
      );
    }
    expect(existsSync(target)).toBe(false);
    expect(
      existsSync(
        join(root, 'webapp', 'test', '_failing', 'App.controller.failing.qunit.ts'),
      ),
    ).toBe(true);
  });

  // HB-VACUOUS — a tsc/ui5lint/eslint-GREEN test that never asserts on the
  // controller is NOT accepted: the real `checkTsTestShape` gate fails it, the
  // loop refines, and after 3 attempts it quarantines (never a silent green).
  // Revert the accept-gate change in retry-loop.ts → the vacuous test is
  // accepted as `generated` → RED.
  test('shape gate: a vacuous .qunit.ts (verify ok) is rejected → quarantined, never accepted', async () => {
    const controllerId = 'ns/controller/App.controller';
    const target = join(root, 'webapp', 'test', 'unit', 'App.controller.qunit.ts');
    // Every attempt returns a test that type-checks but only asserts `ok(true)`
    // and never references the controller under test.
    const vacuous = 'QUnit.test("loads", function (assert) { assert.ok(true); });\n';
    const runner = new FakeClaudeRunner([
      { match: /./, response: { raw: JSON.stringify({ newFileContent: vacuous }) } },
    ]);
    const outcome = await generateAndVerify(
      {
        initialPrompt: 'Generate App.controller test',
        buildRefinementPrompt: () => 'refine please',
        targetTestFileAbs: target,
        // The real shape gate, exactly as `generateQunitTest` wires it for TS.
        shapeCheck: (content) => checkTsTestShape(content, controllerId),
      },
      {
        projectRoot: root,
        runner,
        budget: new CallBudget({ maxCalls: 10 }),
        eslintEnabled: false,
        projectLanguage: 'ts',
        tscEnabled: true,
        // The static lane PASSES — the shape gate is the only thing rejecting it.
        verifyFn: async () => passing(),
      },
    );
    expect(outcome.kind).toBe('quarantined');
    if (outcome.kind === 'quarantined') {
      expect(outcome.attempts).toBe(3);
      expect(outcome.reason).toMatch(/vacuous|reference to the controller/i);
    }
  });

  // V1.9.9 condition (d) — a static-lane-GREEN test that imports qunit-2 is
  // NEVER accepted: `@sapui5/types` declares the module so tsc passes, but the
  // import double-defines QUnit at runtime and kills the whole suite. The real
  // shape gate rejects every attempt, its reason reaches the refinement prompt
  // as feedback, and after 3 attempts the file quarantines. Revert the
  // `importsQunit2` clause in checkTsTestShape → the test is accepted as
  // `generated` → RED.
  test('shape gate: a qunit-2-importing .qunit.ts (verify ok) is rejected → quarantined, feedback names the import', async () => {
    const controllerId = 'ns/controller/App.controller';
    const target = join(root, 'webapp', 'test', 'unit', 'App.controller.qunit.ts');
    // Otherwise perfectly shaped — the forbidden import is the ONLY defect.
    const importing = [
      'import QUnit from "sap/ui/thirdparty/qunit-2";',
      `import App from "${controllerId}";`,
      'QUnit.test("constructs", function (assert) {',
      '  assert.ok(new App(), "controller constructs");',
      '});',
      '',
    ].join('\n');
    const feedbackSeen: string[] = [];
    const runner = new FakeClaudeRunner([
      { match: /./, response: { raw: JSON.stringify({ newFileContent: importing }) } },
    ]);
    const outcome = await generateAndVerify(
      {
        initialPrompt: 'Generate App.controller test',
        buildRefinementPrompt: ({ verifyFeedback }) => {
          feedbackSeen.push(verifyFeedback);
          return 'refine please';
        },
        targetTestFileAbs: target,
        shapeCheck: (content) => checkTsTestShape(content, controllerId),
      },
      {
        projectRoot: root,
        runner,
        budget: new CallBudget({ maxCalls: 10 }),
        eslintEnabled: false,
        projectLanguage: 'ts',
        tscEnabled: true,
        // The static lane PASSES — only the shape gate stands between the
        // double-define and an accepted test.
        verifyFn: async () => passing(),
      },
    );
    expect(outcome.kind).toBe('quarantined');
    if (outcome.kind === 'quarantined') {
      expect(outcome.attempts).toBe(3);
      expect(outcome.reason).toContain('sap/ui/thirdparty/qunit-2');
    }
    // Attempts 2 and 3 were steered by the shape reason, not a generic error.
    expect(feedbackSeen).toHaveLength(2);
    for (const fb of feedbackSeen) {
      expect(fb).toContain('sap/ui/thirdparty/qunit-2');
      expect(fb).toMatch(/QUnit global directly/i);
    }
  });

  // The positive half: a shaped test (imports the controller id, has a
  // QUnit.test + assertion) IS accepted on the first attempt.
  test('shape gate: a well-formed .qunit.ts (verify ok) is accepted → generated', async () => {
    const controllerId = 'ns/controller/App.controller';
    const target = join(root, 'webapp', 'test', 'unit', 'App.controller.qunit.ts');
    const good = [
      `import App from "${controllerId}";`,
      'QUnit.module("App");',
      'QUnit.test("loads", function (assert) { assert.ok(new App()); });',
      '',
    ].join('\n');
    const runner = new FakeClaudeRunner([
      { match: /./, response: { raw: JSON.stringify({ newFileContent: good }) } },
    ]);
    const outcome = await generateAndVerify(
      {
        initialPrompt: 'Generate App.controller test',
        buildRefinementPrompt: () => 'refine please',
        targetTestFileAbs: target,
        shapeCheck: (content) => checkTsTestShape(content, controllerId),
      },
      {
        projectRoot: root,
        runner,
        budget: new CallBudget({ maxCalls: 10 }),
        eslintEnabled: false,
        projectLanguage: 'ts',
        tscEnabled: true,
        verifyFn: async () => passing(),
      },
    );
    expect(outcome.kind).toBe('generated');
    if (outcome.kind === 'generated') expect(outcome.attempts).toBe(1);
  });

  // TG-ACCEPT (tsc half) — a type-broken generated test is rejected BY THE TSC
  // STEP of the real static lane (not accepted), and karma is never invoked.
  // Mirrors the firewall guard but with a failing tsc adapter.
  test('type-broken .qunit.ts: the real static lane fails on tsc → quarantined, karma == 0', async () => {
    const target = join(root, 'webapp', 'test', 'unit', 'App.controller.qunit.ts');
    const runner = new FakeClaudeRunner([
      { match: /./, response: { raw: JSON.stringify({ newFileContent: '// type-broken\n' }) } },
    ]);
    const karmaCalls: KarmaRunArgs[] = [];
    const adapters: VerifyAdapters = {
      ui5lint: async () => ({ ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1 }),
      tsc: async () => ({
        ok: false,
        stdout: "webapp/test/unit/App.controller.qunit.ts(3,1): error TS2322: Type 'number' is not assignable to type 'string'.",
        stderr: '',
        exitCode: 2,
        durationMs: 1,
      }),
      eslint: async () => ({ ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1 }),
      karma: async (args) => {
        karmaCalls.push(args);
        return { ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1, testFiles: [] };
      },
    };
    const outcome = await generateAndVerify(
      {
        initialPrompt: 'Generate App.controller test',
        buildRefinementPrompt: () => 'refine please',
        targetTestFileAbs: target,
      },
      {
        projectRoot: root,
        runner,
        budget: new CallBudget({ maxCalls: 10 }),
        eslintEnabled: true,
        projectLanguage: 'ts',
        tscEnabled: true,
        verifyFn: async (input) => verifyArtifact({ ...input, adapters }),
      },
    );
    expect(outcome.kind).toBe('quarantined');
    if (outcome.kind === 'quarantined') {
      expect(outcome.reason).toMatch(/tsc|TS2322/i);
      expect(outcome.quarantinedAtRel).toBe(
        'webapp/test/_failing/App.controller.failing.qunit.ts',
      );
    }
    // The never-build firewall: a type-broken TS test never reaches karma.
    expect(karmaCalls).toHaveLength(0);
  });
});
