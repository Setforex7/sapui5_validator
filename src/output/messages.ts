/**
 * V1.2-4 (Feature 2 — User-friendly error messages). Single source of truth
 * for the human-readable text the CLI writes to stderr per `ExitReason` kind.
 *
 * Why a central module:
 *   - Before V1.2-4, [src/cli.ts](../cli.ts) wrote a generic
 *     `exit reason: <kind>` line for every non-success exit and bolted
 *     bespoke follow-up text onto two kinds (`missing-claude`,
 *     `rate-limited`). Adding a third or fourth bespoke handler would have
 *     spread the surface across the CLI without any one place to audit.
 *   - The unit test [test/unit/error-messages.test.ts](../../test/unit/error-messages.test.ts)
 *     pins every variant's text. New `ExitReason` variants must declare a
 *     message here; the `switch`'s exhaustiveness check (the `never` return
 *     on `default`) makes the compiler enforce that.
 *
 * Audit log vs. stderr split (per V1.2-PLAN.md Feature 2 brief):
 *   - The typed Error classes carry the technical detail (call id, exit
 *     code, raw paths). Those messages flow into the audit log via the
 *     `AuditingRunner` and into `report.json`'s `exitReason.lastError` /
 *     reverted-fix `reason` strings. They are NOT what V1.2-4 changes the
 *     most.
 *   - This module governs what a non-technical user sees on stderr after a
 *     non-success exit. The accessible explanation comes first; the
 *     suggested next action follows; technical detail (paths, ids, lengths)
 *     stays out by default and is appended only under `--verbose` for the
 *     three rate-limited / error / malformed-output kinds where the inner
 *     detail materially helps debugging.
 */

import { MISSING_CLAUDE_MESSAGE } from '../claude/availability.js';
import { TS_REFUSAL_MESSAGE } from '../project/ts-guard.js';
import type { ExitReason } from '../types.js';
import { stripControl } from './strip-control.js';

export interface ExitMessageOptions {
  /**
   * When `true`, append the `Technical detail: <inner>` suffix to those
   * variants whose typed-error message helps a power user debug. When
   * omitted/`false`, only the accessible message is emitted.
   */
  readonly verbose?: boolean;
}

/**
 * Render the human-readable stderr message for an `ExitReason`. Returns
 * `null` for `success` — the caller suppresses the stderr write entirely
 * rather than emitting an empty line.
 *
 * The text intentionally does not include a trailing newline; the caller
 * (`process.stderr.write(... + '\n')`) controls line termination so other
 * formatting consumers can wrap the string differently.
 */
