/**
 * V1.9.8 — unit coverage for the cross-run detection result cache
 * (`src/checks/cache.ts`): key sensitivity (every CA-2 component alters the
 * key), zod-to-MISS on corrupt/tampered stores (never a crash — entries live
 * inside the scanned project and are untrusted input), LRU eviction, the
 * `--force` read-bypass, the persist/reload roundtrip, and (Phase 2) the
 * serve-time `cached: true` marker + `sourceRun` attribution + hit records.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  CACHE_FILE,
  DetectionCache,
  MAX_CACHE_ENTRIES,
  computeCacheKey,
  type CacheKeyInput,
} from '../../src/checks/cache.js';
import type { Finding } from '../../src/types.js';

const BASE_KEY_INPUT: CacheKeyInput = {
  promptVersion: 1,
  checkIds: ['no-direct-dom', 'no-sync-odata'],
  model: 'default',
  claudeVersion: '2.1.207 (Claude Code)',
  prompt: 'Batched static analysis: …\nFile: webapp/controller/A.controller.js\n<content>',
};

const FILE_REL = 'webapp/controller/A.controller.js';

const ADVISORY: Finding = {
  checkId: 'missing-test-coverage',
  file: FILE_REL,
  line: 12,
  message: 'method x uncovered',
  source: 'check',
  proposedFix: null,
  explanation: 'a test must be created',
};

const FIXABLE: Finding = {
  checkId: 'no-direct-dom',
  file: FILE_REL,
  message: 'direct DOM access',
  source: 'check',
  proposedFix: { newFileContent: 'rewritten' },
};

/** What a serve returns: the stored finding + the serve-time marker. */
const served = (f: Finding): Finding => ({ ...f, cached: true });

describe('computeCacheKey — every CA-2 component participates', () => {
  test('same input ⇒ same key; each component change ⇒ different key', () => {
    const base = computeCacheKey(BASE_KEY_INPUT);
    expect(computeCacheKey({ ...BASE_KEY_INPUT })).toBe(base);
    expect(computeCacheKey({ ...BASE_KEY_INPUT, promptVersion: 2 })).not.toBe(base);
    expect(
      computeCacheKey({ ...BASE_KEY_INPUT, checkIds: ['no-direct-dom'] }),
    ).not.toBe(base);
    expect(computeCacheKey({ ...BASE_KEY_INPUT, model: 'haiku' })).not.toBe(base);
    expect(
      computeCacheKey({ ...BASE_KEY_INPUT, claudeVersion: '2.1.199 (Claude Code)' }),
    ).not.toBe(base);
    expect(computeCacheKey({ ...BASE_KEY_INPUT, prompt: 'x' })).not.toBe(base);
  });

  test('a one-byte prompt difference (e.g. CRLF flip) is a different key — a legitimate MISS', () => {
    const lf = computeCacheKey({ ...BASE_KEY_INPUT, prompt: 'line1\nline2' });
    const crlf = computeCacheKey({ ...BASE_KEY_INPUT, prompt: 'line1\r\nline2' });
    expect(crlf).not.toBe(lf);
  });
});

