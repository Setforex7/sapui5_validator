/**
 * SPEC §2.11 — probe required/conditional/optional tools at startup, cache
 * the result, hard-fail on missing required, warn-and-skip on missing optional.
 *
 * Classification:
 *  - ui5lint: always required (provided by `@ui5/linter`).
 *  - karma:   required for a JS project (V1 supports karma only — see §2.10);
 *             **NOT required for a TypeScript project** (V1.9), because a TS
 *             `validate` run takes the static-only verify lane and NEVER runs
 *             karma (the never-build firewall — karma-running a `.ts` would
 *             transpile it via the project's babel config = arbitrary code
 *             execution). Requiring karma there would hard-fail an honest TS
 *             project that legitimately ships no karma.
 *  - eslint:  conditional if listed in `package.json`, optional otherwise.
 *
 * The default probe is filesystem-only against `<projectRoot>/node_modules/`.
 * Tests inject a `ProbeAdapter` to avoid touching the real filesystem.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectLanguage } from './detect.js';
import { exec, type ExecResult } from '../util/exec.js';

export type ToolName = 'ui5lint' | 'eslint' | 'karma';
export type ToolClassification = 'required' | 'conditional' | 'optional';
export type ToolStatus = 'ok' | 'missing';
export type ToolSource = 'node_modules' | 'global' | 'unknown';

export interface ToolReport {
  readonly name: ToolName;
  readonly classification: ToolClassification;
  readonly status: ToolStatus;
  readonly version?: string;
  readonly source?: ToolSource;
  readonly detail?: string;
}

export interface ToolingProbeResult {
  readonly tools: readonly ToolReport[];
  readonly hardFail: boolean;
  readonly missingRequired: readonly ToolName[];
  readonly skippedOptional: readonly ToolName[];
}

export interface ToolProbe {
  readonly modulePath: string;
  readonly binName?: string;
}

export interface ProbeOutcome {
  readonly present: boolean;
  readonly version?: string;
  readonly source?: ToolSource;
}

export type MaybePromise<T> = T | Promise<T>;

export interface ProbeAdapter {
  readonly probe: (projectRoot: string, spec: ToolProbe) => MaybePromise<ProbeOutcome>;
}

export interface ProbeOptions {
  readonly adapter?: ProbeAdapter;
  /**
   * V1.9 — the project's source language. `'ts'` declassifies karma from
   * `required` to `optional` (a TS run never executes karma; see the module
   * header). Defaults to `'js'`, which keeps karma required — the JS path is
   * byte-identical.
   */
  readonly projectLanguage?: ProjectLanguage;
}

interface PkgShape {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const TOOL_SPECS: Readonly<Record<ToolName, ToolProbe>> = Object.freeze({
  ui5lint: { modulePath: '@ui5/linter', binName: 'ui5lint' },
  karma: { modulePath: 'karma', binName: 'karma' },
  eslint: { modulePath: 'eslint', binName: 'eslint' },
});

/**
 * Filesystem-only adapter. Narrower than `ProbeAdapter`: its `probe` is
 * guaranteed synchronous so existing callers can keep using its return value
 * directly. The wider `ProbeAdapter` interface (sync OR async) covers the
 * `withNpxFallback` wrapper below.
 */
export const defaultProbeAdapter: { probe: (projectRoot: string, spec: ToolProbe) => ProbeOutcome } = {
  probe(projectRoot, spec) {
    const pkgPath = join(
      projectRoot,
      'node_modules',
      ...spec.modulePath.split('/'),
      'package.json',
    );
    if (!existsSync(pkgPath)) return { present: false };
    try {
      const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: unknown };
      const version = typeof parsed.version === 'string' ? parsed.version : undefined;
      return version !== undefined
        ? { present: true, version, source: 'node_modules' }
        : { present: true, source: 'node_modules' };
    } catch {
      return { present: true, source: 'node_modules' };
    }
  },
};

function readPackageJson(projectRoot: string): PkgShape {
  const p = join(projectRoot, 'package.json');
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as PkgShape;
  } catch {
    return {};
  }
}

