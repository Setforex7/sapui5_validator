/**
 * Shared paths and lightweight readers for the VALIDATOR_E2E_REAL=1 tests.
 *
 * The expensive part of every test in this folder — running
 * `sapui5-validate validate --all` against a copy of
 * `test/fixtures/e2e-real-project/` — happens exactly once in
 * [setup.ts](./setup.ts) (vitest globalSetup). Since V1.9.5 (INF-1) that run
 * executes inside a DETERMINISTIC tmpdir sandbox ({@link SHARED_JS_SANDBOX} /
 * {@link SHARED_TS_SANDBOX}) so the tracked in-repo fixtures are never
 * mutated; the witness test files all assert against the persisted on-disk
 * artifacts the sandbox run leaves behind:
 *
 *   - `<sandbox>/.sapui5-validator/report.json`
 *   - `<sandbox>/.sapui5-validator/last-run/prompts/*`
 *   - `<sandbox>/.sapui5-validator/last-run/responses/*`
 *   - `<sandbox>/.sapui5-validator/last-run/verify/*`
 *   - `<sandbox>/.sapui5-validator/last-run/llm-error-*.txt`
 *
 * The sandbox roots are deterministic (not `mkdtemp`) because the specs run
 * in separate vitest fork processes from the globalSetup and share no memory
 * with it — a fixed path is the channel. Each test does only filesystem reads
 * + assertions, so they execute in milliseconds and stay independent of one
 * another.
 *
 * NOTE: This module makes no test-runner-level assertions. It is plain
 * helpers; the tests themselves do the asserting.
 *
 * V1.3-2 adds `createGenerateSandbox()` — an isolated tmpdir copy of the
 * fixture for the `generate-*` E2E witness tests. See its own doc comment
 * below; it is independent of the shared-validate-run readers above.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import type { RunReport } from '../../src/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));

export const E2E_REAL_ENABLED = process.env['VALIDATOR_E2E_REAL'] === '1';

export const FIXTURE_ROOT = join(HERE, '..', 'fixtures', 'e2e-real-project');

/**
 * V1.9 Phase 4 — the real-toolchain TypeScript-SAPUI5 fixture. `setup.ts` runs
 * one `validate --all --force` against it (static-only lane, no karma), and
 * `ts-validate.e2e.test.ts` asserts against its persisted artifacts via
 * {@link TS_PATHS} below.
 */
export const FIXTURE_TS_ROOT = join(HERE, '..', 'fixtures', 'e2e-real-ts-project');

const REPO_ROOT = join(HERE, '..', '..');
const CLI_ENTRY = join(REPO_ROOT, 'src', 'cli.ts');

/**
 * V1.9.5 (INF-1) — the deterministic sandbox roots for the ONE shared
 * `validate --all --force` run per fixture. `setup.ts` materializes these
 * fresh on every enabled run (copy fixture minus `node_modules`, then
 * junction/symlink `node_modules` from the installed in-repo fixture) and
 * runs the validator with cwd here, so LLM-applied fixes land in the sandbox
 * and the tracked fixtures stay byte-clean — no post-run
 * `git checkout -- test/fixtures/` discipline needed.
 */
export const SHARED_SANDBOX_BASE = join(tmpdir(), 'sapui5-validator-e2e-real');
export const SHARED_JS_SANDBOX = join(SHARED_SANDBOX_BASE, 'js-validate');
export const SHARED_TS_SANDBOX = join(SHARED_SANDBOX_BASE, 'ts-validate');

const VALIDATOR_DIR = join(SHARED_JS_SANDBOX, '.sapui5-validator');
const LAST_RUN_DIR = join(VALIDATOR_DIR, 'last-run');

export const PATHS = {
  fixture: SHARED_JS_SANDBOX,
  validator: VALIDATOR_DIR,
  lastRun: LAST_RUN_DIR,
  reportJson: join(VALIDATOR_DIR, 'report.json'),
  promptsDir: join(LAST_RUN_DIR, 'prompts'),
  responsesDir: join(LAST_RUN_DIR, 'responses'),
  verifyDir: join(LAST_RUN_DIR, 'verify'),
} as const;