describe('DetectionCache — store behaviour', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sapui5-cache-unit-'));
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(root, { recursive: true, force: true });
  });

  const cacheFileAbs = (): string => join(root, '.sapui5-validator', 'cache', CACHE_FILE);
  const load = (
    opts: { readEnabled?: boolean; runId?: string; maxEntries?: number } = {},
  ): DetectionCache =>
    DetectionCache.load(root, {
      readEnabled: opts.readEnabled ?? true,
      runId: opts.runId ?? 'run-A',
      ...(opts.maxEntries !== undefined ? { maxEntries: opts.maxEntries } : {}),
    });

  test('missing store ⇒ empty (all lookups MISS, counted; no servedRunIds)', () => {
    const cache = load();
    expect(cache.get('k', FILE_REL)).toBeUndefined();
    expect(cache.counters()).toEqual({ hits: 0, misses: 1 });
    expect(cache.hitRecords()).toEqual([]);
  });

  test('put → persist → reload roundtrips both Finding arms; a serve stamps cached:true + sourceRun accounting', async () => {
    const cache = load({ runId: 'run-A' });
    cache.put('k1', [ADVISORY, FIXABLE]);
    await cache.persist();

    const reloaded = load({ runId: 'run-B' });
    const result = reloaded.get('k1', FILE_REL);
    // Served findings = stored findings + the SERVE-TIME marker (never stored:
    // the populating run's own report carries no marker).
    expect(result).toEqual([served(ADVISORY), served(FIXABLE)]);
    expect(reloaded.counters()).toEqual({
      hits: 1,
      misses: 0,
      servedRunIds: ['run-A'],
    });
    expect(reloaded.hitRecords()).toEqual([
      { key: 'k1', file: FILE_REL, sourceRun: 'run-A' },
    ]);
  });

  test('the marker is never persisted: the stored entry stays cached-free after a serving run persists', async () => {
    const populate = load({ runId: 'run-A' });
    populate.put('k1', [ADVISORY]);
    await populate.persist();

    const serving = load({ runId: 'run-B' });
    expect(serving.get('k1', FILE_REL)).toEqual([served(ADVISORY)]);
    await serving.persist(); // persists the touched entry back

    const raw = JSON.parse(readFileSync(cacheFileAbs(), 'utf8')) as {
      entries: { findings: Record<string, unknown>[]; sourceRun: string }[];
    };
    expect(raw.entries).toHaveLength(1);
    expect(raw.entries[0]?.findings[0]?.['cached']).toBeUndefined();
    expect(raw.entries[0]?.sourceRun).toBe('run-A'); // still attributed to its producer
    // …and a third run can still serve it (the strict schema accepted it).
    const third = load({ runId: 'run-C' });
    expect(third.get('k1', FILE_REL)).toEqual([served(ADVISORY)]);
  });

  test('corrupt store file ⇒ empty load, never a crash', async () => {
    mkdirSync(join(root, '.sapui5-validator', 'cache'), { recursive: true });
    writeFileSync(cacheFileAbs(), '{definitely not json', 'utf8');
    const cache = load();
    expect(cache.get('k1', FILE_REL)).toBeUndefined();
  });

  test('tampered single entry is dropped alone; sibling entries still serve', async () => {
    const cache = load({ runId: 'run-A' });
    cache.put('good', [ADVISORY]);
    cache.put('bad', [FIXABLE]);
    await cache.persist();

    const parsed = JSON.parse(readFileSync(cacheFileAbs(), 'utf8')) as {
      entries: { key: string; findings: unknown[] }[];
    };
    const bad = parsed.entries.find((e) => e.key === 'bad');
    expect(bad).toBeDefined();
    bad!.findings = [
      { checkId: 'evil-unknown', file: 'x', message: 'x', source: 'check', proposedFix: null },
    ];
    writeFileSync(cacheFileAbs(), JSON.stringify(parsed), 'utf8');

    const reloaded = load({ runId: 'run-B' });
    expect(reloaded.get('good', FILE_REL)).toEqual([served(ADVISORY)]);
    expect(reloaded.get('bad', FILE_REL)).toBeUndefined();
    expect(reloaded.counters()).toEqual({
      hits: 1,
      misses: 1,
      servedRunIds: ['run-A'],
    });
  });

  test('a smuggled `cached` key on a STORED finding fails the strict schema ⇒ MISS', async () => {
    const cache = load({ runId: 'run-A' });
    cache.put('k1', [ADVISORY]);
    await cache.persist();

    const parsed = JSON.parse(readFileSync(cacheFileAbs(), 'utf8')) as {
      entries: { findings: Record<string, unknown>[] }[];
    };
    parsed.entries[0]!.findings[0]!['cached'] = true;
    writeFileSync(cacheFileAbs(), JSON.stringify(parsed), 'utf8');

    const reloaded = load({ runId: 'run-B' });
    expect(reloaded.get('k1', FILE_REL)).toBeUndefined();
  });

  test('an unknown top-level schemaVersion ⇒ empty load (forward-compat fails closed)', async () => {
    mkdirSync(join(root, '.sapui5-validator', 'cache'), { recursive: true });
    writeFileSync(
      cacheFileAbs(),
      JSON.stringify({ schemaVersion: 99, entries: [] }),
      'utf8',
    );
    const cache = load();
    expect(cache.get('k', FILE_REL)).toBeUndefined();
  });

  test('readEnabled=false (--force): reads bypassed, writes still land', async () => {
    const populate = load({ runId: 'run-A' });
    populate.put('k1', [ADVISORY]);
    await populate.persist();

    const forced = load({ readEnabled: false, runId: 'run-B' });
    expect(forced.get('k1', FILE_REL)).toBeUndefined(); // bypassed ⇒ MISS
    forced.put('k2', [FIXABLE]);
    await forced.persist();
    expect(forced.counters()).toEqual({ hits: 0, misses: 1 });
    expect(forced.hitRecords()).toEqual([]);

    const after = load({ runId: 'run-C' });
    expect(after.get('k1', FILE_REL)).toEqual([served(ADVISORY)]); // prior entries kept…
    expect(after.get('k2', FILE_REL)).toEqual([served(FIXABLE)]); // …fresh ones written
    // Each serve is attributed to the run that PRODUCED the entry.
    expect(after.counters()).toEqual({
      hits: 2,
      misses: 0,
      servedRunIds: ['run-A', 'run-B'],
    });
  });

  test('a batch containing a non-check finding is never stored (belt-and-braces)', () => {
    const cache = load();
    const baseline: Finding = {
      checkId: 'baseline-eslint',
      file: 'x',
      message: 'pre-existing',
      source: 'baseline',
      proposedFix: null,
      explanation: 'n/a',
    };
    cache.put('k1', [ADVISORY, baseline]);
    expect(cache.get('k1', FILE_REL)).toBeUndefined();
  });

  test('LRU eviction at persist: least-recently-used entries beyond the cap are dropped', async () => {
    vi.useFakeTimers({ now: new Date('2026-07-12T00:00:00Z') });
    const cache = load({ maxEntries: 2 });
    cache.put('oldest', [ADVISORY]);
    vi.advanceTimersByTime(1000);
    cache.put('middle', [ADVISORY]);
    vi.advanceTimersByTime(1000);
    cache.put('newest', [ADVISORY]);
    vi.advanceTimersByTime(1000);
    // Touch `oldest` so `middle` becomes the LRU victim.
    expect(cache.get('oldest', FILE_REL)).toBeDefined();
    await cache.persist();

    const reloaded = load({ maxEntries: 2, runId: 'run-B' });
    expect(reloaded.get('oldest', FILE_REL)).toBeDefined();
    expect(reloaded.get('newest', FILE_REL)).toBeDefined();
    expect(reloaded.get('middle', FILE_REL)).toBeUndefined();
  });

  test('default LRU cap is the documented constant', () => {
    expect(MAX_CACHE_ENTRIES).toBe(256);
  });
});