export async function probeTooling(
  projectRoot: string,
  options: ProbeOptions = {},
): Promise<ToolingProbeResult> {
  const adapter = options.adapter ?? defaultProbeAdapter;
  const pkg = readPackageJson(projectRoot);
  const declared = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };

  const eslintInPkg = declared['eslint'] !== undefined;
  // V1.9 — karma is required only for a JS project; a TS run never executes it
  // (the never-build firewall), so its absence must not hard-fail a TS project.
  const karmaClassification: ToolClassification =
    (options.projectLanguage ?? 'js') === 'ts' ? 'optional' : 'required';

  const [ui5lintOutcome, karmaOutcome, eslintOutcome] = await Promise.all([
    Promise.resolve(adapter.probe(projectRoot, TOOL_SPECS.ui5lint)),
    Promise.resolve(adapter.probe(projectRoot, TOOL_SPECS.karma)),
    Promise.resolve(adapter.probe(projectRoot, TOOL_SPECS.eslint)),
  ]);

  const tools: ToolReport[] = [
    buildReport({
      name: 'ui5lint',
      classification: 'required',
      outcome: ui5lintOutcome,
      missingDetail: 'Install: npm i -D @ui5/linter (or globally as `ui5lint`).',
    }),
    buildReport({
      name: 'karma',
      classification: karmaClassification,
      outcome: karmaOutcome,
      missingDetail:
        karmaClassification === 'optional'
          ? 'karma is not used for a TypeScript project (the static-only verify lane never runs it).'
          : 'Install: npm i -D karma karma-ui5 — V1 only supports karma (SPEC §2.10).',
    }),
    buildReport({
      name: 'eslint',
      classification: eslintInPkg ? 'conditional' : 'optional',
      outcome: eslintOutcome,
      missingDetail: eslintInPkg
        ? 'eslint is in package.json but not installed; run `npm install`.'
        : 'eslint is not configured; lint step will be skipped.',
    }),
  ];

  const missingRequired = tools
    .filter(
      (t) =>
        (t.classification === 'required' || t.classification === 'conditional') &&
        t.status === 'missing',
    )
    .map((t) => t.name);

  const skippedOptional = tools
    .filter((t) => t.classification === 'optional' && t.status === 'missing')
    .map((t) => t.name);

  return {
    tools,
    hardFail: missingRequired.length > 0,
    missingRequired,
    skippedOptional,
  };
}

/**
 * COR-9 — hard ceiling for the `npx --no-install <bin> --version` fallback. A
 * misbehaving npx or a slow PATH lookup must not stall the whole run before any
 * work starts, so the probe is bounded and a timeout is treated as "not found"
 * (the conservative filesystem outcome).
 */
export const NPX_PROBE_TIMEOUT_MS = 15_000;

const PROBE_TIMED_OUT = Symbol('npx-probe-timeout');

/** Resolve to {@link PROBE_TIMED_OUT} if `p` does not settle within `ms`. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof PROBE_TIMED_OUT> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(PROBE_TIMED_OUT), ms);
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(PROBE_TIMED_OUT);
      },
    );
  });
}

/**
 * Wrap an existing adapter so a `missing` outcome from the filesystem probe
 * gets a second chance via `npx --no-install <bin> --version`. This catches
 * globally-installed or hoisted-out-of-project tools that the node_modules
 * walk misses. The `--no-install` flag prevents npx from quietly fetching
 * the package from the registry — we only want to detect what's already
 * resolvable on PATH.
 *
 * COR-9: the probe is bounded by `timeoutMs` — the `timeout` is passed to the
 * exec impl (so a real child is killed) AND the call is raced (so the wrapper
 * still resolves even if the impl ignores the timeout). A timeout falls back to
 * the conservative `inner` outcome.
 */
export function withNpxFallback(
  inner: ProbeAdapter,
  execImpl: (
    binary: string,
    args: readonly string[],
    opts: { cwd: string; timeout?: number },
  ) => Promise<ExecResult> = (binary, args, opts) => exec(binary, args, opts),
  timeoutMs: number = NPX_PROBE_TIMEOUT_MS,
): ProbeAdapter {
  return {
    async probe(projectRoot, spec) {
      const inner_outcome = await Promise.resolve(inner.probe(projectRoot, spec));
      if (inner_outcome.present || spec.binName === undefined) return inner_outcome;
      const res = await withTimeout(
        execImpl('npx', ['--no-install', spec.binName, '--version'], {
          cwd: projectRoot,
          timeout: timeoutMs,
        }),
        timeoutMs,
      );
      if (res === PROBE_TIMED_OUT || !res.ok) return inner_outcome;
      const version = parseVersionLine(res.stdout);
      return version !== undefined
        ? { present: true, version, source: 'global' }
        : { present: true, source: 'global' };
    },
  };
}

function parseVersionLine(stdout: string): string | undefined {
  const m = stdout.match(/[0-9]+\.[0-9]+(?:\.[0-9]+)?(?:-[A-Za-z0-9.+-]+)?/);
  return m?.[0];
}

function buildReport(args: {
  readonly name: ToolName;
  readonly classification: ToolClassification;
  readonly outcome: ProbeOutcome;
  readonly missingDetail: string;
}): ToolReport {
  const status: ToolStatus = args.outcome.present ? 'ok' : 'missing';
  if (status === 'ok') {
    return {
      name: args.name,
      classification: args.classification,
      status,
      ...(args.outcome.version !== undefined ? { version: args.outcome.version } : {}),
      ...(args.outcome.source !== undefined ? { source: args.outcome.source } : {}),
    };
  }
  return {
    name: args.name,
    classification: args.classification,
    status,
    source: 'unknown',
    detail: args.missingDetail,
  };
}
