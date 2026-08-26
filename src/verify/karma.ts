/**
 * SPEC §2.10 step 3 — run the project's karma test suite. V1 supports karma
 * only; QUnit and OPA5 are exercised via the same karma invocation since
 * karma-ui5 wires both. Failure (non-zero exit) is reported as data; the
 * adapter never throws on test failure.
 *
 * The adapter does not currently scope karma to a single file — V1 runs the
 * full configured suite. The `testFiles` field is recorded on the result for
 * the pipeline's audit trail and may drive a future `--files` override.
 */

import { exec, type ExecOptions } from '../util/exec.js';

export interface KarmaRunArgs {
  readonly projectRoot: string;
  /** Karma config path (project-relative or absolute). Optional — karma autoresolves. */
  readonly configFile?: string;
  /** Test files conceptually under verification; recorded on the result for audit. */
  readonly testFiles?: readonly string[];
  readonly execImpl?: typeof exec;
  readonly signal?: AbortSignal;
  readonly binary?: string;
  readonly timeoutMs?: number;
}

export interface KarmaResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly testFiles: readonly string[];
}

export const KARMA_BINARY = 'karma';

/**
 * V1.3.1-3 Problem 3 — hard ceiling on a single karma invocation, passed by
 * every production caller through {@link KarmaRunArgs.timeoutMs}. Sized
 * generously: a cold karma start legitimately takes minutes (UI5-CDN download
 * + headless Chrome boot) before a single test runs. `exec` maps a timeout to
 * `exitCode: -1` — `classifyKarmaFailure` then reads that as
 * `runner-unavailable`. Internal constant, not baked into `runKarma`'s
 * signature (repo convention — no central `constants.ts`).
 */
export const KARMA_TIMEOUT_MS = 10 * 60_000;

export async function runKarma(args: KarmaRunArgs): Promise<KarmaResult> {
  const impl = args.execImpl ?? exec;
  const binary = args.binary ?? KARMA_BINARY;
  // SEC-4 (V1.8) — a `--` end-of-options token is deliberately NOT inserted
  // before the config positional: karma ignores a config that follows `--` and
  // silently falls back to its DEFAULT karma.conf.js (verified empirically),
  // which would run the wrong suite. The configFile is a project-resolved path
  // (never user-supplied as a bare leading-`-` token), so the filename-as-flag
  // vector SEC-4 hardens is unreachable here.
  const cmdArgs: string[] = ['start'];
  if (args.configFile !== undefined) cmdArgs.push(args.configFile);
  const opts: ExecOptions = {
    cwd: args.projectRoot,
    preferLocal: true,
    ...(args.timeoutMs !== undefined ? { timeout: args.timeoutMs } : {}),
    ...(args.signal !== undefined ? { signal: args.signal } : {}),
  };
  const res = await impl(binary, cmdArgs, opts);
  return {
    ok: res.ok,
    stdout: res.stdout,
    stderr: res.stderr,
    exitCode: res.exitCode,
    durationMs: res.durationMs,
    testFiles: args.testFiles ?? [],
  };
}

/**
 * V1.3-5 — classification of a *failed* karma run (SPEC §2.10 step 3).
 *
 * `runner-unavailable` means karma never executed any test: a spawn failure,
 * a config that could not load, an unregistered browser launcher, a missing
 * plugin, or a browser binary that would not start. `test-failure` means
 * karma launched, the browser ran QUnit, and one or more tests failed.
 *
 * Only `generate`'s retry loop acts on the distinction: a runner fault must
 * abort the run instead of burning three LLM refinements on a sound test.
 * `validate` is unaffected — it reads `VerifyResult.ok` / `failedStep` only.
 */
export type KarmaFailureClass =
  | 'test-failure'
  | 'runner-unavailable'
  // V1.3.3-3 (AM2) — karma launched, the browser launched, but a
  // project-config-shaped UI5 module dependency failed to load and karma's
  // `browserNoActivityTimeout` fired. Routed to a per-test quarantine on
  // first occurrence (V1.3.3-5). Identity-stub witnesses pin the classifier
  // surface; the implementation lands in V1.3.3-5.
  | 'module-load-failure';

