/**
 * V1.9 / V1.9.2 — TS-V1-FW, the never-build firewall on the TS path.
 *
 * History: in Phase 0/1 this file asserted a TS project REFUSED end-to-end. V1.9
 * flipped `validate` to PROCEED static-only; V1.9.2 (TG-GUARD-LIFT) flips
 * `generate` the same way. Both commands now:
 *
 *   - PROCEED through TS-aware discovery + the static-only verify lane (and
 *     `validate` reports `verification: 'static-only'`) — but must STILL never
 *     reach `runKarma` (karma-running a `.ts` would transpile it via the
 *     project's `babel.config.js` = arbitrary code execution, the `TS-V1`
 *     boundary). The load-bearing firewall witness: a TS run's karma adapter
 *     call count is ZERO; the SAME orchestrator on a JS project DOES call karma.
 *     Re-introducing a karma call on the TS path (un-gating the baseline probe
 *     or the post-fix suite) turns the `karma === 0` assertion RED.
 *
 * Fixtures are copied to a tmpdir per the repo's fixture-pollution rule.
 */

import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { runValidate } from '../../src/commands/validate.js';
import { runGenerate } from '../../src/commands/generate.js';
import { FakeClaudeRunner } from '../../src/claude/fake-runner.js';
import type { ProbeAdapter } from '../../src/project/tooling.js';
import type { VerifyAdapters } from '../../src/verify/pipeline.js';

const FIX_ROOT = join(process.cwd(), 'test', 'fixtures');

const ALL_TOOLS_OK: ProbeAdapter = {
  probe: () => ({ present: true, version: '1.0.0', source: 'node_modules' }),
};

/** A runner that answers every check prompt "clean" — no findings, no fixes. */
function cleanRunner(): FakeClaudeRunner {
  return new FakeClaudeRunner([{ match: () => true, response: { raw: '{"findings":[]}' } }]);
}

interface AdapterProbe {
  readonly adapters: VerifyAdapters;
  readonly counts: { ui5lint: number; eslint: number; karma: number; tsc: number };
}
function countingAdapters(): AdapterProbe {
  const counts = { ui5lint: 0, eslint: 0, karma: 0, tsc: 0 };
  const adapters: VerifyAdapters = {
    ui5lint: async () => {
      counts.ui5lint++;
      return { ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1 };
    },
    eslint: async () => {
      counts.eslint++;
      return { ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1 };
    },
    karma: async () => {
      counts.karma++;
      return { ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1, testFiles: [] };
    },
    tsc: async () => {
      counts.tsc++;
      return { ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1 };
    },
  };
  return { adapters, counts };
}

function copyFixture(fixture: string): string {
  const root = mkdtempSync(join(tmpdir(), 'sapui5-ts-fw-'));
  cpSync(join(FIX_ROOT, fixture), root, { recursive: true });
  return root;
}

describe('TS-V1-FW — a TS validate run proceeds static-only and NEVER reaches karma', () => {
  let root: string;
  beforeEach(() => {
    root = copyFixture('ts-helloworld');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('validate PROCEEDS (static lane), reports lint-only (no project tsc), and karma call count is ZERO', async () => {
    const { adapters, counts } = countingAdapters();

    const result = await runValidate({
      projectRoot: root,
      all: true,
      force: true,
      runner: cleanRunner(),
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adapters,
    });

    // It PROCEEDED — not the Phase-0 refusal.
    expect(result.report.exitReason.kind).not.toBe('typescript-project');
    // V1.9.3 D1 — the marker reads the honest verification depth. The copied
    // `ts-helloworld` ships NO `node_modules/typescript`, so `tscEnabled=false`:
    // `tsc` is skipped and the lane narrows to ui5lint → `'lint-only'`, not
    // `'static-only'` (which would falsely claim a `tsc --noEmit` type-check).
    // Reverting the D1 gate (always `'static-only'`) → RED.
    expect(result.report.verification).toBe('lint-only');
    // The lane actually ran static checks (baseline ui5lint over the .ts files).
    expect(counts.ui5lint).toBeGreaterThan(0);
    // THE FIREWALL: karma — the arbitrary-code-execution boundary — is never
    // invoked on the TS path. Neither the baseline probe nor the post-fix suite.
    expect(counts.karma).toBe(0);
    // tsc is legitimately 0 here: the copied fixture ships no
    // node_modules/typescript (so tscEnabled is false) AND the clean runner
    // yields no fixes (so the per-fix verify never runs). The non-vacuous
    // "tsc IS in the TS static lane" witness lives at the unit layer —
    // verify-pipeline-ts.test.ts asserts calls.tsc length 1 and failedStep
    // 'tsc'. This assertion documents the expected 0 so a future change that
    // wired tsc into the baseline (where it is intentionally absent) is caught.
    expect(counts.tsc).toBe(0);
  });
});

describe('the JS path still DOES run karma (the firewall is TS-specific)', () => {
  let root: string;
  beforeEach(() => {
    root = copyFixture('minimal-project');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('a JS validate run with qunit tests in scope invokes the karma adapter', async () => {
    const { adapters, counts } = countingAdapters();

    const result = await runValidate({
      projectRoot: root,
      all: true,
      force: true,
      runner: cleanRunner(),
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adapters,
    });

    expect(result.report.verification).toBeUndefined(); // no static-only marker on JS
    // The baseline karma probe runs (the JS project ships qunit tests). If this
    // is 0, the comparison is vacuous — so it pins the firewall as TS-specific.
    expect(counts.karma).toBeGreaterThan(0);
  });
});

describe('generate on a TS project PROCEEDS static-only and NEVER reaches karma (V1.9.2)', () => {
  let root: string;
  beforeEach(() => {
    root = copyFixture('ts-helloworld');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('proceeds past the TS guard; the baseline karma probe is gated off (karma == 0)', async () => {
    const { adapters, counts } = countingAdapters();

    const result = await runGenerate({
      projectRoot: root,
      all: true,
      force: true,
      runner: new FakeClaudeRunner([]),
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adapters,
    });

    // It PROCEEDED — not the pre-V1.9.2 `typescript-project` refusal.
    expect(result.report.exitReason.kind).not.toBe('typescript-project');
    // The baseline lint phase actually ran over the `.ts` sources, so the run
    // reached the point where the karma probe would otherwise fire — that makes
    // the `karma === 0` assertion below non-vacuous.
    expect(counts.ui5lint).toBeGreaterThan(0);
    // THE FIREWALL: the unconditional whole-suite karma baseline probe is gated
    // OFF for TS (TG-FW-BASELINE). Un-gating `karmaProbe` on the TS path turns
    // this RED. The verify-step karma==0 twin (an uncovered TS controller that
    // reaches the verify lane) lives in `generate.test.ts` (Test A).
    expect(counts.karma).toBe(0);
  });
});
