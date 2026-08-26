/**
 * SPEC §2.10 step 1 — invoke `ui5lint` against a target file (or the whole
 * project when `file` is omitted). Returns a typed, never-throwing result;
 * lint failure is data the pipeline reports back, not an exception.
 *
 * The adapter relies on `execa.preferLocal` so the project's
 * `node_modules/.bin/ui5lint` is preferred over a global install and
 * Windows extension resolution (.cmd) is handled automatically.
 */

import { isAbsolute, relative } from 'node:path';
import { exec, type ExecOptions } from '../util/exec.js';

export class Ui5LintFileOutsideProjectError extends Error {
  readonly file: string;
  readonly projectRoot: string;

  constructor(file: string, projectRoot: string) {
    // V1.2-4: explain the constraint in user terms (ui5lint cannot lint
    // outside the project root) and give the two concrete recovery paths
    // (run from the right directory / pass an in-project path) before the
    // technical "(target ..., project root ...)" reference.
    super(
      `The file passed to ui5lint is outside the project root, so ui5lint cannot lint it. ` +
        `Run sapui5-validate from the directory that contains the file, ` +
        `or pass a path inside the project. ` +
        `(target: "${file}", project root: "${projectRoot}")`,
    );
    this.name = 'Ui5LintFileOutsideProjectError';
    this.file = file;
    this.projectRoot = projectRoot;
    Object.setPrototypeOf(this, Ui5LintFileOutsideProjectError.prototype);
  }
}

export interface Ui5LintRunArgs {
  readonly projectRoot: string;
  /** Project-relative or absolute path. Omit to lint the whole project. */
  readonly file?: string;
  /** Inject a custom exec implementation (tests). */
  readonly execImpl?: typeof exec;
  readonly signal?: AbortSignal;
  /** Override the binary name (default `ui5lint`). */
  readonly binary?: string;
}

export interface Ui5LintResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly durationMs: number;
}

export const UI5LINT_BINARY = 'ui5lint';

/**
 * V1.3.1-3 Problem 3 — hard ceiling on a single ui5lint invocation. ui5lint
 * rebuilds the whole project model on every run; a genuinely hung linter must
 * fail the step rather than freeze the CLI forever. `exec` maps a timeout to
 * `exitCode: -1`, which the verify pipeline and the batched baseline-lint path
 * both treat as a step / tool failure. Generous on purpose — a cold lint of a
 * large project is slow but legitimate. Internal constant, not a public arg
 * (repo convention — no central `constants.ts`).
 */
export const UI5LINT_TIMEOUT_MS = 5 * 60_000;

export async function runUi5Lint(args: Ui5LintRunArgs): Promise<Ui5LintResult> {
  const impl = args.execImpl ?? exec;
  const binary = args.binary ?? UI5LINT_BINARY;
  // SEC-4 (V1.8) — a `--` end-of-options token is deliberately NOT inserted
  // here: @ui5/linter ignores any positional that follows `--` and silently
  // lints the WHOLE project instead of the targeted file (verified
  // empirically), which would break per-file scoping. The filename-as-flag
  // vector SEC-4 hardens is unreachable for ui5lint anyway — the positional is
  // normalised to a project-relative POSIX path below and a leading `-` is not
  // produced by `relative()` for an in-project file.
  const cmdArgs: string[] =
    args.file !== undefined ? [toProjectRelativePosix(args.projectRoot, args.file)] : [];
  const opts: ExecOptions = {
    cwd: args.projectRoot,
    preferLocal: true,
    timeout: UI5LINT_TIMEOUT_MS,
    ...(args.signal !== undefined ? { signal: args.signal } : {}),
  };
  const res = await impl(binary, cmdArgs, opts);
  return {
    ok: res.ok,
    stdout: res.stdout,
    stderr: res.stderr,
    exitCode: res.exitCode,
    durationMs: res.durationMs,
  };
}

// ui5lint (@ui5/linter) refuses absolute paths with "Pattern must be relative
// to project's root folder". Callers in the runtime path always pass absolute
// paths (fast-glob with `absolute: true`), so we normalize here. POSIX
// separators are required on every platform; on Windows path.relative emits
// backslashes that must be flipped.
function toProjectRelativePosix(projectRoot: string, file: string): string {
  const rel = isAbsolute(file) ? relative(projectRoot, file) : file;
  const posix = rel.replace(/\\/g, '/');
  if (posix === '..' || posix.startsWith('../')) {
    throw new Ui5LintFileOutsideProjectError(file, projectRoot);
  }
  return posix;
}