/**
 * Bootstrap-failure markers — substrings matched case-insensitively, but
 * ONLY on karma's own `ERROR [launcher|config|karma-server]` lines
 * (R2.1b, AUDIT-v0.7.0 §5.3b — see {@link KARMA_OWN_ERROR_LINE_RE}).
 * Each appears only when karma aborted *before* running any test. The
 * set is deliberately small and high-confidence: a false
 * `runner-unavailable` wrongly aborts a run that should keep refining a
 * genuinely red test, whereas a missed marker only degrades to the
 * existing wasted-refinement behavior (see the bias rule on
 * {@link classifyKarmaFailure}). Each entry documents the real karma
 * output it catches; markers 1-4 were captured directly by running
 * `karma start` against broken configs, markers 5-6 follow karma's
 * documented launcher message format.
 */
const KARMA_BOOTSTRAP_MARKERS: readonly string[] = [
  // `ERROR [launcher]: Cannot load browser "Bogus": it is not registered!` —
  // a browser launcher (or other plugin) named in the config has no plugin
  // registered for it. The exact failure the V1.3-2 e2e witness seeds with
  // `browsers: ['Bogus']`.
  'it is not registered',
  // `ERROR [config]: Error in config file!` — karma could not load or
  // evaluate the karma config: a missing config file, a syntax error, or a
  // `require()` in the config that throws (e.g. a missing `karma-*` module).
  'error in config file',
  // `Server start failed ...: Error: No provider for "framework:ui5"!` — a
  // framework / reporter / launcher named in the config has no installed
  // plugin (e.g. `karma-ui5` absent).
  'no provider for',
  // `ERROR [karma-server]: Server start failed on port 9876: ...` — karma's
  // HTTP server never came up (port already in use, plugin DI failure).
  'server start failed',
  // `<Browser> failed N times (cannot start). Giving up.` — a browser
  // launcher exhausted its retries because the browser binary would not
  // start (headless Chrome not installed / not launchable). The parentheses
  // keep this from matching an unrelated QUnit assertion message.
  '(cannot start)',
  // `<Browser> crashed: ... no usable sandbox` — headless Chrome launched
  // but refused to run without a usable sandbox (Docker-as-root, locked-down
  // CI), so the karma test page never loaded. See this project's
  // e2e-real-project karma.conf.js comment on `ChromeHeadlessNoSandbox`.
  'no usable sandbox',
];

/**
 * Classify a karma {@link KarmaResult}. Pure and total — safe to call on any
 * result, though the verify pipeline only consults it when `!result.ok`.
 *
 * Heuristic (SPEC §2.10 step 3, V1.3-5; V1.3.3-5 adds the module-load
 * branch):
 *   - `exitCode < 0` → `runner-unavailable`. This is `exec.ts`'s spawn-failure
 *     contract (the karma binary itself never ran — ENOENT / permission).
 *   - `exitCode > 0` and one of karma's OWN
 *     `ERROR [launcher|config|karma-server]` lines carries a
 *     {@link KARMA_BOOTSTRAP_MARKERS} substring (line-anchored, R2.1b) →
 *     `runner-unavailable`.
 *   - `exitCode > 0` and the combined output carries a
 *     {@link KARMA_MODULE_LOAD_PATTERNS} match (the UI5 ModuleSystem
 *     load-fail line — POSITIVE evidence only, R2.1a) →
 *     `module-load-failure`. Karma launched but a project-config-shaped
 *     UI5 dependency failed to load at runtime; the LLM cannot fix this
 *     from the test-file side, so the retry-loop short-circuits on first
 *     occurrence (see `src/generation/retry-loop.ts`).
 *   - everything else → `test-failure`.
 *
 * Ordering: bootstrap > module-load > test-failure. A karma run matching
 * BOTH a bootstrap marker AND a module-load pattern is still
 * `runner-unavailable` — karma never started, so it cannot have a real
 * runtime module-load failure.
 *
 * Bias rule: when uncertain, return `test-failure`. The costs are asymmetric
 * — a false `runner-unavailable` aborts a run that should have kept refining
 * a real red test; a missed runner fault only wastes refinements and then
 * quarantines (the pre-V1.3-5 behavior). A false `module-load-failure`
 * quarantines a candidate the LLM could have fixed; a missed module-load
 * match just degrades to today's `'test-failure'` shape (3 refinements then
 * quarantine).
 */
