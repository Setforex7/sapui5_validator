import type { SinonDialect } from './project/sinon-dialect.js';

/**
 * The seven SPEC §2.8 LLM-driven semantic checks. The registry in
 * [src/checks/index.ts](checks/index.ts) is built from this exact list.
 */
export type SemanticCheckId =
  | 'no-direct-dom'
  | 'no-sync-odata'
  | 'missing-teardown'
  | 'missing-i18n'
  | 'manifest-component-drift'
  | 'globals-in-views'
  | 'missing-test-coverage';

/**
 * Sentinel ids for SPEC §2.3 baseline failures funnelled through the same
 * apply-and-verify fix loop as semantic findings. They are NOT registered in
 * [src/checks/index.ts](checks/index.ts) — they cannot be produced by an
 * LLM check, only by the orchestrator's baseline collector. The verify step
 * that produced the failure determines the id (ui5lint → `baseline-ui5lint`,
 * etc.).
 */
export type BaselineCheckId =
  | 'baseline-ui5lint'
  | 'baseline-eslint'
  | 'baseline-karma'
  /**
   * V1.4-3 — deterministic baseline check (no LLM) that detects controller
   * `sap.ui.define` imports whose top-level library is not declared in
   * `webapp/manifest.json`'s `sap.ui5.dependencies.libs` AND not overridden
   * in karma.conf.js's `client.libs`. Real implementation lands in V1.4-4
   * along with a manifest-only auto-fix on `--auto-apply-baseline-fixes`.
   * Joins `BASELINE_CHECK_IDS` (NOT `SEMANTIC_CHECK_IDS`) because the
   * orchestrator invokes it directly, mirroring `baseline-ui5lint` /
   * `baseline-eslint` / `baseline-karma`.
   */
  | 'baseline-unpreloaded-libs';

export type CheckId = SemanticCheckId | BaselineCheckId;

export const SEMANTIC_CHECK_IDS = [
  'no-direct-dom',
  'no-sync-odata',
  'missing-teardown',
  'missing-i18n',
  'manifest-component-drift',
  'globals-in-views',
  'missing-test-coverage',
] as const satisfies readonly SemanticCheckId[];

export const BASELINE_CHECK_IDS = [
  'baseline-ui5lint',
  'baseline-eslint',
  'baseline-karma',
  'baseline-unpreloaded-libs',
] as const satisfies readonly BaselineCheckId[];

export const CHECK_IDS = [
  ...SEMANTIC_CHECK_IDS,
  ...BASELINE_CHECK_IDS,
] as const satisfies readonly CheckId[];

/**
 * Whether a finding came from the LLM-driven check registry (`'check'`) or
 * from the SPEC §2.3 baseline verify pre-pass (`'baseline'`). Persisted on
 * Finding / AppliedFixRecord / RevertedFixRecord so report.json consumers
 * can distinguish "pre-existing project debt the LLM fixed" from "issue the
 * LLM flagged and then fixed". REPORT_SCHEMA_VERSION = 2 reflects this.
 */
export type FindingSource = 'check' | 'baseline';

export interface FixProposal {
  newFileContent: string;
}

export interface BaseFinding {
  checkId: CheckId;
  file: string;
  line?: number;
  message: string;
  source: FindingSource;
  /**
   * V1.9.8 Phase 2 — present (always `true`) IFF the finding was served from
   * the cross-run detection cache (`validate --cache`) instead of a live LLM
   * call. Stamped at SERVE time — never stored in cache entries, so the
   * populating run's report carries no marker. Moves together with the
   * run-level `RunReport.cache` counters: `writeReport` refuses a report with
   * markers but no counters (the V1.9.3-D1 honesty rule). Additive optional —
   * `schemaVersion` stays `2`.
   */
  cached?: true;
}

export type Finding =
  | (BaseFinding & { proposedFix: FixProposal })
  | (BaseFinding & { proposedFix: null; explanation: string });

export type Phase = 'linting' | 'llm-review' | 'verify';

