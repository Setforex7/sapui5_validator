/**
 * V1.9.8 Phase 2 — the D1-class honesty guard (the primary exit-audit focus):
 * a report that carries per-finding `cached: true` markers WITHOUT the
 * run-level `cache` counters is an overstatement-shaped inconsistency (the
 * exact V1.9.3-D1 trap: a marker claiming something the run-level accounting
 * does not back). `writeReport` — the single choke point both commands write
 * through — must REFUSE to write it.
 *
 * Written RED-FIRST: on the pre-guard tree `writeReport` happily serialises
 * the inconsistent report, so the throw-assertion below fails.
 */

import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createEmptyReport, writeReport } from '../../src/output/report.js';
import type { Finding, RunReport } from '../../src/types.js';

const CACHED_FINDING: Finding = {
  checkId: 'no-direct-dom',
  file: 'webapp/controller/A.controller.js',
  message: 'direct DOM access',
  source: 'check',
  proposedFix: null,
  explanation: 'advisory',
  cached: true,
};

const LIVE_FINDING: Finding = {
  checkId: 'no-direct-dom',
  file: 'webapp/controller/A.controller.js',
  message: 'direct DOM access',
  source: 'check',
  proposedFix: null,
  explanation: 'advisory',
};

function reportWith(args: {
  findings: readonly Finding[];
  cache?: { hits: number; misses: number };
}): RunReport {
  const report = createEmptyReport('validate', new Date(), 10);
  return {
    ...report,
    files: [
      {
        file: 'webapp/controller/A.controller.js',
        findings: [...args.findings],
        appliedFixes: [],
        revertedFixes: [],
      },
    ],
    ...(args.cache !== undefined ? { cache: args.cache } : {}),
  };
}

describe('writeReport — cached-marker/counter honesty guard (V1.9.8 Phase 2, D1 class)', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sapui5-report-honesty-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('REFUSES a report with cached findings but no run-level cache counters', async () => {
    const report = reportWith({ findings: [CACHED_FINDING] });
    await expect(writeReport(root, report)).rejects.toThrow(/cache/i);
    expect(existsSync(join(root, '.sapui5-validator', 'report.json'))).toBe(false);
  });

  test('accepts cached findings WITH the run-level counters (marker and counter move together)', async () => {
    const report = reportWith({
      findings: [CACHED_FINDING],
      cache: { hits: 1, misses: 0 },
    });
    await expect(writeReport(root, report)).resolves.toBeDefined();
  });

  test('accepts counters with no markers (a warm run that missed everywhere)', async () => {
    const report = reportWith({
      findings: [LIVE_FINDING],
      cache: { hits: 0, misses: 1 },
    });
    await expect(writeReport(root, report)).resolves.toBeDefined();
  });

  test('accepts a legacy cache-free report (no markers, no counters)', async () => {
    const report = reportWith({ findings: [LIVE_FINDING] });
    await expect(writeReport(root, report)).resolves.toBeDefined();
  });
});