const TS_VALIDATOR_DIR = join(SHARED_TS_SANDBOX, '.sapui5-validator');
const TS_LAST_RUN_DIR = join(TS_VALIDATOR_DIR, 'last-run');

export const TS_PATHS = {
  fixture: SHARED_TS_SANDBOX,
  validator: TS_VALIDATOR_DIR,
  lastRun: TS_LAST_RUN_DIR,
  reportJson: join(TS_VALIDATOR_DIR, 'report.json'),
  promptsDir: join(TS_LAST_RUN_DIR, 'prompts'),
  responsesDir: join(TS_LAST_RUN_DIR, 'responses'),
  verifyDir: join(TS_LAST_RUN_DIR, 'verify'),
} as const;

export function reportExists(): boolean {
  return existsSync(PATHS.reportJson);
}

export function readReport(): RunReport {
  const raw = readFileSync(PATHS.reportJson, 'utf8');
  return JSON.parse(raw) as RunReport;
}

export function tsReportExists(): boolean {
  return existsSync(TS_PATHS.reportJson);
}

export function readTsReport(): RunReport {
  const raw = readFileSync(TS_PATHS.reportJson, 'utf8');
  return JSON.parse(raw) as RunReport;
}

/**
 * Concatenated text of every file directly under `dir` (non-recursive). Used by
 * the TS witness to confirm a TS-framed check prompt (` ```typescript ` fence +
 * the `.ts` controller source) actually reached the model — i.e. TS-aware
 * discovery enumerated the `.ts` controller (HB-2) and the GA1-10 framing was
 * applied. Returns '' when the directory is absent.
 */
export function concatDirFiles(dir: string): string {
  if (!existsSync(dir)) return '';
  return listDir(dir)
    .map((name) => {
      try {
        return readFileSync(join(dir, name), 'utf8');
      } catch {
        return '';
      }
    })
    .join('\n');
}

/**
 * Returns the filenames (not full paths) in `dir`. If `dir` does not exist,
 * returns []. The Bug-5 / Bug-7 tests rely on this distinction: today the
 * directories exist (created by `AuditLog.init()`) but are empty, and
 * `[]` is the correct, non-throwing observation of that state.
 */
export function listDir(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const stat = statSync(dir);
  if (!stat.isDirectory()) return [];
  return readdirSync(dir);
}

/**
 * Lazy diagnostic for failed assertions. Each E2E test that fails should
 * include this in its expect message so the developer can immediately see
 * the audit-log shape without re-running the suite.
 */
export function lastRunSummary(): string {
  return JSON.stringify(
    {
      reportExists: reportExists(),
      prompts: listDir(PATHS.promptsDir).slice(0, 5),
      responses: listDir(PATHS.responsesDir).slice(0, 5),
      verify: listDir(PATHS.verifyDir).slice(0, 5),
    },
    null,
    2,
  );
}

/**
 * V1.3-2 — an isolated sandbox for the `generate-*` E2E witness tests.
 *
 * Each `generate` E2E test spawns the real CLI against its own tmpdir copy of
 * `test/fixtures/e2e-real-project/`, so a `generate` run never overwrites the
 * shared `validate --all` run's `.sapui5-validator/` artifacts that the V1.1
 * bug-witness tests assert against. `node_modules` is symlinked from the
 * already-installed fixture (a junction on Windows so no Developer Mode /
 * elevation is needed), reusing the one-time `npm install` from setup.ts.
 *
 * This extracts the tmpdir + `cpSync` + symlink pattern pioneered inline in
 * `dynamic-budget.e2e.test.ts`; the four new generate tests are the second
 * caller, so the extraction is warranted (CLAUDE.md §Avoid single-use
 * helpers). `dynamic-budget.e2e.test.ts` is intentionally left on its inline
 * copy — churning a passing test buys nothing.
 */
export interface CliRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * A forward-compatible structural view of `report.json`. `exitReason.kind`
 * and `generatedTests[].status` are typed as plain `string` so a witness test
 * can assert a value the strict `RunReport` union does not gain until its fix
 * lands (`'no-output'` in V1.3-3, `'karma-unavailable'` in V1.3-5).
 */