export function classifyKarmaFailure(result: KarmaResult): KarmaFailureClass {
  if (result.exitCode < 0) return 'runner-unavailable';
  if (result.exitCode > 0 && hasBootstrapMarker(result)) {
    return 'runner-unavailable';
  }
  if (result.exitCode > 0) {
    const combined = `${result.stdout}\n${result.stderr}`;
    if (hasModuleLoadPattern(combined)) return 'module-load-failure';
  }
  return 'test-failure';
}

/**
 * R2.1(b) (AUDIT-v0.7.0 §5.3b) — a line counts as karma's OWN error line
 * only when it carries an `ERROR [launcher]` / `ERROR [config]` /
 * `ERROR [karma-server]` tag. Karma forwards browser console output and
 * QUnit assertion text into the same combined stdout (the old
 * whole-haystack substring match admitted them — the `'(cannot start)'`
 * comment above conceded the haystack contained assertion text). A
 * failing test whose message merely *contains* a marker word (e.g.
 * "no provider for cart service") must not abort the entire run as
 * `karma-unavailable`. Not `^`-anchored: karma prefixes its own lines
 * with a timestamp (`21 05 2026 20:26:59.709:ERROR [launcher]: ...`)
 * and colored output carries ANSI prefixes (stripped before matching).
 */
const KARMA_OWN_ERROR_LINE_RE = /ERROR \[(?:launcher|config|karma-server)\]/i;

function hasBootstrapMarker(result: KarmaResult): boolean {
  const stripped = `${result.stdout}\n${result.stderr}`.replace(ANSI_CSI_RE, '');
  return stripped.split(/\r?\n/).some((line) => {
    if (!KARMA_OWN_ERROR_LINE_RE.test(line)) return false;
    const lower = line.toLowerCase();
    return KARMA_BOOTSTRAP_MARKERS.some((marker) => lower.includes(marker));
  });
}

/**
 * V1.3.3-5 (AM1) — module-load-failure pattern set, narrowed by R2.1(a)
 * (AUDIT-v0.7.0 §5.3a) to POSITIVE evidence only:
 *
 *   - `failed to load JavaScript resource: <module> - sap.ui.ModuleSystem`
 *     — UI5's `ModuleSystem` log line when a `sap.ui.define` import
 *     never resolves (the library isn't in karma-ui5's `client.libs`).
 *     Real shape captured in the cap_try Reports diagnosis
 *     (V1.3.3-DIAGNOSIS.md §Area 2).
 *
 * The original V1.3.3-5 set also matched karma's no-message-disconnect
 * line (`Disconnected, because no message in <N> ms`) on its own. That
 * signal is ambiguous, not positive: the identical disconnect fires for
 * an LLM test that hangs without calling `done()` (a classic fixable
 * bug) and for a transient CDN/DNS blip (the live cap_try quarantine in
 * AUDIT-v0.7.0 §3.1). Treating it as module-load evidence quarantined
 * candidates on the FIRST verify with a message asserting refinement is
 * futile. A disconnect ALONE now classifies `test-failure`, so the
 * candidate keeps its refinement chance; a genuine module-load failure
 * still carries the ModuleSystem line and still short-circuits.
 *
 * Pattern set is opt-in conservative — false-positive avoidance matters
 * more than false-negative avoidance.
 */
export const KARMA_MODULE_LOAD_PATTERNS: readonly RegExp[] = [
  /failed to load JavaScript resource:\s+\S+\s+-\s+sap\.ui\.ModuleSystem/i,
];

