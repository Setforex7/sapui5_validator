#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Command, Option } from 'commander';
import { DEFAULT_PER_CHECK_CAP_PERCENT } from './budget/cap.js';
import { runValidate, type ValidateOptions } from './commands/validate.js';
import { runGenerate, type GenerateOptions } from './commands/generate.js';
import { BinaryRunner } from './claude/binary-runner.js';
import { probeClaudeAvailability } from './claude/availability.js';
import { lastRunDir } from './util/paths.js';
import { writeReport } from './output/report.js';
import {
  concurrencyBanner,
  formatStatusLine,
  generatedTestStatusLine,
  verificationBanner,
} from './output/human.js';
import { formatExitMessage } from './output/messages.js';
import { stripControl } from './output/strip-control.js';
import { detectCapabilities } from './output/tty.js';
import type { RunReport, StatusTag } from './types.js';

// Single source of truth for the version is package.json; reading it here keeps
// `--version` honest (CLAUDE.md "Avoid hard-coded values"). The URL resolves
// relative to this module, so it works both from dist/ and from src/ via tsx.
const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

const program = new Command();

program
  .name('sapui5-validate')
  .description(
    'Validate SAPUI5 projects and generate tests using a hybrid deterministic-plus-LLM approach.',
  )
  .version(version);

export { program };

