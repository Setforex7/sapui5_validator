import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CacheHitRecord } from '../checks/cache.js';
import { isoTimestampForDir, lastRunDir, runHistoryDir } from '../util/paths.js';
import { assertInsideProject } from '../util/containment.js';

export interface AuditLogOptions {
  projectRoot: string;
  keepHistory: boolean;
  startedAt?: Date;
}

// V1.9 — `'tsc'` joins the audit verify-step union (the TypeScript static lane's
// type-check step), kept in sync with `verify/pipeline.ts`'s `VerifyStep`.
export type VerifyStep = 'ui5lint' | 'eslint' | 'karma' | 'tsc';

export class AuditLog {
  readonly rootDir: string;
  private readonly projectRoot: string;
  private initialized = false;

  constructor(options: AuditLogOptions) {
    const startedAt = options.startedAt ?? new Date();
    this.projectRoot = options.projectRoot;
    this.rootDir = options.keepHistory
      ? runHistoryDir(options.projectRoot, isoTimestampForDir(startedAt))
      : lastRunDir(options.projectRoot);
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    const subdirs = ['prompts', 'responses', 'verify'].map((d) => join(this.rootDir, d));
    // v0.8.1 V1: the audit trail holds full source + LLM transcripts;
    // `.sapui5-validator/`, `last-run/` or a subdir can be a committed link
    // out of the tree. Assert each subdir BEFORE mkdir creates anything —
    // the per-call write paths below add only internal callId filenames, so
    // this init assert covers them.
    for (const dir of subdirs) {
      await assertInsideProject(dir, this.projectRoot);
    }
    await Promise.all(subdirs.map((dir) => mkdir(dir, { recursive: true })));
    this.initialized = true;
  }

  async writePrompt(callId: string, content: string): Promise<string> {
    await this.init();
    const path = join(this.rootDir, 'prompts', `${callId}.txt`);
    await writeFile(path, content, 'utf8');
    return path;
  }

  async writeResponse(callId: string, content: string): Promise<string> {
    await this.init();
    const path = join(this.rootDir, 'responses', `${callId}.json`);
    await writeFile(path, content, 'utf8');
    return path;
  }

  async writeVerify(callId: string, step: VerifyStep, content: string): Promise<string> {
    await this.init();
    const path = join(this.rootDir, 'verify', `${callId}-${step}.txt`);
    await writeFile(path, content, 'utf8');
    return path;
  }

  /**
   * TR-2 (V1.9.6): stamp the `claude --version` string into the audit trail root
   * (alongside the prompts/responses/verify subdirs) so a run's transcript
   * records which CLI produced it — the audit-side companion to `report.json`'s
   * `claudeVersion`. `init()` asserts the subdirs; the root file gets its own
   * containment assert since it is not written through them.
   */
  async writeClaudeVersion(version: string): Promise<string> {
    await this.init();
    // Filename intentionally NOT prefixed `claude-` — the `no model id in src/`
    // guard (test/unit/claude-runner.test.ts) flags a quoted `'claude-…'`
    // literal, and this is a plain CLI-version stamp, not a model id.
    const path = join(this.rootDir, 'cli-version.txt');
    await assertInsideProject(path, this.projectRoot);
    await writeFile(path, `${version}\n`, 'utf8');
    return path;
  }

  /**
   * V1.9.8 Phase 2 — the detection cache's honest hit records (key + target
   * file + source run id per served batch), written to the audit-trail root.
   * A cache HIT never produces a prompt/response pair (it short-circuits
   * above `AuditingRunner`), so this file is the positive audit artifact for
   * "these calls were served, not made" — the anti-fabrication companion.
   * Same root-level containment pattern as `writeClaudeVersion`.
   */
  async writeCacheHits(records: readonly CacheHitRecord[]): Promise<string> {
    await this.init();
    const path = join(this.rootDir, 'cache-hits.json');
    await assertInsideProject(path, this.projectRoot);
    await writeFile(path, JSON.stringify(records, null, 2), 'utf8');
    return path;
  }
}
