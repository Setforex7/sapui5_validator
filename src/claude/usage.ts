/**
 * V1.9.4 PERF-1 — run-level LLM cost/token observability.
 *
 * The `claude -p --output-format json` envelope carries `usage`/`total_cost_usd`
 * per call; {@link BinaryRunner} surfaces them on each {@link ClaudeRunResult}
 * (see `binary-runner.ts`). {@link RunUsageAccumulator} is the single sink that
 * sums those per-call numbers across a run — fed from the {@link AuditingRunner}
 * decorator, which sees every successful call — and emits the additive-optional
 * {@link RunReport} fields. {@link formatUsageSummaryLine} renders the one
 * presence-gated CLI summary line `finish()` prints.
 *
 * Honesty contract (diagnosis §6/§7): TOKEN COUNTS ARE PRIMARY; cost is a
 * labelled estimate (the envelope's `total_cost_usd` is "not for billing" and
 * may be null under Max). A field that no call reported stays ABSENT — never a
 * zero placeholder, never a printed `null`/`undefined`.
 */

import type { ClaudeRunResult } from './runner.js';
import type { RunReport, RunUsageTotals } from '../types.js';

/** The additive-optional {@link RunReport} fields this module populates. */
type UsageReportFields = Pick<RunReport, 'usage' | 'totalCostUsd'>;

export class RunUsageAccumulator {
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheReadTokens = 0;
  private cacheCreationTokens = 0;
  private costUsd = 0;
  private sawUsage = false;
  private sawCost = false;

  /**
   * Fold one call's result into the running totals. Calls that carried no
   * `usage` / `totalCostUsd` (a bare envelope, or any non-success path that
   * never produced a {@link ClaudeRunResult}) contribute nothing and leave the
   * corresponding presence flag untouched.
   */
  add(result: ClaudeRunResult): void {
    if (result.usage !== undefined) {
      this.sawUsage = true;
      this.inputTokens += result.usage.inputTokens;
      this.outputTokens += result.usage.outputTokens;
      this.cacheReadTokens += result.usage.cacheReadTokens;
      this.cacheCreationTokens += result.usage.cacheCreationTokens;
    }
    if (result.totalCostUsd !== undefined) {
      this.sawCost = true;
      this.costUsd += result.totalCostUsd;
    }
  }

  /**
   * The additive-optional report fields. `usage` is present iff at least one
   * call reported a token block; `totalCostUsd` iff at least one reported a
   * numeric cost — the two are independent (a call can report tokens but a null
   * cost). Returns `{}` for an LLM-free run, so spreading it into the report
   * leaves both fields absent (`schemaVersion` stays `2`).
   */
  toReportFields(): UsageReportFields {
    const usage: RunUsageTotals = {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cacheReadTokens: this.cacheReadTokens,
      cacheCreationTokens: this.cacheCreationTokens,
    };
    return {
      ...(this.sawUsage ? { usage } : {}),
      ...(this.sawCost ? { totalCostUsd: this.costUsd } : {}),
    };
  }
}

/**
 * The one human-facing cost/token summary line, or `undefined` when the run
 * recorded no usage (so the caller prints nothing). Token counts lead; the cost
 * tail is appended only when a numeric cost was recorded and is explicitly
 * labelled an estimate. Every interpolated value is a real number — an absent
 * field omits its segment rather than rendering `null`/`undefined`.
 */
export function formatUsageSummaryLine(
  report: Pick<RunReport, 'usage' | 'totalCostUsd' | 'llmCallCount'>,
): string | undefined {
  const { usage } = report;
  if (usage === undefined) return undefined;
  const tokens =
    `${usage.inputTokens} in | ${usage.outputTokens} out | ` +
    `${usage.cacheReadTokens} cache-read | ${usage.cacheCreationTokens} cache-write tokens`;
  const head = `LLM usage (${report.llmCallCount} calls): ${tokens}`;
  return report.totalCostUsd !== undefined
    ? `${head} | est. cost ~$${report.totalCostUsd.toFixed(4)}`
    : head;
}
