/**
 * V1.9.4 PERF-1 — RunUsageAccumulator + formatUsageSummaryLine
 * (src/claude/usage.ts).
 *
 * Fail-on-revert coverage for the run-level cost/token observability: the
 * accumulator SUMS all four token sub-fields across calls (diagnosis §6 — the
 * total billed input is input + cache_read + cache_creation), gates the report
 * fields on presence (an LLM-free or cost-null run leaves them ABSENT, never a
 * zero placeholder), and the formatter never renders a `null`/`undefined`
 * segment and labels cost an estimate.
 */

import { describe, expect, test } from 'vitest';
import {
  RunUsageAccumulator,
  formatUsageSummaryLine,
} from '../../src/claude/usage.js';
import type { ClaudeRunResult, ClaudeUsage } from '../../src/claude/runner.js';

function result(partial: Partial<ClaudeRunResult>): ClaudeRunResult {
  return {
    ok: true,
    json: {},
    raw: '',
    stderr: '',
    exitCode: 0,
    durationMs: 0,
    callId: 'cid',
    ...partial,
  };
}

const USAGE_A: ClaudeUsage = {
  inputTokens: 6,
  outputTokens: 20,
  cacheReadTokens: 19086,
  cacheCreationTokens: 9601,
};
const USAGE_B: ClaudeUsage = {
  inputTokens: 4,
  outputTokens: 5,
  cacheReadTokens: 1000,
  cacheCreationTokens: 2000,
};

describe('RunUsageAccumulator', () => {
  test('sums all four token sub-fields and the cost across calls', () => {
    const acc = new RunUsageAccumulator();
    acc.add(result({ usage: USAGE_A, totalCostUsd: 0.07 }));
    acc.add(result({ usage: USAGE_B, totalCostUsd: 0.03 }));

    const fields = acc.toReportFields();
    expect(fields.usage).toEqual({
      inputTokens: 10,
      outputTokens: 25,
      cacheReadTokens: 20086,
      cacheCreationTokens: 11601,
    });
    expect(fields.totalCostUsd).toBeCloseTo(0.1, 8);
  });

  test('an LLM-free run leaves both fields ABSENT (additive — no zero placeholder)', () => {
    const acc = new RunUsageAccumulator();
    // A bare success and an error-shaped result that never carried usage.
    acc.add(result({}));
    const fields = acc.toReportFields();
    expect(fields.usage).toBeUndefined();
    expect(fields.totalCostUsd).toBeUndefined();
    expect(Object.keys(fields)).toHaveLength(0);
  });

  test('usage present but cost null/absent → tokens summed, cost ABSENT (R1)', () => {
    const acc = new RunUsageAccumulator();
    acc.add(result({ usage: USAGE_A })); // no totalCostUsd (e.g. null under Max)
    acc.add(result({ usage: USAGE_B }));

    const fields = acc.toReportFields();
    expect(fields.usage).toEqual({
      inputTokens: 10,
      outputTokens: 25,
      cacheReadTokens: 20086,
      cacheCreationTokens: 11601,
    });
    expect(fields.totalCostUsd).toBeUndefined();
  });

  test('cost present on only some calls is still recorded (independent of usage presence)', () => {
    const acc = new RunUsageAccumulator();
    acc.add(result({ totalCostUsd: 0.02 })); // cost but no usage block
    acc.add(result({ usage: USAGE_B, totalCostUsd: 0.01 }));

    const fields = acc.toReportFields();
    expect(fields.totalCostUsd).toBeCloseTo(0.03, 8);
    expect(fields.usage).toEqual(USAGE_B);
  });
});

describe('formatUsageSummaryLine', () => {
  test('returns undefined when no usage was recorded (caller prints nothing)', () => {
    expect(formatUsageSummaryLine({ llmCallCount: 0 })).toBeUndefined();
    expect(
      formatUsageSummaryLine({ llmCallCount: 3, totalCostUsd: 0.03 }),
    ).toBeUndefined();
  });

  test('renders token counts first, then a labelled cost estimate', () => {
    const line = formatUsageSummaryLine({
      llmCallCount: 36,
      usage: USAGE_A,
      totalCostUsd: 0.07007925,
    });
    expect(line).toBe(
      'LLM usage (36 calls): 6 in | 20 out | 19086 cache-read | 9601 cache-write tokens | est. cost ~$0.0701',
    );
  });

  test('omits the cost segment when no cost was recorded — never prints null/undefined', () => {
    const line = formatUsageSummaryLine({ llmCallCount: 2, usage: USAGE_B });
    expect(line).toBe(
      'LLM usage (2 calls): 4 in | 5 out | 1000 cache-read | 2000 cache-write tokens',
    );
    expect(line).not.toMatch(/null|undefined|\$NaN/i);
  });
});