export interface LooseRunReport {
  readonly command: string;
  readonly exitReason: { readonly kind: string; readonly [k: string]: unknown };
  readonly exitCode: number;
  readonly llmCallCount: number;
  readonly generatedTests: ReadonlyArray<{
    readonly sourceFile: string;
    readonly testFile: string;
    readonly status: string;
    /**
     * V1.9.2 (TG-REPORT) — verification-depth marker. A generated TypeScript
     * QUnit test accepted on the static lane (ui5lint + `tsc --noEmit` + the
     * shape check, never karma) carries `'static-only'`; `'lint-only'` is the
     * OPA5 fallback. Typed as plain `string?` here (the loose forward-compatible
     * view) so the generate-for-TS witness can read it without the strict union.
     */
    readonly verification?: string;
  }>;
  readonly files: ReadonlyArray<{
    readonly file: string;
    readonly findings: ReadonlyArray<{
      readonly checkId: string;
      readonly message: string;
      readonly proposedFix: { readonly newFileContent: string } | null;
      readonly explanation?: string;
    }>;
  }>;
}

export interface GenerateSandbox {
  /** Absolute path to the tmpdir copy of the fixture. */
  readonly root: string;
  /** Absolute path to a file/dir inside the sandbox. */
  path(...segments: readonly string[]): string;
  /** Spawn the real CLI (`tsx src/cli.ts <args>`) with cwd at the sandbox. */
  run(
    args: readonly string[],
    opts?: { readonly stdin?: 'pipe' | 'ignore' },
  ): Promise<CliRunResult>;
  /** Parse the sandbox-local `.sapui5-validator/report.json`. Throws if absent. */
  readReport(): LooseRunReport;
  /** Whether the sandbox-local `report.json` exists. */
  reportExists(): boolean;
  /** Best-effort recursive removal of the tmpdir — call from `afterAll`. */
  remove(): void;
}

/**
 * The JS fixture skeleton copied into a `createGenerateSandbox` tmpdir —
 * everything EXCEPT `node_modules` (symlinked) and `.sapui5-validator` (we want
 * a virgin output directory). `eslint.config.js` MUST be copied: an isolated
 * tmpdir cannot inherit the validator repo's own eslint config the way the
 * in-repo fixture does, so without it eslint fails ("couldn't find
 * eslint.config") and the baseline guard refuses before any generation happens
 * (V1.3-2).
 */
export const JS_SANDBOX_COPY_ENTRIES = [
  'webapp',
  'package.json',
  'ui5.yaml',
  'karma.conf.js',
  'eslint.config.js',
] as const;

/**
 * V1.9.2 (TG-E2E) — the TS fixture skeleton for `createTsGenerateSandbox`. No
 * `karma.conf.js` (karma is firewalled for a TS project — it is never run). No
 * `eslint.config.js` (the TS fixture ships none; eslint is config-gated OFF for
 * TS, ui5lint covers the `.ts`). `tsconfig.json` IS copied — the static-only
 * verify lane runs `tsc --noEmit`, which needs the project tsconfig's `include`
 * scope, `paths`, and `@openui5/types`. `env.d.ts` rides along under `webapp/`.
 */
export const TS_SANDBOX_COPY_ENTRIES = [
  'webapp',
  'package.json',
  'ui5.yaml',
  'tsconfig.json',
] as const;

/**
 * V1.9.5 (INF-1) — the copy-minus-`node_modules` + junction/symlink core
 * shared by every sandbox in this suite: {@link makeSandbox} (tmpdir
 * `generate` sandboxes) and `setup.ts` (the deterministic shared `validate`
 * sandboxes). Recreates `sandboxRoot` from scratch: removes any previous
 * incarnation (the `node_modules` link is removed as a link, never followed
 * into the real install), copies the listed fixture entries, then links
 * `node_modules` from the installed in-repo fixture — a junction on Windows
 * (no Developer Mode / elevation needed), a plain dir symlink on POSIX.
 * Exported so the cheap offline suite can exercise both platform branches in
 * CI (the ubuntu leg is the only place the POSIX symlink path runs).
 */
