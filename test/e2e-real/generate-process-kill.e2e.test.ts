/**
 * V1.9.6 (TR-1) — the OVERSIZED-SEED STDIN TRANSPORT witness (generate path).
 * Re-scoped at the Phase 4 real gate from the retired B1 argv-guard `-2` witness.
 *
 * History (mirrors `process-kill.e2e.test.ts`): pre-TR-1, a seed large enough to
 * push the assembled QUnit generator prompt past `CLAUDE_ARGV_LIMIT` (32,500
 * UTF-16 units) was refused by the pre-spawn argv guard with the synthetic
 * `exitCode: -2` — no spawn, and (per R1.2) surfaced as a `no-output`
 * generated-test entry with a non-zero exit, consuming no budget.
 *
 * TR-1 (V1.9.6) moved the prompt OFF argv onto the child's stdin, so a large
 * embedded source body no longer inflates the command line. The seed below is
 * sized just OVER the historical 32,500-unit ceiling (so pre-TR-1 it WOULD have
 * been argv-killed) but no larger — a full ~1 MB seed now makes a real ~320k-token
 * LLM call on every `test:e2e-real` run (pre-TR-1 it was free, argv-killed), so
 * this witness deliberately uses the smallest seed that still proves the
 * transport, keeping the suite cheap. Post-TR-1 the seed FLOWS via stdin, reaches
 * the model, and is generated against normally (observed: a `passed` test).
 *
 * Contract pinned here (the post-transport acceptance witness):
 *
 *     The oversized controller is NOT pre-spawn argv-killed (no `exitCode: -2`
 *     capture): its prompt flows via stdin, is processed by the model, and
 *     yields a real generated-test entry — NOT the `no-output` argv-guard
 *     refusal outcome.
 *
 * The genuine real-kill `exitCode: -1` path stays pinned by
 * `process-kill-real.e2e.test.ts` (R4.3).
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  E2E_REAL_ENABLED,
  createGenerateSandbox,
  type CliRunResult,
  type GenerateSandbox,
} from './_shared.js';

const OVERSIZED_REL = 'webapp/controller/Oversized.controller.js';
const RUN_TIMEOUT_MS = 12 * 60_000;

/**
 * ~64 KB controller — comfortably past the historical 32,500-UTF-16-unit argv
 * ceiling once inlined into the QUnit generator prompt (so pre-TR-1 the B1 guard
 * would have refused it with `-2`), but far short of the model's context limit,
 * so post-TR-1 it flows via stdin and is generated against cheaply (~16k tokens,
 * not the ~320k a 1 MB seed would cost every run). The structure is a bare
 * `Controller.extend` with comment filler, unchanged from the original seed.
 */
function oversizedController(): string {
  const filler = 'x'.repeat(1024);
  const lines: string[] = [
    'sap.ui.define([',
    '  "sap/ui/core/mvc/Controller"',
    '], function (Controller) {',
    '  "use strict";',
    '  // Oversized controller seed for the generate stdin-transport witness.',
    '  // Each comment line below is ~1KB; the file totals ~64 KB — over the',
    '  // historical 32,500-unit CLAUDE_ARGV_LIMIT (so pre-TR-1 the assembled',
    '  // prompt would have been argv-refused with -2), now carried via stdin.',
  ];
  for (let i = 0; i < 64; i += 1) lines.push(`  // ${filler}`);
  lines.push('  return Controller.extend("e2e.real.project.controller.Oversized", {');
  lines.push('  });');
  lines.push('});');
  return lines.join('\n') + '\n';
}

let sandbox: GenerateSandbox | null = null;
let runResult: CliRunResult | null = null;

beforeAll(async () => {
  if (!E2E_REAL_ENABLED) return;
  sandbox = createGenerateSandbox('sapui5-gen-killproc-');
  writeFileSync(sandbox.path(OVERSIZED_REL), oversizedController(), 'utf8');
  runResult = await sandbox.run([
    'generate',
    OVERSIZED_REL,
    '--qunit-only',
    '--force',
  ]);
}, RUN_TIMEOUT_MS);

afterAll(() => {
  sandbox?.remove();
  sandbox = null;
  runResult = null;
});

/** True when an `llm-error-*.txt` capture recorded the B1 argv-guard
 * refusal (`exitCode: -2`, stamped before any spawn). */
function guardRefusalObserved(): boolean {
  if (sandbox === null) return false;
  const lastRun = sandbox.path('.sapui5-validator', 'last-run');
  let names: string[];
  try {
    names = readdirSync(lastRun);
  } catch {
    return false;
  }
  return names
    .filter((n) => n.startsWith('llm-error-') && n.endsWith('.txt'))
    .some((n) => /exitCode:\s*-2/.test(readFileSync(`${lastRun}/${n}`, 'utf8')));
}

describe.skipIf(!E2E_REAL_ENABLED)('V1.9.6 — oversized generate seed flows via stdin and is processed (not pre-spawn argv-killed)', () => {
  test('the oversized controller is NOT refused by the pre-spawn argv guard (no exitCode: -2 capture)', () => {
    expect(
      guardRefusalObserved(),
      'TR-1 (V1.9.6): the oversized Oversized.controller.js prompt now travels via ' +
        'stdin, so the assembled argv is flags-only and the B1 pre-spawn guard no ' +
        'longer refuses it. A -2 capture here would mean the transport regressed ' +
        'and the prompt went back onto argv.',
    ).toBe(false);
  });

  test('the big seed is processed into a generated-test entry, not a no-output argv-guard refusal', () => {
    if (sandbox === null || runResult === null) throw new Error('run did not execute');
    expect(sandbox.reportExists(), 'report.json not written').toBe(true);
    const report = sandbox.readReport();
    const entry = report.generatedTests.find((g) =>
      g.sourceFile.endsWith('Oversized.controller.js'),
    );
    expect(
      entry,
      `expected a generatedTests entry for Oversized.controller.js. ` +
        `generatedTests: ${JSON.stringify(report.generatedTests)}`,
    ).toBeDefined();
    // Post-transport the seed reaches the model and is generated against
    // (observed: a 'passed' test). The one status it must NOT be is 'no-output'
    // — the pre-spawn argv-guard refusal outcome this witness used to assert.
    expect(
      entry?.status,
      `the seed flowed via stdin and was processed, so its outcome must not be the ` +
        `argv-guard 'no-output' refusal. status: ${entry?.status}`,
    ).not.toBe('no-output');
  });
});
