import { join } from 'node:path';

export const VALIDATOR_DIR = '.sapui5-validator';
export const REPORT_FILE = 'report.json';
export const LAST_RUN_DIR = 'last-run';
export const RUNS_DIR = 'runs';
/**
 * V1.9.8 — the cross-run detection result cache lives under
 * `.sapui5-validator/cache/` (the self-scoped `.gitignore` written by
 * `ensureSelfScopedIgnore` already covers the whole validator dir, so cache
 * entries are never committed by the scanned project).
 */
export const CACHE_DIR = 'cache';
export const FAILING_TESTS_REL_DIR = 'webapp/test/_failing';
export const FAILING_TEST_SUFFIX = '.failing.qunit.js';
/**
 * V1.9.2 (TG-QUARANTINE-TS) — the quarantine suffix for a generated TypeScript
 * test (`.qunit.ts`). A 3×-failing `.qunit.ts` moves to
 * `webapp/test/_failing/<Name>.failing.qunit.ts`; the JS suffix above is
 * unchanged. `quarantine()` (`generation/retry-loop.ts`) picks the suffix from
 * the source file extension so the JS path stays byte-identical.
 */
export const FAILING_TEST_SUFFIX_TS = '.failing.qunit.ts';

export function validatorDir(projectRoot: string): string {
  return join(projectRoot, VALIDATOR_DIR);
}

export function reportPath(projectRoot: string): string {
  return join(projectRoot, VALIDATOR_DIR, REPORT_FILE);
}

export function lastRunDir(projectRoot: string): string {
  return join(projectRoot, VALIDATOR_DIR, LAST_RUN_DIR);
}

export function cacheDir(projectRoot: string): string {
  return join(projectRoot, VALIDATOR_DIR, CACHE_DIR);
}

export function runHistoryDir(projectRoot: string, isoTimestamp: string): string {
  return join(projectRoot, VALIDATOR_DIR, RUNS_DIR, isoTimestamp);
}

export function failingTestsDir(projectRoot: string): string {
  return join(projectRoot, FAILING_TESTS_REL_DIR);
}

export function isoTimestampForDir(date: Date = new Date()): string {
  return date.toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, 'Z');
}
