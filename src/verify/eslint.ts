/**
 * SPEC §2.10 step 2 — invoke `eslint` against a target file. Optional in the
 * pipeline: if eslint is not configured/installed the step is skipped with a
 * warning (decision lives in the orchestrator). This adapter just runs the
 * binary and reports the result; lint failure is data, never an exception.
 */

import { exec, type ExecOptions } from '../util/exec.js';

export interface EslintRunArgs {
  readonly projectRoot: string;
  /** Project-relative or absolute path. Omit to lint the whole project. */
  readonly file?: string;
  readonly execImpl?: typeof exec;
  readonly signal?: AbortSignal;
  readonly binary?: string;
}

export interface EslintResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly durationMs: number;
}

export const ESLINT_BINARY = 'eslint';

/**
 * V1.3.1-3 Problem 3 — hard ceiling on a single eslint invocation. A hung
 * eslint must fail the step rather than freeze the CLI forever; `exec` maps a
 * timeout to `exitCode: -1`, treated as a step / tool failure downstream.
 * Internal constant, not a public arg (repo convention — no central
 * `constants.ts`).
 */
export const ESLINT_TIMEOUT_MS = 5 * 60_000;

export async function runEslint(args: EslintRunArgs): Promise<EslintResult> {
  const impl = args.execImpl ?? exec;
  const binary = args.binary ?? ESLINT_BINARY;
  // SEC-4 (V1.8) — `--` end-of-options before the project-derived positional so
  // a path that begins with `-` can never be parsed as a flag. eslint
  // (optionator) honours `--` and keeps exact file targeting (verified). The
  // no-file case lints `.` (a constant, not project-derived) so it needs no
  // terminator.
  const cmdArgs: string[] = args.file !== undefined ? ['--', args.file] : ['.'];
  const opts: ExecOptions = {
    cwd: args.projectRoot,
    preferLocal: true,
    timeout: ESLINT_TIMEOUT_MS,
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
