/**
 * V1.3.1-3 Problem 2 — batched baseline lint.
 *
 * The SPEC §2.3 baseline guard needs a project-wide yes/no answer to "does
 * lint pass on the existing code", answerable in O(1) lint invocations. Before
 * V1.3.1-3 the per-artifact verify pipeline (`verifyArtifact`) was reused as a
 * per-file bulk scanner — on a real `generate --all` that is hundreds of
 * full-project ui5lint/eslint subprocesses, strictly sequential, before any
 * LLM call.
 *
 * `runBaselineLint` collapses that to ceil(N / chunk-size) subprocesses per
 * linter: it runs `ui5lint -f json` and `eslint -f json` over the explicit
 * in-scope file list — chunked to bound the Windows `CreateProcess`
 * 32 767-char command-line limit — and merges the per-file JSON results.
 * `-f json` gives structured per-file attribution, never fragile stylish-text
 * scraping.
 *
 * Path handling: in-scope files arrive as absolute paths and are passed to the
 * linters project-relative + POSIX (ui5lint rejects absolute patterns). The
 * linters echo paths back inconsistently — ui5lint emits OS-native
 * project-relative, eslint emits absolute — so every `filePath` in the output
 * is normalised back to project-relative POSIX, the form `Finding.file` must
 * carry for `applyAndVerifyFix` to resolve it.
 *
 * eslint scope: ui5lint lints JS, XML views and JSON; eslint only JS. Passing
 * eslint a `.view.xml` yields a noisy, non-attributable "no matching
 * configuration" warning (severity 1, `errorCount: 0`) — never an error — so
 * views are excluded from the eslint scope.
 *
 * Tool-failure policy: a chunk that times out (`exec` → `exitCode: -1`) or
 * whose stdout is not the expected JSON array (an eslint exit-2 config error,
 * a crash) routes that linter to `unattributable` — a real abort, never "all
 * files clean" and never a fabricated per-file finding. Ordinary lint errors
 * (a non-zero exit that still produced valid JSON) always get per-file
 * attribution, keyed off each file report's `errorCount` / `fatalErrorCount`.
 */

import { isAbsolute, relative } from 'node:path';
import { exec, type ExecImpl, type ExecResult } from '../util/exec.js';
import { lintReportSchema, safeJson, type LintFileReport, type LintMessage } from '../util/schema.js';
import { ESLINT_BINARY, ESLINT_TIMEOUT_MS } from './eslint.js';
import { UI5LINT_BINARY, UI5LINT_TIMEOUT_MS } from './ui5lint.js';

/**
 * Files per lint subprocess. Each in-scope SAPUI5 path is ~40-60 chars
 * project-relative; 100 paths keeps the assembled command line an order of
 * magnitude under the Windows `CreateProcess` 32 767-char ceiling while still
 * collapsing an N-file scope to ceil(N / 100) subprocesses per linter.
 */
export const BASELINE_LINT_CHUNK_SIZE = 100;

/** The two file-attributable lint steps the baseline guard runs. */
export type BaselineLintStep = 'ui5lint' | 'eslint';

export interface BaselineLintFileFailure {
  /** Project-relative POSIX path — resolvable by `applyAndVerifyFix`. */
  readonly file: string;
  readonly step: BaselineLintStep;
  /** Human-readable rendering of that file's lint messages (fed to the LLM). */
  readonly explanation: string;
}

export interface BaselineLintUnattributable {
  readonly step: BaselineLintStep;
  readonly stderr: string;
}

export interface BaselineLintResult {
  readonly failures: readonly BaselineLintFileFailure[];
  readonly unattributable: readonly BaselineLintUnattributable[];
}

/**
 * SEC-6 (V1.8) — thrown when a baseline-lint path normalises to one that
 * escapes the project root (`..` / `../…`). Brings the batched baseline path to
 * parity with the per-file `toProjectRelativePosix` in `verify/ui5lint.ts`,
 * which already fails closed on the same condition. The normalised value
 * becomes `Finding.file`, which `applyAndVerifyFix` resolves against
 * `projectRoot` to choose a write path, so an unguarded `..` is a containment
 * gap; refusing it is a deliberate fail-closed exception, distinct from the
 * "tool failure is data" policy.
 */