export function formatExitMessage(
  reason: ExitReason,
  options: ExitMessageOptions = {},
): string | null {
  const verbose = options.verbose === true;
  switch (reason.kind) {
    case 'success':
      return null;

    case 'unfixed-findings':
      // D5 (V1.9.1) — neutral "N remaining" wording. `reason.remaining` is
      // `revertedAutoFixes + unpreloadedUnfixed` (validate.ts): only the first
      // term was run through the 3-retry apply-and-revert loop; the second is
      // deterministic baseline-unpreloaded-libs findings that are SURFACED, never
      // fix-attempted. The old "N reverted after 3 attempts each" phrasing was
      // therefore factually false whenever `unpreloadedUnfixed > 0` (the
      // cap_try_ts run printed "4 reverted after 3 attempts each" with zero fixes
      // actually reverted). The richer reverted-vs-surfaced split is deferred.
      return (
        `Some findings could not be fixed automatically (${reason.remaining} remaining). ` +
        `See .sapui5-validator/report.json for the per-file list and reasons.`
      );

    case 'baseline-failed':
      return (
        `A project-wide baseline check (ui5lint, eslint, or karma) failed before the LLM phase could start. ` +
        `Fix the reported failures in your project and re-run. ` +
        `See .sapui5-validator/last-run/ for the failure detail.`
      );

    case 'dirty-tree':
      return (
        `Working tree has uncommitted changes; refusing to modify files. ` +
        `Commit or stash your changes, or re-run with --force to bypass this guard.`
      );

    case 'not-sapui5-project':
      // SEC-5 — `path`/`tools`/`file`/`lastError`/`message` below can carry
      // project- or LLM-derived text; strip terminal control/ANSI bytes from
      // every dynamic interpolation before it reaches stderr.
      return (
        `No SAPUI5 project detected at "${stripControl(reason.path)}". ` +
        `Check that the directory contains a ui5.yaml or webapp/manifest.json, ` +
        `or change directory to a SAPUI5 project before running.`
      );

    case 'typescript-project':
      // SPEC §2.5 verbatim text is the user-facing message.
      return TS_REFUSAL_MESSAGE;

    case 'missing-claude':
      return `The Claude CLI was not found on PATH. ${MISSING_CLAUDE_MESSAGE}`;

    case 'missing-required-tooling':
      return (
        `Required tooling is missing: ${stripControl(reason.tools.join(', '))}. ` +
        `Install the missing tools (ui5lint: \`npm i -D @ui5/linter\`; ` +
        `karma: \`npm i -D karma karma-qunit karma-chrome-launcher\`) and re-run.`
      );

    case 'karma-unavailable':
      // V1.3-5. Distinct from `missing-required-tooling` (karma not installed)
      // and `baseline-failed` (tests genuinely red): karma is installed but
      // will not start. The `verbose` flag is a no-op here — there is no inner
      // typed-error detail to append (the karma output is in the audit log).
      return (
        `The karma test runner is installed but could not start, so the ` +
        `generated tests could not be verified. This is usually a karma ` +
        `configuration error, a missing browser launcher (for example ` +
        `headless Chrome), or a missing karma plugin (for example karma-ui5). ` +
        `Confirm that \`karma start\` runs on its own in this project, then ` +
        `re-run. See .sapui5-validator/last-run/ for the karma output.`
      );

    case 'malformed-llm-output': {
      const base =
        `Claude returned output that could not be parsed after one reformat retry. ` +
        `Re-run; if the problem persists, file an issue with the saved file attached.`;
      return verbose
        ? `${base} Technical detail: raw response saved at ${stripControl(reason.file)}.`
        : base;
    }

    case 'envelope-contract-mismatch': {
      // TR-2 (V1.9.6): distinct from `malformed-llm-output` (the model's content
      // inside a well-formed envelope). Here the CLI's OUTER envelope shape drifted
      // — a version incompatibility — so the message points at the claude CLI, and
      // names the probed version so the incompatibility is attributable.
      const version =
        reason.version !== undefined
          ? `version ${stripControl(reason.version)}`
          : 'an unknown version';
      const base =
        `The installed claude CLI (${version}) returned a response whose envelope ` +
        `shape does not match what this tool expects. This is almost always a claude ` +
        `CLI version incompatibility, not a problem with your project. Update or ` +
        `reinstall the claude CLI (npm i -g @anthropic-ai/claude-code) to a supported ` +
        `version and re-run.`;
      return verbose
        ? `${base} Technical detail: raw response saved at ${stripControl(reason.file)}.`
        : base;
    }

    case 'budget-exhausted':
      return (
        `LLM call budget reached after ${reason.calls} calls. ` +
        `Increase --max-llm-calls, raise --per-check-cap, or narrow the scope ` +
        `(e.g. validate a single file) and re-run.`
      );

    case 'no-tests-template-required':
      return (
        `No existing tests were found and a starter template is required to generate tests. ` +
        `Re-run interactively on a TTY (without --json) to pick a starter template. ` +
        `See SPEC §2.4 for the no-tests state.`
      );

    case 'cancelled-by-user':
      return `Run cancelled by user.`;

    case 'rate-limited': {
      const base =
        `Run terminated due to Claude rate limit after ${reason.callsCompleted} LLM calls. ` +
        `Partial results saved to .sapui5-validator/last-run/. ` +
        `Wait for the rate limit window to reset (typically 5 minutes) and re-run.`;
      return verbose ? `${base} Technical detail: ${stripControl(reason.lastError)}` : base;
    }

    case 'error':
      // The inner `reason.message` comes from a typed Error whose `.message`
      // is now itself user-friendly (V1.2-4 row 2-8 in the inventory), so
      // inlining it stays readable for the non-verbose case. The verbose
      // flag is a no-op here — the inner message already carries the detail.
      return `Run failed: ${stripControl(reason.message)}`;

    default:
      return assertExhaustive(reason);
  }
}

function assertExhaustive(value: never): never {
  // Unreachable at runtime — the compiler refuses to call this with anything
  // other than `never`, so adding a new `ExitReason` variant without a case
  // breaks the build at the call site above.
  throw new Error(`unhandled ExitReason kind: ${JSON.stringify(value)}`);
}
