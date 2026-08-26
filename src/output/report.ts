import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { RunReport } from '../types.js';
import { reportPath } from '../util/paths.js';
import { assertInsideProject } from '../util/containment.js';

/**
 * Stable JSON-shape version for `.sapui5-validator/report.json`.
 *
 * Migration history:
 *   - **v1** (initial). Findings carry `{ checkId, file, line?, message,
 *     proposedFix | explanation }`. AppliedFixRecord / RevertedFixRecord
 *     carry `{ checkId }` (+ `reason` for reverts).
 *   - **v2** (session 8 baseline-fix landing). Every Finding now carries a
 *     required `source: 'check' | 'baseline'` field distinguishing LLM-check
 *     findings from baseline (pre-existing lint/test failures) funnelled
 *     through the same SPEC §2.10 fix loop. AppliedFixRecord and
 *     RevertedFixRecord gain the same `source` field so consumers can tell
 *     which fixes resolved project debt vs. semantic findings.
 *
 * Consumers that need to read v1 reports can read the version off
 * `schemaVersion` and default missing `source` fields to `'check'`.
 */
export const REPORT_SCHEMA_VERSION = 2 as const;

export function createEmptyReport(
  command: 'validate' | 'generate',
  startedAt: Date,
  llmCallBudget: number,
): RunReport {
  const iso = startedAt.toISOString();
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    command,
    startedAt: iso,
    finishedAt: iso,
    durationMs: 0,
    llmCallCount: 0,
    llmCallBudget,
    exitReason: { kind: 'success' },
    exitCode: 0,
    files: [],
    generatedTests: [],
  };
}

export async function writeReport(projectRoot: string, report: RunReport): Promise<string> {
  // V1.9.8 Phase 2 — the D1-class honesty guard: a per-finding `cached: true`
  // marker without the run-level `RunReport.cache` counters is an
  // overstatement-shaped inconsistency (the marker claims cache serving the
  // run-level accounting does not back — the exact V1.9.3-D1 trap). Refuse to
  // write it; fail closed (the orchestrator's swallow policy then yields NO
  // report.json, never a dishonest one). The real code path cannot produce
  // this state — markers only come from a DetectionCache whose counters are
  // always stamped — so this throw firing means a wiring regression.
  const hasCachedMarker = report.files.some((f) =>
    f.findings.some((finding) => finding.cached === true),
  );
  if (hasCachedMarker && report.cache === undefined) {
    throw new Error(
      'refusing to write report.json: findings carry `cached: true` but the run-level ' +
        '`cache` counters are absent — the marker and the counter must move together ' +
        '(V1.9.8 honesty guard)',
    );
  }
  const target = reportPath(projectRoot);
  // v0.8.1 V1: `.sapui5-validator/` can be a committed link out of the tree.
  await assertInsideProject(target, projectRoot);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(report, null, 2) + '\n', 'utf8');
  return target;
}

export function serializeReport(report: RunReport): string {
  return JSON.stringify(report, null, 2);
}