export class BaselineLintPathOutsideProjectError extends Error {
  readonly file: string;
  readonly projectRoot: string;

  constructor(file: string, projectRoot: string) {
    super(
      `A baseline-lint path resolved outside the project root and was refused. ` +
        `(target: "${file}", project root: "${projectRoot}")`,
    );
    this.name = 'BaselineLintPathOutsideProjectError';
    this.file = file;
    this.projectRoot = projectRoot;
    Object.setPrototypeOf(this, BaselineLintPathOutsideProjectError.prototype);
  }
}

export interface BaselineLintArgs {
  readonly projectRoot: string;
  /** In-scope files (absolute paths). */
  readonly files: readonly string[];
  readonly eslintEnabled: boolean;
  /**
   * V1.9 G2-03 — widen the eslint scope to `.ts` sources. Set ONLY when the
   * project is TS **and** ships a TS-aware eslint config (the orchestrator gates
   * `eslintEnabled` on the same condition), so eslint never sees a `.ts` it
   * cannot parse. Defaults to `false`: the JS baseline drops `.ts` exactly as
   * before (ui5lint covers it). `.d.ts` declarations are never eslint targets.
   */
  readonly tsEslint?: boolean;
  /** Inject a custom exec implementation (tests / witness A). */
  readonly execImpl?: ExecImpl;
  readonly signal?: AbortSignal;
}

/**
 * Run the batched baseline lint over `files`. ui5lint covers every in-scope
 * file; eslint covers only the JS subset. Never throws — a tool failure is
 * reported as data via `unattributable`.
 */
export async function runBaselineLint(args: BaselineLintArgs): Promise<BaselineLintResult> {
  const execImpl = args.execImpl ?? exec;

  const ui5 = await lintOne({
    binary: UI5LINT_BINARY,
    step: 'ui5lint',
    files: args.files,
    projectRoot: args.projectRoot,
    execImpl,
    timeout: UI5LINT_TIMEOUT_MS,
    ...(args.signal !== undefined ? { signal: args.signal } : {}),
  });

  const eslintFiles = args.eslintEnabled
    ? args.files.filter((f) => isEslintTarget(f, args.tsEslint === true))
    : [];
  const es = await lintOne({
    binary: ESLINT_BINARY,
    step: 'eslint',
    files: eslintFiles,
    projectRoot: args.projectRoot,
    execImpl,
    timeout: ESLINT_TIMEOUT_MS,
    ...(args.signal !== undefined ? { signal: args.signal } : {}),
  });

  return {
    failures: [...ui5.failures, ...es.failures],
    unattributable: [...ui5.unattributable, ...es.unattributable],
  };
}

interface LintOneArgs {
  readonly binary: string;
  readonly step: BaselineLintStep;
  readonly files: readonly string[];
  readonly projectRoot: string;
  readonly execImpl: ExecImpl;
  readonly timeout: number;
  readonly signal?: AbortSignal;
}