program
  .command('validate [path]')
  .description('Validate a SAPUI5 project (or a single file when [path] is given).')
  .option('--all', 'Operate on every applicable file (ignore git-changed scope).')
  .option('--base <ref>', 'Override the comparison ref used for the changed-files scope (default: main).')
  .option('--verbose', 'Show phase output (linting / LLM review / verify).')
  .addOption(
    new Option('--max-llm-calls <N>', 'Per-run LLM call budget (SPEC §2.12).').argParser((s) => {
      const n = Number.parseInt(s, 10);
      if (!Number.isInteger(n) || n < 0) throw new Error(`--max-llm-calls must be a non-negative integer (got "${s}")`);
      return n;
    }),
  )
  .addOption(
    new Option(
      '--per-check-cap <percent>',
      'V1.2-2: per-CheckId ceiling as a percentage of --max-llm-calls (1-100, default 35). ' +
        'Prevents one check category from monopolising the budget.',
    )
      .default(DEFAULT_PER_CHECK_CAP_PERCENT)
      .argParser((s) => {
        const n = Number.parseInt(s, 10);
        if (!/^[0-9]+$/.test(s) || !Number.isInteger(n) || n < 1 || n > 100) {
          throw new Error(`--per-check-cap must be an integer in [1, 100] (got "${s}")`);
        }
        return n;
      }),
  )
  .addOption(
    new Option(
      '--concurrency <N>',
      'V1.9.7 (THR-1/THR-2): dispatch up to N semantic-check batches at once ' +
        '(default 2; use `--concurrency 1` for the sequential V1 contract). ' +
        'Only the findings-only check batches parallelise — they have no ' +
        'verify/write hazard, so unlike `generate --concurrency` there is no ' +
        'lane restriction. A run-wide rate-limit backoff drains new dispatch ' +
        'during a 429 window.',
    )
      .default(2)
      .argParser((s) => {
        const n = Number.parseInt(s, 10);
        if (!/^[0-9]+$/.test(s) || !Number.isInteger(n) || n < 1) {
          throw new Error(`--concurrency must be an integer >= 1 (got "${s}")`);
        }
        return n;
      }),
  )
  .option('--force', 'Bypass the clean-tree guard (SPEC §2.6).')
  .option('--json', 'Emit JSON to stdout instead of human-readable status lines.')
  .option('--keep-history', 'Write the audit log under runs/<timestamp>/ instead of last-run/.')
  .option(
    '--no-prompt',
    'Skip the V1.2 dynamic call-limit menu and keep the current --max-llm-calls value (CI/automation).',
  )
  .option(
    '--html',
    'Generate report.html alongside report.json when the run completes.',
  )
  .option(
    '--auto-apply-baseline-fixes',
    'V1.4-4 (AP3): apply the deterministic manifest.json fix for ' +
      'baseline-unpreloaded-libs findings directly (no LLM). Default off; ' +
      'mirrors --force / --all as an explicit opt-in for user-file mutations.',
  )
  .option(
    '--model <name>',
    'V1.9.4 (PERF-17): forward a specific model id to `claude -p` for this run ' +
      '(e.g. a cheaper model to cut cost — the single largest cost lever). ' +
      'Default: your Claude Code model (highest quality). Skips the opt-in model ' +
      'menu. NOTE: TypeScript validation/generation is static-only (no test ' +
      'execution), so a cheaper model may emit a shallow-but-compiling test the ' +
      'static checks cannot catch.',
  )
  // V1.9.8 Phase 3 — `--cache` defaults ON (the explicit `true` default below;
  // `--no-cache` opts out). Evidence-gated flip: the opt-in cold→warm real gate
  // (docs/runs/v1.9.8-phase3/) measured 17/17 hits on unchanged trees with
  // byte-identical served findings and zero stale incidents (32→15 calls,
  // ~$11.5→~$1.0 per project). A guard test pins the default.
  .option(
    '--cache',
    'V1.9.8: serve unchanged detection checks from the cross-run result cache ' +
      'under .sapui5-validator/cache/ (DEFAULT ON since 1.5.0; --no-cache ' +
      'disables). Detection calls only — fixes, generation and all verification ' +
      'are never cached. --force bypasses cache reads (fresh measurement) but ' +
      'still writes fresh entries.',
    true,
  )
  .option('--no-cache', 'Disable the detection result cache for this run.')
  .action(async (path: string | undefined, flags: Record<string, unknown>) => {
    const projectRoot = process.cwd();
    // commander's --no-prompt convention: when `--no-prompt` is passed, `flags.prompt`
    // is `false`; otherwise it is omitted/`true`. The orchestrator's `noPrompt`
    // flips that polarity to match the rest of its options.
    const options: ValidateOptions = {
      projectRoot,
      runner: new BinaryRunner({
        errorOutputDir: lastRunDir(projectRoot),
        containmentRoot: projectRoot,
      }),
      all: flags['all'] === true,
      force: flags['force'] === true,
      verbose: flags['verbose'] === true,
      json: flags['json'] === true,
      keepHistory: flags['keepHistory'] === true,
      noPrompt: flags['prompt'] === false,
      html: flags['html'] === true,
      autoApplyBaselineFixes: flags['autoApplyBaselineFixes'] === true,
      // V1.9.8 Phase 3 — the commander default is `true` (declared on the
      // option), so no-flag ⇒ true (default ON), `--no-cache` ⇒ false, and
      // the strict === true simply narrows the unknown to a boolean.
      cache: flags['cache'] === true,
      // V1.9.7 THR-1/THR-2 — bounded batch-dispatch width. commander applies the
      // `.default(2)`, so this is always a number; the guard is belt-and-braces
      // against an upstream surprise (mirrors generate's mapping, and matches the
      // commander default so a removed `.default` would not silently go sequential).
      concurrency:
        typeof flags['concurrency'] === 'number' ? (flags['concurrency'] as number) : 2,
      availabilityProbe: probeClaudeAvailability,
      // `--per-check-cap` always has a numeric default from commander, so the
      // type narrowing below is just a guard against an upstream surprise.
      perCheckCap:
        typeof flags['perCheckCap'] === 'number'
          ? (flags['perCheckCap'] as number)
          : DEFAULT_PER_CHECK_CAP_PERCENT,
      ...(typeof path === 'string' ? { path: resolve(projectRoot, path) } : {}),
      ...(typeof flags['base'] === 'string' ? { base: flags['base'] as string } : {}),
      ...(typeof flags['maxLlmCalls'] === 'number'
        ? { maxLlmCalls: flags['maxLlmCalls'] as number }
        : {}),
      // V1.9.4 PERF-17 — forward an explicit `--model` (free-form id). Absent
      // unless the user supplied one; the orchestrator then offers the opt-in
      // menu (TTY large run) or keeps the default.
      ...(typeof flags['model'] === 'string' ? { model: flags['model'] as string } : {}),
    };
    const result = await runValidate(options);
    renderResult(result.report, options.json === true, options.verbose === true);
    // R1.3 (AUDIT §5.6b): `process.exit` after a report write can truncate
    // piped stdout (the primary `--json` CI mode); `exitCode` lets Node flush.
    process.exitCode = result.exitCode;
  });

