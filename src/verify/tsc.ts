/**
 * SPEC §2.10 (V1.9 TS-VERIFY) — invoke the PROJECT's `tsc --noEmit` as the
 * type-check step of the TypeScript static verify lane.
 *
 * This is the project's own `tsc` (resolved via `execa.preferLocal`, exactly
 * like `ui5lint`/`eslint`/`karma`), NEVER a `typescript` dependency bundled
 * into this CLI — the 6-runtime-dep posture is unchanged (CLAUDE.md, diagnosis
 * §3.1). `--noEmit` is type-only: it writes nothing and executes no project
 * code (it is a static parse + check, the same trust posture as the existing
 * `sap.ui.define` scanner — diagnosis §3.1 `A1`). It is whole-project: `tsc`
 * discovers the project's own `tsconfig.json` and checks the configured
 * sources, so a fix that breaks types anywhere fails the step.
 *
 * Failure (a type error, or a spawn/timeout `exitCode: -1`) is reported as
 * data, never thrown — the verify pipeline reads `ok`/`stderr`/`stdout`.
 *
 * DEP-3/HB-3: every invocation carries the same per-subprocess timeout the
 * other verify adapters enforce, so a pathological `tsconfig` (huge `include`,
 * deep generics) is timeout-killed rather than hanging the run.
 */

import { exec, type ExecOptions } from '../util/exec.js';

export interface TscRunArgs {
  readonly projectRoot: string;
  /** Inject a custom exec implementation (tests). */
  readonly execImpl?: typeof exec;
  readonly signal?: AbortSignal;
  /** Override the binary name (default `tsc`). */
  readonly binary?: string;
}

export interface TscResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly durationMs: number;
}

export const TSC_BINARY = 'tsc';

/**
 * Hard ceiling on a single `tsc --noEmit` invocation (DEP-3/HB-3). Mirrors
 * `UI5LINT_TIMEOUT_MS`/`ESLINT_TIMEOUT_MS`: `tsc` rebuilds the whole project
 * type model and a cold check of a large project is legitimately slow, but a
 * genuinely hung / adversarial compile must fail the step rather than freeze
 * the CLI forever. `exec` maps a timeout to `exitCode: -1`, which the verify
 * pipeline reads as a failed step. Internal constant, not a public arg (repo
 * convention — no central `constants.ts`).
 */
export const TSC_TIMEOUT_MS = 5 * 60_000;

export async function runTsc(args: TscRunArgs): Promise<TscResult> {
  const impl = args.execImpl ?? exec;
  const binary = args.binary ?? TSC_BINARY;
  // `--noEmit`: type-check only, write nothing. No file positionals — passing a
  // single file makes `tsc` ignore `tsconfig.json` (losing module resolution +
  // the project's `types`), so the whole-project check (driven by the project's
  // own `tsconfig.json`, discovered from `cwd`) is the correct, higher-fidelity
  // gate. `shell:false` is enforced by `exec`; `preferLocal` resolves the
  // project-local `node_modules/.bin/tsc`.
  const cmdArgs: string[] = ['--noEmit'];
  const opts: ExecOptions = {
    cwd: args.projectRoot,
    preferLocal: true,
    timeout: TSC_TIMEOUT_MS,
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