/** Run one linter over `files`, chunked, and merge the `-f json` reports. */
async function lintOne(args: LintOneArgs): Promise<BaselineLintResult> {
  if (args.files.length === 0) return { failures: [], unattributable: [] };

  const merged: LintFileReport[] = [];
  // SEC-4 (V1.8) — `--` end-of-options before the project-derived path list, so
  // a path that begins with `-` cannot be parsed as a flag. Only eslint gets it:
  // it honours `--` and keeps exact file targeting, whereas @ui5/linter ignores
  // a post-`--` positional and lints the whole project (verified — see
  // verify/ui5lint.ts). The paths are already in-project relative POSIX, so this
  // is defense-in-depth on the eslint argv only.
  const optionTerminator = args.binary === ESLINT_BINARY ? ['--'] : [];
  for (const group of chunk(args.files, BASELINE_LINT_CHUNK_SIZE)) {
    const relPaths = group.map((f) => toRelPosix(args.projectRoot, f));
    const res = await args.execImpl(args.binary, ['-f', 'json', ...optionTerminator, ...relPaths], {
      cwd: args.projectRoot,
      preferLocal: true,
      timeout: args.timeout,
      ...(args.signal !== undefined ? { signal: args.signal } : {}),
    });
    // `exec` maps a timeout / spawn failure to `exitCode: -1` — no usable JSON.
    if (res.exitCode < 0) {
      return {
        failures: [],
        unattributable: [{ step: args.step, stderr: toToolFailureText(res) }],
      };
    }
    const parsed = safeJson(res.stdout, lintReportSchema);
    if (!parsed.ok) {
      // An eslint exit-2 config error, or any crash: a stdout that is not the
      // expected JSON array is a tool failure, not "all files clean".
      return {
        failures: [],
        unattributable: [{ step: args.step, stderr: toToolFailureText(res) }],
      };
    }
    merged.push(...parsed.data);
  }

  const failures: BaselineLintFileFailure[] = [];
  for (const report of merged) {
    // Errors block the baseline; warnings do not — matches the exit-code
    // convention both linters share (warnings alone keep exit 0).
    if (report.errorCount > 0 || report.fatalErrorCount > 0) {
      const file = toRelPosix(args.projectRoot, report.filePath);
      failures.push({
        file,
        step: args.step,
        explanation: renderExplanation(file, report.messages),
      });
    }
  }
  return { failures, unattributable: [] };
}

/**
 * Normalise a path to project-relative POSIX. ui5lint emits OS-native
 * project-relative paths; eslint emits absolute paths — both flow through here
 * so `Finding.file` is always the project-relative POSIX form
 * `applyAndVerifyFix` resolves against `projectRoot`.
 */
function toRelPosix(projectRoot: string, p: string): string {
  const rel = isAbsolute(p) ? relative(projectRoot, p) : p;
  const posix = rel.replace(/\\/g, '/');
  // SEC-6 — fail closed on an escape, matching ui5lint's toProjectRelativePosix.
  if (posix === '..' || posix.startsWith('../')) {
    throw new BaselineLintPathOutsideProjectError(p, projectRoot);
  }
  return posix;
}

/** Render a file's lint messages as a stylish-like, human-readable block. */
function renderExplanation(file: string, messages: readonly LintMessage[]): string {
  const lines: string[] = [file];
  for (const m of messages) {
    const loc = m.line !== undefined ? `${m.line}:${m.column ?? 0}` : '-';
    const severity = m.severity === 2 ? 'error' : m.severity === 1 ? 'warning' : 'info';
    const rule = typeof m.ruleId === 'string' && m.ruleId.length > 0 ? `  ${m.ruleId}` : '';
    lines.push(`  ${loc}  ${severity}  ${m.message}${rule}`);
  }
  return lines.join('\n');
}

function toToolFailureText(res: ExecResult): string {
  const parts = [res.stderr, res.stdout].filter((s) => s.length > 0);
  if (parts.length > 0) return parts.join('\n');
  return `lint subprocess failed (exitCode ${res.exitCode}) with no output`;
}

function isJsFile(file: string): boolean {
  return /\.(?:js|mjs|cjs)$/i.test(file);
}

/**
 * V1.9 G2-03 — which files the baseline eslint step lints. Always the JS set;
 * additionally `.ts` (excluding ambient `.d.ts`) when `tsEslint` is set (a TS
 * project shipping a TS-aware eslint config). Keeping `.d.ts` out matches the
 * discovery excludes — declarations are not lintable sources.
 */
function isEslintTarget(file: string, tsEslint: boolean): boolean {
  if (isJsFile(file)) return true;
  if (tsEslint && /\.ts$/i.test(file) && !/\.d\.ts$/i.test(file)) return true;
  return false;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
