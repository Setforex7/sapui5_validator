import pc from 'picocolors';
import type { Phase, ReportGeneratedTest, StatusTag } from '../types.js';
import { stripControl } from './strip-control.js';

export interface StatusLine {
  tag: StatusTag;
  file: string;
  detail?: string;
}

/**
 * V1.9.2 (TG-REPORT / FS-8) — the never-silent-green detail string for a
 * generated test whose `passed` was NOT a karma execution. `'lint-only'`
 * (OPA5 journeys) and `'static-only'` (a TypeScript QUnit test verified by
 * ui5lint + `tsc --noEmit` + eslint, never executed) each render a parenthetical
 * so the CLI line cannot read as a fully-executed pass. Anything else (a real
 * karma-executed pass, or a non-pass status) → no detail. The single tested home
 * for this mapping; `cli.ts` only wires it via {@link generatedTestStatusLine}.
 */
export function verificationDetail(
  verification: 'lint-only' | 'static-only' | undefined,
): string | undefined {
  switch (verification) {
    case 'lint-only':
      return '(lint-only — not executed by karma)';
    case 'static-only':
      return '(static-only — type-checked + linted, not executed by karma)';
    default:
      return undefined;
  }
}

/**
 * V1.9 TS-V1-FW / V1.9.3 (D1) — the run-level verification-depth banner for a
 * `validate` run (the {@link import('../types.js').RunReport.verification}
 * marker). Returns the honest one-line banner for the marker (no trailing
 * newline — the caller adds it), or `undefined` for a JS run (no marker).
 *
 *   - `'static-only'` (tsc ran) claims the full static check (ui5lint +
 *     `tsc --noEmit` + eslint).
 *   - `'lint-only'` (tsc was SKIPPED — the project ships no own `typescript`)
 *     claims only ui5lint and must NOT mention `tsc --noEmit`.
 *
 * Centralised here so the run-level banner is unit-tested in one place and
 * `cli.ts` is trivial wiring — it writes whatever this returns, so a
 * `'lint-only'` run can never silently DROP the banner (the V1.9.3 D1 trap: a
 * `=== 'static-only'` guard in `cli.ts` would have emitted nothing once the
 * marker became `'lint-only'`). Both lines record that karma was never run.
 */
export function verificationBanner(
  verification: 'lint-only' | 'static-only' | undefined,
): string | undefined {
  switch (verification) {
    case 'static-only':
      return (
        'verification: static-only — TypeScript project verified by ' +
        'ui5lint + tsc --noEmit + eslint; karma not run (never-build ' +
        'firewall), so tests were not executed.'
      );
    case 'lint-only':
      return (
        'verification: lint-only — TypeScript project linted by ui5lint ' +
        '(tsc not run: no project typescript); karma not run (never-build ' +
        'firewall), so tests were not executed.'
      );
    default:
      return undefined;
  }
}

/**
 * V1.9.7 (THR-1) — one run-level line stating the EFFECTIVE parallel dispatch
 * width (the value on {@link RunReport.concurrency}: `validate`'s batch degree,
 * or `generate`'s degree AFTER any lane-safety downgrade). Returns `undefined`
 * when the run was sequential (K ≤ 1) or the field is absent, so a serial run's
 * output stays byte-identical to the pre-THR-1 behaviour — the caller writes the
 * line only when this is defined (mirrors {@link verificationBanner}). Kept here
 * so the exact wording is unit-tested in one place; cli.ts is trivial wiring.
 */
export function concurrencyBanner(concurrency: number | undefined): string | undefined {
  if (concurrency === undefined || concurrency <= 1) return undefined;
  return (
    `concurrency: ${concurrency} — dispatched up to ${concurrency} LLM calls at ` +
    `once (use --concurrency 1 for sequential).`
  );
}

/**
 * V1.9.2 (TG-REPORT) — the {@link StatusLine} for one `report.generatedTests`
 * entry: `'GEN'` (passed) / `'SKIP'` (skipped-baseline) / `'FAIL'` (quarantined
 * / no-output), plus the verification-depth `detail` (passed entries only).
 * Centralised here so the tag+detail contract is unit-tested in one place and
 * `cli.ts` is trivial wiring (it cannot regress the detail independently).
 */
export function generatedTestStatusLine(gen: ReportGeneratedTest): StatusLine {
  const tag: StatusTag =
    gen.status === 'passed'
      ? 'GEN'
      : gen.status === 'skipped-baseline'
        ? 'SKIP'
        : 'FAIL';
  const detail =
    gen.status === 'passed' ? verificationDetail(gen.verification) : undefined;
  return { tag, file: gen.testFile, ...(detail !== undefined ? { detail } : {}) };
}

export interface PhaseLine {
  file: string;
  phase: Phase;
  durationMs?: number;
  detail?: string;
}

const TAG_WIDTH = 6;

export function formatStatusLine(line: StatusLine, useColor: boolean): string {
  const tag = paintTag(line.tag, useColor);
  const padded = padTag(tag, line.tag.length);
  // SEC-5 — `file`/`detail` can carry LLM/project-derived text; neutralise
  // terminal control/ANSI bytes before writing to the TTY.
  const file = stripControl(line.file);
  const detail = line.detail ? `  ${stripControl(line.detail)}` : '';
  return `${padded} ${file}${detail}`;
}

export function formatPhaseLine(line: PhaseLine, useColor: boolean): string {
  const phase = useColor ? pc.dim(line.phase) : line.phase;
  const duration =
    typeof line.durationMs === 'number' ? `  (${line.durationMs}ms)` : '';
  // SEC-5 — same control-byte stripping for the verbose phase line.
  const file = stripControl(line.file);
  const detail = line.detail ? `  ${stripControl(line.detail)}` : '';
  return `  ${phase}  ${file}${duration}${detail}`;
}

/**
 * V1.3.1-4 — a phase-level progress line for `--verbose` output. {@link
 * PhaseLine} is per-file: it carries a `file` and a fixed-enum {@link Phase}.
 * A baseline phase — batched lint, the karma probe — is a whole-run step with
 * no single file, so it gets its own free-form shape rather than contorting
 * `PhaseLine`. Plain text by design: progress output goes to stderr and SPEC
 * §2.17 disables color off a TTY.
 */
export interface PhaseProgress {
  /** Free-form phase label, e.g. `'baseline lint'` or `'baseline karma'`. */
  readonly phase: string;
  /** The status message, e.g. `'linting 4 in-scope files…'` or `'done'`. */
  readonly message: string;
  /** Optional elapsed time in ms, rendered as `  (123ms)`. */
  readonly durationMs?: number;
}

export function formatPhaseProgress(line: PhaseProgress): string {
  const duration =
    typeof line.durationMs === 'number' ? `  (${line.durationMs}ms)` : '';
  return `  ${line.phase}  ${line.message}${duration}`;
}

function paintTag(tag: StatusTag, useColor: boolean): string {
  const text = `[${tag}]`;
  if (!useColor) return text;
  switch (tag) {
    case 'OK':
      return pc.green(text);
    case 'FIX':
      return pc.cyan(text);
    case 'GEN':
      return pc.blue(text);
    case 'SKIP':
      return pc.yellow(text);
    case 'FAIL':
      return pc.red(text);
  }
}

function padTag(rendered: string, plainLength: number): string {
  const pad = Math.max(0, TAG_WIDTH - (plainLength + 2));
  return rendered + ' '.repeat(pad);
}