const ANSI_CSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

/**
 * V1.3.3-5 (AC3 + AH3) — true if the combined karma stdout+stderr matches
 * any {@link KARMA_MODULE_LOAD_PATTERNS}. ANSI CSI sequences are stripped
 * first so coloured terminal output (`\x1b[31m...\x1b[0m`) does not break
 * the pattern match. Pure function; AC3 takes the pre-combined string
 * (NOT `KarmaResult`) because the call site does the join exactly once.
 */
export function hasModuleLoadPattern(combinedOutput: string): boolean {
  const stripped = combinedOutput.replace(ANSI_CSI_RE, '');
  return KARMA_MODULE_LOAD_PATTERNS.some((re) => re.test(stripped));
}

/**
 * V1.3.3-5 (AC3 + AH3 + AH5) — best-effort module ID extraction from a
 * combined karma stdout+stderr. Returns the FIRST match in document order
 * (the natural non-global `.match()` behaviour) so the actionable
 * quarantine message names the first failure the user is most likely to
 * encounter. `.js` extension is stripped because UI5 module IDs are
 * canonically extension-less. ANSI CSI sequences are stripped first so
 * coloured output does not bleed into the captured ID.
 *
 * Best-effort: returns `null` if no `failed to load JavaScript resource:
 * <module> - sap.ui.ModuleSystem` line is present. Since R2.1(a) the
 * classifier fires only on that same line, so extraction normally
 * succeeds whenever the classifier does; `null` stays as a defensive
 * fallback (the capture regex is stricter than the classifier's).
 */
export function extractFailedModule(combinedOutput: string): string | null {
  const stripped = combinedOutput.replace(ANSI_CSI_RE, '');
  const match = stripped.match(
    /failed to load JavaScript resource:\s+(\S+?)(?:\.js)?\s+-\s+sap\.ui\.ModuleSystem/i,
  );
  return match !== null ? match[1] ?? null : null;
}

/**
 * R2.1(c) (AUDIT-v0.7.0 §5.3c + live §3.1) — transient-network evidence.
 * Both shapes appeared verbatim in the cap_try run-1 transcript whose
 * misclassification permanently quarantined a sound formatter test:
 *
 *   `Failed to proxy /resources/sap-ui-core.js (ENOTFOUND: getaddrinfo
 *   ENOTFOUND sdk.openui5.org)` — karma's proxy middleware could not
 *   resolve the configured UI5 CDN host (a DNS blip; the same CDN
 *   answered HTTP 200 in every other verify minutes on either side) —
 *   followed by the no-message disconnect once the test page hung
 *   without a bootstrap.
 *
 * The verify pipeline (`verifyArtifact`) consults this BEFORE the
 * failure classifier: transient evidence triggers exactly one karma
 * re-run (a karma re-run only — zero LLM calls); a second failure that
 * still carries transient evidence classifies the step
 * `runner-unavailable` — run-level and honest, never a quarantine.
 */
export const KARMA_TRANSIENT_NETWORK_PATTERNS: readonly RegExp[] = [
  /\bENOTFOUND\b/,
  /Failed to proxy/i,
];

/**
 * R2.1(c) — true if the combined karma stdout+stderr carries
 * transient-network evidence. ANSI CSI sequences are stripped first
 * (same contract as {@link hasModuleLoadPattern}); pure function over
 * the pre-combined string.
 */
export function hasTransientNetworkEvidence(combinedOutput: string): boolean {
  const stripped = combinedOutput.replace(ANSI_CSI_RE, '');
  return KARMA_TRANSIENT_NETWORK_PATTERNS.some((re) => re.test(stripped));
}

// V1.4-4 (AP2) — `libNameFor` extracted to `src/project/lib-namespace.ts`
// so both this classifier and the V1.4 `ProjectGraph` builder consume one
// source of truth. Call sites that previously imported `libNameFor` from
// `src/verify/karma.ts` now import directly from `src/project/lib-namespace.ts`.
