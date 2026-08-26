/**
 * V1.9.8 — cross-run content-hash result cache for batched DETECTION calls
 * only (`validate --cache`). A HIT serves the findings a previous run's
 * identical batch prompt produced, skipping the LLM call entirely: no budget
 * consumed, no per-category cap increment, no audit transcript fabricated
 * (the short-circuit sits ABOVE `ctx.runner.run(...)`).
 *
 * What is NEVER cached (plan Do-not-touch / diagnosis CA-3): fix refinement,
 * generation, verification/acceptance, the deterministic checks (baseline
 * lint, unpreloaded-libs, project graph, sinon dialect, test layout — always
 * recomputed), and error findings (malformed/api-error/process-killed are
 * transport failures, not detection results — only a successfully parsed
 * findings envelope is stored).
 *
 * Key (diagnosis CA-2 + the cycle's invariant 1): sha256 over the FULLY
 * ASSEMBLED prompt string — which subsumes the primary file bytes, the paired
 * test/controller content and the coverage flag (Phase 0 proved a controller
 * edit must MISS the paired view too) — plus `PROMPT_VERSION` (the builder
 * ratchet in `batch.ts`), the batch check-id set, the run's `model` (literal
 * `"default"` when the binary picks) and `claudeVersion`. Bytes are hashed as
 * read: a CRLF flip on a Windows checkout is a legitimate MISS, not worked
 * around.
 *
 * Trust boundary: entries live INSIDE the scanned project
 * (`.sapui5-validator/cache/`), so the store is untrusted on-disk input —
 * every entry is zod-validated on read and anything corrupt, invalid or
 * tampered degrades to a MISS (never a crash, never served). Writes go
 * through `assertInsideProject()` like every other project write.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { CHECK_IDS, type CheckId, type Finding } from '../types.js';
import { assertInsideProject } from '../util/containment.js';
import { cacheDir } from '../util/paths.js';

export const CACHE_FILE = 'detection-cache.json';

/**
 * LRU size cap — evicts least-recently-used entries beyond this count at
 * persist time. The batch phase produces one entry per controller/view target
 * (a real project: ~17), so 256 is generous headroom for content churn
 * without letting the per-project store grow unbounded.
 */
export const MAX_CACHE_ENTRIES = 256;

const CACHE_SCHEMA_VERSION = 1;

const cachedFindingBase = {
  checkId: z.enum(CHECK_IDS),
  file: z.string(),
  line: z.number().int().optional(),
  message: z.string(),
  source: z.literal('check'),
} as const;

/**
 * The persisted-finding schema — the normalized `Finding` discriminated union
 * (`proposedFix: null` requires `explanation`; a fix proposal carries none) as
 * it crosses back IN from disk. Deliberately strict: `checkId` must be a
 * known id, `source` must be `'check'` (only detection findings are ever
 * stored), and `.strict()` rejects smuggled extra fields.
 */
const cachedFindingSchema = z.union([
  z
    .object({
      ...cachedFindingBase,
      proposedFix: z.object({ newFileContent: z.string() }).strict(),
    })
    .strict(),
  z
    .object({
      ...cachedFindingBase,
      proposedFix: z.null(),
      explanation: z.string(),
    })
    .strict(),
]);

type CachedFinding = z.infer<typeof cachedFindingSchema>;

const cacheEntrySchema = z
  .object({
    key: z.string().min(1),
    findings: z.array(cachedFindingSchema),
    /**
     * V1.9.8 Phase 2 — the id of the run that PRODUCED this entry (its
     * `report.startedAt` ISO string; no separate run-id concept exists). A
     * serve stamps it into the hit record + `RunReport.cache.servedRunIds`
     * so a consumer can trace a served finding to the populating run's
     * report/audit trail (`runs/<timestamp>/` when --keep-history).
     */
    sourceRun: z.string(),
    createdAt: z.string(),
    lastUsedAt: z.string(),
  })
  .strict();

const cacheFileSchema = z
  .object({
    schemaVersion: z.literal(CACHE_SCHEMA_VERSION),
    // Entries validated INDIVIDUALLY at load so one tampered entry degrades to
    // one MISS instead of poisoning the whole store.
    entries: z.array(z.unknown()),
  })
  .strict();