program
  .command('generate [path]')
  .description('Generate QUnit and OPA5 tests for code lacking coverage.')
  .option('--all', 'Operate on every applicable file (ignore git-changed scope).')
  .option('--base <ref>', 'Override the comparison ref used for the changed-files scope (default: main).')
  .option('--verbose', 'Show phase output (LLM generate / verify).')
  .addOption(
    new Option('--max-llm-calls <N>', 'Per-run LLM call budget (SPEC §2.12).').argParser((s) => {
      const n = Number.parseInt(s, 10);
      if (!Number.isInteger(n) || n < 0) throw new Error(`--max-llm-calls must be a non-negative integer (got "${s}")`);
      return n;
    }),
  )
  .addOption(
    new Option(
      '--concurrency <N>',
      'V1.6 / V1.9.7 (THR-1): process up to N candidates at once (default 2; ' +
        'use `--concurrency 1` for the sequential V1 contract, SPEC §2.15). ' +
        'Overlaps the slow LLM generation while a verify lane serialises ' +
        'verification. Honoured only for projects that register tests ' +
        'explicitly (sap.ui.require testsuite.qunit.html or an explicit karma ' +
        'files: list); a glob-auto project runs serially regardless of N.',
    )
      .default(2)
      .argParser((s) => {
        const n = Number.parseInt(s, 10);
        if (!/^[0-9]+$/.test(s) || !Number.isInteger(n) || n < 1) {
          throw new Error(`--concurrency must be an integer >= 1 (got "${s}")`);
        }
        return n;
      }),
  )
  .option('--force', 'Bypass the clean-tree guard (SPEC §2.6).')
  .option('--json', 'Emit JSON to stdout instead of human-readable status lines.')
  .option('--keep-history', 'Write the audit log under runs/<timestamp>/ instead of last-run/.')
  .option(
    '--no-prompt',
    'Skip the V1.2 dynamic call-limit menu and keep the current --max-llm-calls value (CI/automation).',
  )
  .option('--qunit-only', 'Generate only QUnit unit tests; skip OPA5 journeys.')
  .option('--opa5-only', 'Generate only OPA5 journeys; skip QUnit unit tests.')
  .option(
    '--auto-apply-baseline-fixes',
    'V1.4-4 (AP3): apply the deterministic manifest.json fix for ' +
      'baseline-unpreloaded-libs findings directly (no LLM). Default off; ' +
      'mirrors --force / --all as an explicit opt-in for user-file mutations.',
  )
  .option(
    '--model <name>',
    'V1.9.4 (PERF-17): forward a specific model id to `claude -p` for this run ' +
      '(e.g. a cheaper model to cut cost — the single largest cost lever). ' +
      'Default: your Claude Code model (highest quality). Skips the opt-in model ' +
      'menu. NOTE: TypeScript generation is static-only (no test execution), so ' +
      'a cheaper model may emit a shallow-but-compiling test the static checks ' +
      'cannot catch.',
  )
  .action(async (path: string | undefined, flags: Record<string, unknown>) => {
    if (flags['qunitOnly'] === true && flags['opa5Only'] === true) {
      process.stderr.write('--qunit-only and --opa5-only are mutually exclusive.\n');
      process.exitCode = 1;
      return;
    }
    const projectRoot = process.cwd();
    const json = flags['json'] === true;
    const options: GenerateOptions = {
      projectRoot,
      runner: new BinaryRunner({
        errorOutputDir: lastRunDir(projectRoot),
        containmentRoot: projectRoot,
      }),
      all: flags['all'] === true,
      force: flags['force'] === true,
      verbose: flags['verbose'] === true,
      json,
      keepHistory: flags['keepHistory'] === true,
      // commander's --no-prompt convention: `flags.prompt` is `false` only when
      // `--no-prompt` was passed; the orchestrator's `noPrompt` flips polarity.
      noPrompt: flags['prompt'] === false,
      qunitOnly: flags['qunitOnly'] === true,
      opa5Only: flags['opa5Only'] === true,
      autoApplyBaselineFixes: flags['autoApplyBaselineFixes'] === true,
      // commander applies the `.default(2)` so this is always a number; the
      // guard is belt-and-braces against an upstream surprise (and matches the
      // commander default so a removed `.default` would not silently go serial).
      concurrency:
        typeof flags['concurrency'] === 'number' ? (flags['concurrency'] as number) : 2,
      interactive: !json && process.stdin.isTTY === true,
      availabilityProbe: probeClaudeAvailability,
      ...(typeof path === 'string' ? { path: resolve(projectRoot, path) } : {}),
      ...(typeof flags['base'] === 'string' ? { base: flags['base'] as string } : {}),
      ...(typeof flags['maxLlmCalls'] === 'number'
        ? { maxLlmCalls: flags['maxLlmCalls'] as number }
        : {}),
      // V1.9.4 PERF-17 — forward an explicit `--model` (free-form id). Absent
      // unless the user supplied one; the orchestrator then offers the opt-in
      // menu (TTY large run) or keeps the default.
      ...(typeof flags['model'] === 'string' ? { model: flags['model'] as string } : {}),
    };
    const result = await runGenerate(options);
    renderResult(result.report, json, options.verbose === true);
    // R1.3 (AUDIT §5.6b): same flush rationale as the validate action.
    process.exitCode = result.exitCode;
  });