export type StatusTag = 'OK' | 'FIX' | 'GEN' | 'SKIP' | 'FAIL';

export type ExitReason =
  | { kind: 'success' }
  | { kind: 'unfixed-findings'; remaining: number }
  | { kind: 'baseline-failed' }
  | { kind: 'dirty-tree' }
  | { kind: 'not-sapui5-project'; path: string }
  | { kind: 'typescript-project' }
  | { kind: 'missing-claude' }
  | { kind: 'missing-required-tooling'; tools: readonly string[] }
  /**
   * V1.3-5 (Session V1.3-5): `generate` aborted because the karma test runner
   * is installed but could not run — a karma config error, a missing browser
   * launcher, or a missing plugin. Distinct from `missing-required-tooling`
   * (karma not installed at all) and `baseline-failed` (the project's tests
   * are genuinely red). Bare — no payload: the karma stderr is already in the
   * audit log under `last-run/verify/` — written by `wrapVerifyFnWithAudit`
   * on the retry-loop path, or by the V1.3-6 unconditional baseline probe
   * directly on the pre-flight path.
   */
  | { kind: 'karma-unavailable' }
  | { kind: 'malformed-llm-output'; file: string }
  /**
   * TR-2 (V1.9.6): the `claude -p --output-format json` OUTER envelope did not
   * match the expected contract (valid JSON, wrong shape) — a CLI-version /
   * contract drift, NOT malformed model output (`malformed-llm-output`, which
   * is the model's content inside a well-formed envelope). Distinct so the user
   * sees a CLI-incompatibility message, and so the reformat retry is never spent
   * on drift (BinaryRunner skips it). `version` is the probed `claude --version`
   * (from the availability probe; absent if unprobed); `file` is the saved raw
   * envelope dump.
   */
  | { kind: 'envelope-contract-mismatch'; version?: string; file: string }
  | { kind: 'budget-exhausted'; calls: number }
  | { kind: 'no-tests-template-required' }
  | { kind: 'cancelled-by-user' }
  /**
   * V1.2-3 (Feature 1, Session V1.2-3): the SPEC §2.12 rate-limit backoff
   * schedule (1s / 4s / 16s) was exhausted by `withRateLimitBackoff`'s
   * `throwOnExhaustion` callback and the validate orchestrator caught the
   * resulting `RateLimitExhaustedError`. `callsCompleted` mirrors
   * `report.llmCallCount` at the moment of the throw so a `--resume` flag
   * (V1.3+) can pick up from there; `lastError` carries the
   * `RateLimitExhaustedError.message` for the audit log / human message.
   */
  | { kind: 'rate-limited'; callsCompleted: number; lastError: string }
  | { kind: 'error'; message: string };

export interface AppliedFixRecord {
  checkId: CheckId;
  source: FindingSource;
}

export interface RevertedFixRecord {
  checkId: CheckId;
  source: FindingSource;
  reason: string;
}

export interface ReportFileEntry {
  file: string;
  findings: Finding[];
  appliedFixes: AppliedFixRecord[];
  revertedFixes: RevertedFixRecord[];
}