type CacheEntry = z.infer<typeof cacheEntrySchema>;

function toFinding(f: CachedFinding): Finding {
  const base = {
    checkId: f.checkId,
    file: f.file,
    message: f.message,
    source: f.source,
    ...(f.line !== undefined ? { line: f.line } : {}),
  };
  return f.proposedFix === null
    ? { ...base, proposedFix: null, explanation: f.explanation }
    : { ...base, proposedFix: { newFileContent: f.proposedFix.newFileContent } };
}

function toCached(f: Finding & { source: 'check' }): CachedFinding {
  const base = {
    checkId: f.checkId,
    file: f.file,
    message: f.message,
    source: f.source,
    ...(f.line !== undefined ? { line: f.line } : {}),
  };
  return f.proposedFix === null
    ? { ...base, proposedFix: null, explanation: f.explanation }
    : { ...base, proposedFix: { newFileContent: f.proposedFix.newFileContent } };
}

export interface CacheKeyInput {
  /** `PROMPT_VERSION` from `src/checks/batch.ts` — the builder ratchet. */
  readonly promptVersion: number;
  readonly checkIds: readonly CheckId[];
  /** The run's model, or the literal `'default'` when the binary picks. */
  readonly model: string;
  /** `claude --version`, or `'unknown'` when no availability probe ran. */
  readonly claudeVersion: string;
  /** The fully assembled batch prompt (subsumes all embedded file content). */
  readonly prompt: string;
}

/**
 * Canonical, collision-safe key: sha256 over the JSON array of components
 * (JSON framing length-separates them, so no delimiter collisions).
 */
export function computeCacheKey(input: CacheKeyInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        input.promptVersion,
        [...input.checkIds],
        input.model,
        input.claudeVersion,
        input.prompt,
      ]),
    )
    .digest('hex');
}

export interface DetectionCacheLoadOptions {
  /**
   * False on `--force` runs: reads are bypassed (every lookup is a MISS) but
   * fresh entries are still written — a forced run is a deliberate fresh
   * measurement that leaves a warm cache behind.
   */
  readonly readEnabled: boolean;
  /**
   * V1.9.8 Phase 2 — the CURRENT run's id (`report.startedAt` ISO string),
   * stamped as `sourceRun` on every entry this run writes.
   */
  readonly runId: string;
  /** Test-only override of the LRU cap. */
  readonly maxEntries?: number;
}

/**
 * V1.9.8 Phase 2 — one honest audit record per served batch: which key was
 * served for which target file, and which run produced the entry. Written by
 * the orchestrator to the audit-trail root (`cache-hits.json`) — the positive
 * companion to the structural guarantee that a HIT never fabricates a
 * prompt/response transcript.
 */
export interface CacheHitRecord {
  readonly key: string;
  readonly file: string;
  readonly sourceRun: string;
}

export class DetectionCache {
  /** Lookups served from the store (no LLM call, no budget, no cap). */
  private hitCount = 0;
  /** Lookups NOT served: dispatched live, cap-skipped, or `--force`-bypassed. */
  private missCount = 0;
  /** V1.9.8 Phase 2 — one record per served batch, for the audit trail. */
  private readonly hits: CacheHitRecord[] = [];
  /** Distinct source-run ids of served entries (→ `RunReport.cache.servedRunIds`). */
  private readonly served = new Set<string>();
  private readonly entries: Map<string, CacheEntry>;
  private readonly projectRoot: string;
  private readonly readEnabled: boolean;
  private readonly runId: string;
  private readonly maxEntries: number;

  private constructor(
    projectRoot: string,
    entries: Map<string, CacheEntry>,
    options: DetectionCacheLoadOptions,
  ) {
    this.projectRoot = projectRoot;
    this.entries = entries;
    this.readEnabled = options.readEnabled;
    this.runId = options.runId;
    this.maxEntries = options.maxEntries ?? MAX_CACHE_ENTRIES;
  }