// Only drive the CLI when this module is the process entry point. Importing it
// (e.g. from unit tests) must not parse argv or exit the process.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (invokedDirectly) {
  program.parseAsync(process.argv).catch(async (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    // SEC-5 — this crash-fallback writes a typed-error message that can embed
    // LLM/project-derived text; strip terminal control/ANSI bytes here too
    // (it bypasses formatExitMessage). The raw message is kept in the report
    // below, consistent with the raw-audit-trail policy.
    process.stderr.write(`${stripControl(message)}\n`);
    // Best-effort: emit a minimal error report so CI can surface why we failed.
    const projectRoot = process.cwd();
    // LOW A: attribute the report to the command actually invoked — an
    // uncaught throw from `runGenerate` must not be mis-labelled `validate`.
    const command = process.argv[2] === 'generate' ? 'generate' : 'validate';
    const errorReport: RunReport = {
      schemaVersion: 2,
      command,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 0,
      llmCallCount: 0,
      llmCallBudget: 0,
      exitReason: { kind: 'error', message },
      exitCode: 1,
      files: [],
      generatedTests: [],
    };
    try {
      await writeReport(projectRoot, errorReport);
    } catch {
      // ignore — we are already exiting non-zero with the original error.
    }
    // R1.3 (AUDIT §5.6b): the emergency handler also writes a report; never
    // follow a report write with `process.exit`.
    process.exitCode = 1;
  });
}

function renderResult(report: RunReport, json: boolean, verbose: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  const { useColor } = detectCapabilities({ stream: process.stdout });
  if (report.command === 'validate') {
    for (const file of report.files) {
      const tag = pickValidateTag(file);
      process.stdout.write(`${formatStatusLine({ tag, file: file.file }, useColor)}\n`);
    }
  } else {
    for (const gen of report.generatedTests) {
      // V1.4-3 (AH6) `'skipped-baseline'` → 'SKIP'; R2.5 `'lint-only'` and
      // V1.9.2 (TG-REPORT) `'static-only'` render a never-executed detail. The
      // tag+detail contract lives in `generatedTestStatusLine` (output/human.ts)
      // so it is unit-tested in one place — cli.ts is trivial wiring.
      process.stdout.write(
        `${formatStatusLine(generatedTestStatusLine(gen), useColor)}\n`,
      );
    }
  }
  // V1.9 TS-V1-FW / V1.9.3 (D1) / V1.9.9 — surface the run-level verification
  // depth on a TS run so the user knows the test suite was NOT executed (karma
  // is never run for TypeScript — the never-build firewall) AND whether `tsc`
  // actually ran. Command-agnostic since V1.9.9: `generate` accepts tests on the
  // same static-only lane and now sets the same marker (generate.ts), so its
  // runs print the same honest banner. The banner text lives in
  // `verificationBanner` (output/human.ts), the single tested home, so cli.ts is
  // trivial wiring: it writes whatever the marker maps to. A `'lint-only'` run
  // (tsc skipped) therefore still prints an honest banner — it can never be
  // silently dropped. Stdout, before the exit message; `undefined` (a JS run)
  // writes nothing.
  const verifBanner = verificationBanner(report.verification);
  if (verifBanner !== undefined) {
    process.stdout.write(`${verifBanner}\n`);
  }
  // V1.9.7 (THR-1) — surface the EFFECTIVE parallel dispatch width the run used
  // (from `report.concurrency`, already downgraded for a non-lane-safe generate
  // project). The banner text lives in `concurrencyBanner` (output/human.ts), the
  // single tested home, so cli.ts is trivial wiring. Silent at K=1 / absent
  // (banner returns undefined) — a sequential run's stdout is byte-unchanged.
  const concBanner = concurrencyBanner(report.concurrency);
  if (concBanner !== undefined) {
    process.stdout.write(`${concBanner}\n`);
  }
  // V1.2-4: single per-ExitReason rendering path. `formatExitMessage`
  // returns `null` on success (no stderr write at all); every other kind
  // produces a human-friendly explanation + suggested action. The verbose
  // flag adds technical detail for the three kinds where the inner detail
  // is useful (rate-limited / malformed-llm-output / error).
  const exitMessage = formatExitMessage(report.exitReason, { verbose });
  if (exitMessage !== null) {
    process.stderr.write(`${exitMessage}\n`);
  }
}

function pickValidateTag(file: RunReport['files'][number]): StatusTag {
  if (file.revertedFixes.length > 0) return 'FAIL';
  if (file.appliedFixes.length > 0) return 'FIX';
  if (file.findings.length === 0) return 'OK';
  return 'SKIP';
}