export interface ReportGeneratedTest {
  sourceFile: string;
  testFile: string;
  /**
   * V1.3-3 — `'no-output'` distinguishes a generation that never produced a
   * file on disk (LLM returned no parseable content / the process was killed)
   * from `'quarantined'`, which always names a real file moved under
   * `webapp/test/_failing/`. A new enum value on an existing field is purely
   * additive, so `RunReport.schemaVersion` stays `2` (same precedent as the
   * optional `cappedChecks` field).
   *
   * V1.4-3 — `'skipped-baseline'` joins the union: a controller skipped
   * before any generate-loop LLM call because the V1.4-4
   * `baseline-unpreloaded-libs` check found an unfixed module-load gap
   * touching the controller's imports. No file is written to disk for
   * skipped controllers. Maps to `StatusTag = 'SKIP'` in the cli status
   * line (case wiring lands in V1.4-4). Additive — `schemaVersion`
   * stays `2`.
   */
  status: 'passed' | 'quarantined' | 'no-output' | 'skipped-baseline';
  /**
   * R2.5 (AUDIT §5.7e) — verification-depth marker. Records that a `passed`
   * entry was verified statically but never EXECUTED by karma:
   *   - `'lint-only'` — OPA5 journeys are not auto-registered (SPEC §2.1), so
   *     outside `glob-auto` discovery the whole-suite karma run cannot reach
   *     them; a bare `passed` would overstate what was verified.
   *   - `'static-only'` (V1.9.2, TG-REPORT / FS-8) — a generated TypeScript
   *     QUnit test, accepted on the TS static lane (ui5lint + `tsc --noEmit` +
   *     eslint) plus the shape check. Karma is never run for TypeScript (the
   *     never-build firewall), so "this test passes at runtime" is not proven.
   * Absent on JS QUnit entries (registered before verify, so karma executes
   * them) and on `glob-auto` journeys. Additive optional —
   * `RunReport.schemaVersion` stays `2` (same precedent as `cappedChecks`).
   */
  verification?: 'lint-only' | 'static-only';
  /**
   * V1.3.2-3 — count of refinement attempts whose karma feedback was
   * truncated by `prepareFeedbackForPrompt` before being embedded in the
   * `claude -p` prompt (Bug A: refinement-prompt overflow). Absent when
   * truncation never fired; additive so `RunReport.schemaVersion` stays `2`.
   */
  refinementTruncations?: number;
  /**
   * V1.3.2-3 — structured classification for quarantine/no-output entries.
   * `phase` distinguishes a kill during the initial-content LLM call from a
   * kill during a refinement attempt; `message` carries the human-readable
   * reason. Absent on `'passed'` entries.
   */
  quarantineReason?: {
    /**
     * V1.3.3-3 (AM2) — `'module-load'` joins `'initial'` and
     * `'refinement'`: the karma step classified `'module-load-failure'`
     * (post-bootstrap UI5 module dependency missing from karma's
     * `client.libs`), so the retry-loop short-circuits on first
     * occurrence — no refinement is attempted because the LLM cannot
     * fix a project karma-config gap from the test-file side
     * (V1.3.3-5). Additive on the V1.3.2-3 enum — `schemaVersion`
     * stays `2`.
     */
    phase: 'initial' | 'refinement' | 'module-load';
    message: string;
  };
}

/**
 * V1.9.4 PERF-1 — run-level sum of the per-call envelope `usage` across every
 * `claude -p` call in a run. Token counts are the PRIMARY spend metric (cost is
 * a labelled estimate; see {@link RunReport.totalCostUsd}). The total billed
 * input for the run is `inputTokens + cacheReadTokens + cacheCreationTokens`
 * (the uncached `inputTokens` is not the total — diagnosis §6), so all four are
 * carried. Empty/absent when no call reported usage (additive optional —
 * `RunReport.schemaVersion` stays `2`).
 */