  /**
   * SYNCHRONOUS load (invariant 3): the whole store is read into memory at
   * run start so a HIT/MISS decision inserts no `await` into the
   * cap-check → consume → record prelude of `callLlmForFindingsBatch`.
   * Missing file, unreadable file, corrupt JSON, wrong schema version: empty
   * store (MISS-all). A tampered INDIVIDUAL entry is dropped alone.
   */
  static load(projectRoot: string, options: DetectionCacheLoadOptions): DetectionCache {
    const entries = new Map<string, CacheEntry>();
    try {
      const raw = readFileSync(join(cacheDir(projectRoot), CACHE_FILE), 'utf8');
      const file = cacheFileSchema.safeParse(JSON.parse(raw));
      if (file.success) {
        for (const candidate of file.data.entries) {
          const entry = cacheEntrySchema.safeParse(candidate);
          if (entry.success) entries.set(entry.data.key, entry.data);
        }
      }
    } catch {
      // Untrusted on-disk input: any read/parse failure degrades to an empty
      // store — a cache can only ever cost a re-run, never a crash.
    }
    return new DetectionCache(projectRoot, entries, options);
  }

  /**
   * Synchronous lookup; counts every call as a hit or a miss. A served
   * finding is stamped `cached: true` AT SERVE TIME (the marker is never
   * stored, so the populating run's own report carries none — and a smuggled
   * `cached` key on a stored entry fails the strict schema ⇒ MISS). Each hit
   * also appends an honest {@link CacheHitRecord} for the audit trail.
   */
  get(key: string, file: string): readonly Finding[] | undefined {
    if (this.readEnabled) {
      const entry = this.entries.get(key);
      if (entry !== undefined) {
        this.hitCount += 1;
        entry.lastUsedAt = new Date().toISOString();
        this.hits.push({ key, file, sourceRun: entry.sourceRun });
        this.served.add(entry.sourceRun);
        return entry.findings.map((f) => ({ ...toFinding(f), cached: true as const }));
      }
    }
    this.missCount += 1;
    return undefined;
  }

  /**
   * Store a successfully parsed batch result. Serving is per-batch
   * (all-or-nothing), so a batch containing anything other than
   * `'check'`-sourced findings is not stored at all — belt-and-braces; the
   * batch path never produces other sources.
   */
  put(key: string, findings: readonly Finding[]): void {
    const storable: CachedFinding[] = [];
    for (const f of findings) {
      if (f.source !== 'check') return;
      storable.push(toCached({ ...f, source: f.source }));
    }
    const now = new Date().toISOString();
    this.entries.set(key, {
      key,
      findings: storable,
      // The producing run's id — an overwrite re-attributes the entry to the
      // run that produced the fresh result (correct: it IS that run's output).
      sourceRun: this.runId,
      createdAt: this.entries.get(key)?.createdAt ?? now,
      lastUsedAt: now,
    });
  }

  /**
   * Run-level accounting for `RunReport.cache` (invariant 4). `servedRunIds`
   * is present IFF something was served — it moves together with the
   * per-finding `cached` markers and the hit records.
   */
  counters(): { hits: number; misses: number; servedRunIds?: string[] } {
    return {
      hits: this.hitCount,
      misses: this.missCount,
      ...(this.served.size > 0 ? { servedRunIds: [...this.served].sort() } : {}),
    };
  }

  /** V1.9.8 Phase 2 — the audit-trail hit records, in serve order. */
  hitRecords(): readonly CacheHitRecord[] {
    return this.hits;
  }

  /**
   * Persist the store (LRU-capped) under `.sapui5-validator/cache/`.
   * Containment is asserted on the directory BEFORE `mkdir` (so a symlinked
   * `.sapui5-validator` cannot route the mkdir out of the tree) and on the
   * file before the write, like every other project write site.
   */
  async persist(): Promise<void> {
    const dir = cacheDir(this.projectRoot);
    const fileAbs = join(dir, CACHE_FILE);
    const sorted = [...this.entries.values()].sort((a, b) =>
      b.lastUsedAt.localeCompare(a.lastUsedAt),
    );
    const capped = sorted.slice(0, this.maxEntries);
    await assertInsideProject(dir, this.projectRoot);
    await mkdir(dir, { recursive: true });
    await assertInsideProject(fileAbs, this.projectRoot);
    await writeFile(
      fileAbs,
      JSON.stringify({ schemaVersion: CACHE_SCHEMA_VERSION, entries: capped }),
      'utf8',
    );
  }
}