export function materializeSandboxInto(opts: {
  readonly fixtureRoot: string;
  readonly sandboxRoot: string;
  readonly copyEntries: readonly string[];
}): void {
  rmSync(opts.sandboxRoot, { recursive: true, force: true });
  mkdirSync(opts.sandboxRoot, { recursive: true });
  for (const entry of opts.copyEntries) {
    const src = join(opts.fixtureRoot, entry);
    if (!existsSync(src)) continue;
    cpSync(src, join(opts.sandboxRoot, entry), { recursive: true });
  }
  symlinkSync(
    join(opts.fixtureRoot, 'node_modules'),
    join(opts.sandboxRoot, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
}

/**
 * Shared body behind {@link createGenerateSandbox} (JS fixture) and
 * {@link createTsGenerateSandbox} (TS fixture). The JS caller passes the exact
 * `FIXTURE_ROOT` + entry list the function used inline before V1.9.2, so its
 * behaviour is byte-identical; the TS caller swaps the fixture root + entries.
 */
function makeSandbox(opts: {
  readonly prefix: string;
  readonly fixtureRoot: string;
  readonly copyEntries: readonly string[];
}): GenerateSandbox {
  const root = mkdtempSync(join(tmpdir(), opts.prefix));
  materializeSandboxInto({
    fixtureRoot: opts.fixtureRoot,
    sandboxRoot: root,
    copyEntries: opts.copyEntries,
  });
  const reportPath = join(root, '.sapui5-validator', 'report.json');
  return {
    root,
    path(...segments) {
      return join(root, ...segments);
    },
    async run(args, opts = {}) {
      const result = await execa('npx', ['tsx', CLI_ENTRY, ...args], {
        cwd: root,
        reject: false,
        // A cold karma start downloads the UI5 CDN and boots headless Chrome;
        // a real generate run can take several minutes on Windows. setup.ts
        // uses the same 10-minute ceiling for its validate run.
        timeout: 10 * 60_000,
        shell: process.platform === 'win32',
        stdin: opts.stdin ?? 'ignore',
        env: { ...process.env, LANG: 'en_US.UTF-8' },
      });
      return {
        exitCode: result.exitCode ?? -1,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
    readReport() {
      return JSON.parse(readFileSync(reportPath, 'utf8')) as LooseRunReport;
    },
    reportExists() {
      return existsSync(reportPath);
    },
    remove() {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // Best-effort: a stale junction on Windows can refuse removal; leave
        // it for the OS tmp reaper rather than fail the test on cleanup.
      }
    },
  };
}

/**
 * An isolated sandbox copy of the JS fixture `test/fixtures/e2e-real-project/`
 * for the `generate-*` E2E witnesses. Unchanged from the pre-V1.9.2 inline body
 * — same fixture root, same copy entries — now delegating to {@link makeSandbox}.
 */
export function createGenerateSandbox(prefix: string): GenerateSandbox {
  return makeSandbox({
    prefix,
    fixtureRoot: FIXTURE_ROOT,
    copyEntries: JS_SANDBOX_COPY_ENTRIES,
  });
}

/**
 * V1.9.2 (TG-E2E) — an isolated sandbox copy of the TypeScript fixture
 * `test/fixtures/e2e-real-ts-project/` for the generate-for-TS witness
 * (`ts-generate.e2e.test.ts`). Isolation is load-bearing here: vitest runs the
 * `e2e-real` files in parallel forks over a shared filesystem, so running
 * `generate` against the in-repo TS fixture would clobber the
 * `FIXTURE_TS/.sapui5-validator/report.json` that `ts-validate.e2e.test.ts`
 * reads. The sandbox gives the generate run its own working directory; the
 * generated `.qunit.ts` lands in the tmpdir and `afterAll`'s `remove()` cleans
 * it up, so the in-repo fixture is never mutated by the run. `node_modules`
 * (with `@openui5/types` / `typescript` / `@ui5/linter`) is symlinked from the
 * already-installed TS fixture, reusing setup.ts's one-time `npm install`.
 */
export function createTsGenerateSandbox(prefix: string): GenerateSandbox {
  return makeSandbox({
    prefix,
    fixtureRoot: FIXTURE_TS_ROOT,
    copyEntries: TS_SANDBOX_COPY_ENTRIES,
  });
}