export interface RunUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface RunReport {
  schemaVersion: 2;
  command: 'validate' | 'generate';
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  llmCallCount: number;
  llmCallBudget: number;
  exitReason: ExitReason;
  exitCode: number;
  files: ReportFileEntry[];
  generatedTests: ReportGeneratedTest[];
  /**
   * V1.2-2 — per-category cap accounting. Map from `CheckId` → count of LLM
   * calls that were skipped because the category had reached its
   * `--per-check-cap` ceiling. Empty / absent keys mean "no skips for that
   * category". Optional so v1/v2 readers that ignore unknown fields still
   * accept the report without a schema bump (the field is purely additive).
   */
  cappedChecks?: Partial<Record<CheckId, number>>;
  /**
   * V1.3.2-4 — sinon dialect detected for the project (Bug B). Set on
   * `generate` runs after `detectSinonDialect`. Absent on `validate` runs
   * and on `generate` runs that returned before detection fired (e.g.
   * ts-guard failure, git-clean failure, missing-claude probe). Additive —
   * `schemaVersion` stays `2` (same precedent as `cappedChecks`).
   */
  sinonDialect?: SinonDialect;
  /**
   * R2.2 (AUDIT §5.1) — outcome of the single post-fix karma suite gate on
   * `validate` runs. Present only when at least one fix was applied (absent
   * on fix-free runs, on `generate` runs, and on pre-R2.2 reports). Additive
   * optional — `schemaVersion` stays `2` (same precedent as `cappedChecks`).
   *
   *   - `passed`   — the in-scope qunit suite ran green after the fix phase.
   *   - `failed`   — the suite ran red; every applied fix was reverted to its
   *                  byte-exact pre-fix content (per-file outcomes below).
   *   - `not-run`  — the gate could not run (no qunit tests in scope, karma
   *                  runner unavailable, or the gate errored); applied fixes
   *                  are RETAINED on lint-only verification and `reason` says
   *                  why — the report never claims suite verification that
   *                  did not happen.
   */
  postFixSuite?: PostFixSuiteOutcome;
  /**
   * V1.9 TS-V1-FW — run-level verification-depth marker for a `validate` run on
   * a TypeScript project, which **never executes karma** (the never-build
   * firewall: karma-running a `.ts` would transpile it via the project's babel
   * config = arbitrary code execution). Two honest depths, gated on whether
   * `tsc` actually ran (V1.9.3 D1):
   *   - `'static-only'` — the project ships its own `typescript`, so the static
   *     lane ran `ui5lint` + `tsc --noEmit` + config-gated `eslint`.
   *   - `'lint-only'` — the project ships no own `typescript` (`tscEnabled=false`
   *     — `hasProjectTypeScript` checks installed `node_modules` only), so
   *     `tsc --noEmit` was SKIPPED and the lane narrowed to `ui5lint`
   *     (+ config-gated `eslint`). The marker must NOT claim "type-checked" here.
   * Either way "this fix did not break a test" is NOT runtime-verified for
   * TypeScript: a documented V1.9 limit, surfaced on the CLI and here so the
   * report never overstates what was verified. Absent on JS runs (which run
   * karma) and on pre-V1.9 reports. Additive optional — `schemaVersion` stays
   * `2` (same precedent as `cappedChecks` / `postFixSuite`; the per-test
   * `ReportGeneratedTest.verification` already carries both values).
   */
  verification?: 'static-only' | 'lint-only';
  /**
   * V1.9.4 PERF-1 — summed LLM token usage across the run (the cost-observability
   * substrate; tokens are the primary metric). Present only when at least one
   * `claude -p` call reported a `usage` block — absent on fix-free / LLM-free
   * runs and on pre-V1.9.4 reports. Additive optional — `schemaVersion` stays
   * `2` (same precedent as `cappedChecks` / `sinonDialect` / `postFixSuite` /
   * `verification`).
   */
  usage?: RunUsageTotals;
  /**
   * V1.9.4 PERF-1 — summed `total_cost_usd` across the run, an ESTIMATE (the
   * envelope's cost is "not for billing" and may be null under a Max
   * subscription — diagnosis §6). Present only when at least one call reported a
   * numeric cost; absent otherwise (never a zero placeholder, so a consumer can
   * tell "no cost data" from "$0"). Additive optional — `schemaVersion` stays
   * `2`.
   */
  totalCostUsd?: number;
  /**
   * V1.9.4 PERF-17 — the non-default model the run was asked to use (the
   * free-form id from `--model` or the opt-in model menu), recorded so a run's
   * verification depth is auditable: a cheaper model's output is still gated by
   * verify-then-accept, but on the TS static-only lane a shallow-but-compiling
   * test can slip the static gate, so which model produced a run's tests is
   * worth knowing. ABSENT when the run used the Claude Code default (no
   * `--model`) — `src/` pins no id and the report never invents one. Additive
   * optional — `schemaVersion` stays `2`.
   */
  model?: string;
  /**
   * V1.9.4 PERF-12 — run-level count of refinement prompts whose embedded file
   * content was byte-capped (`REFINE_CONTENT_CAP_BYTES`) before being sent to the
   * model. A truncated fix prompt shows the model a PARTIAL view of the file (it
   * is asked to return the corrected FULL file), so this is a verification-depth
   * signal: it marks fixes attempted against degraded context. The matching
   * per-occurrence `[WARN]` reaches stderr, but on a `--json` run that stream may
   * be unread — so the run-level count is surfaced here too (parity with the
   * generate-side `ReportGeneratedTest.refinementTruncations`). Present only when
   * at least one fix prompt truncated; absent otherwise (never a zero
   * placeholder) and on pre-V1.9.4 reports. Additive optional — `schemaVersion`
   * stays `2`.
   */
  contentTruncations?: number;
  /**
   * TR-2 (V1.9.6) — the `claude` CLI version this run used, captured from the
   * availability probe (`claude --version`) alongside the ui5lint/eslint/karma
   * tool versions. The `claude -p --output-format json` envelope is an
   * unversioned external contract; recording the version makes an envelope-shape
   * drift attributable (an `envelope-contract-mismatch` exit is tied to a known
   * CLI version, not read as "our bug"). ABSENT when no availability probe ran
   * (the unit-test fake omits it) and on pre-V1.9.6 reports. Additive optional —
   * `schemaVersion` stays `2` (same precedent as `usage` / `model`).
   */
  claudeVersion?: string;
  /**
   * V1.9.8 — run-level accounting for the cross-run detection result cache
   * (`validate --cache`). Present IFF the run had the cache enabled (absent
   * on uncached runs and on pre-V1.9.8 reports). `hits` = detection lookups
   * served from the cache (no LLM call, no budget, no cap increment);
   * `misses` = lookups NOT served (dispatched live, cap-skipped, or
   * `--force`-bypassed — a forced run bypasses reads but still writes).
   * This is the run-level counter the per-finding `cached` marker (Phase 2)
   * must move together with (the V1.9.3-D1 honesty rule); `servedRunIds` is
   * reserved for that phase's audit hit-records. Additive optional —
   * `schemaVersion` stays `2` (same precedent as `cappedChecks` / `usage` /
   * `claudeVersion`).
   */
  cache?: {
    hits: number;
    misses: number;
    servedRunIds?: string[];
  };
  /**
   * V1.9.7 (THR-1) — the EFFECTIVE dispatch width the run actually used: for
   * `validate` the batch-phase concurrency (`--concurrency`, no lane
   * restriction); for `generate` the concurrency AFTER any lane-safety
   * downgrade (a glob-auto/unknown project is forced back to 1 even when a
   * higher `--concurrency` was requested — see `generate.ts` `effectiveConcurrency`).
   * So this is what parallelism the run truly had, never the raw request. The
   * default is 2 (THR-1); `--concurrency 1` restores the sequential V1 contract.
   * Present only on runs that reached the check/candidate phase (absent on
   * early-exit paths that dispatch nothing). Additive optional — `schemaVersion`
   * stays `2` (same precedent as `claudeVersion` / `usage` / `model`).
   */
  concurrency?: number;
}

/**
 * R2.2 — see {@link RunReport.postFixSuite}. `revertFailedFiles` is the
 * never-silent contract for partial revert failure: a file listed there
 * still contains the unverified fix on disk (its `appliedFixes` entries are
 * deliberately NOT moved to `revertedFixes`), and the run exits non-zero
 * with an `error` reason naming it.
 */
export interface PostFixSuiteOutcome {
  status: 'passed' | 'failed' | 'not-run';
  /** Why the gate did not run, or the failing suite's feedback head. */
  reason?: string;
  /** On `failed`: project-relative files restored byte-exact (sorted). */
  revertedFiles?: string[];
  /** On `failed`: files whose restore failed — fix still on disk (sorted). */
  revertFailedFiles?: string[];
}
