/**
 * V1.9.2 Phase 4a (TG-E2E) — the real-toolchain generate-for-TypeScript witness.
 *
 * The companion of `ts-validate.e2e.test.ts`: where that proves a TS *validate*
 * run takes the static-only lane, this proves a TS *generate* run does. It runs
 * one real `sapui5-validate generate webapp/controller/Detail.controller.ts
 * --qunit-only --force` against an ISOLATED tmpdir copy of
 * `test/fixtures/e2e-real-ts-project/` (real `claude` + real `tsc`/`ui5lint`),
 * targeting the intentionally-uncovered `Detail.controller.ts` (the fixture's
 * `App.controller.ts` is already covered). The sandbox is load-bearing: vitest
 * runs the `e2e-real` files in parallel forks over a shared filesystem, so
 * running generate against the in-repo fixture would clobber the
 * `report.json` that `ts-validate.e2e.test.ts` reads — the sandbox isolates the
 * run and `afterAll` removes it, so the in-repo fixture is never mutated.
 *
 * Against the sandbox's persisted artifacts the four contract points are pinned:
 *
 *   1. TS-AWARE DISCOVERY + TS FRAMING (HB-DISC / GA1-10 / FS-4) — the uncovered
 *      `.ts` controller is enumerated and a ` ```typescript `-fenced prompt
 *      carrying its ES-module/class source reaches the model (no JS-only
 *      discovery regression, which would find ZERO targets and make no call).
 *   2. THE FIREWALL (FS-1) — karma is NEVER invoked: no `*-karma.txt` verify
 *      artifact is written (mirror `ts-validate.e2e.test.ts`), because the
 *      generate verify input carries `language: 'ts'` and the baseline probe is
 *      lint-only for TS. Karma-running a `.ts` would transpile it via the
 *      project's own `ui5-tooling-transpile` / babel config = arbitrary
 *      in-process code execution (the never-build firewall, SPEC §2.5/§2.10).
 *   3. THE ACCEPT/REJECT PREDICATE FIRED (FS-6/FS-8/FS-11) — a `generatedTests`
 *      entry for the controller records a file-backed terminal outcome
 *      (`passed` or `quarantined`), and an accepted pass is marked
 *      `verification: "static-only"` — never a silent green that implies karma.
 *   4. THE ARTIFACT IS `.ts` (TG-MODULEID / TG-QUARANTINE-TS) — an accepted test
 *      lands at `…/Detail.controller.qunit.ts` (never `.qunit.js`); a 3×-failing
 *      one quarantines to `webapp/test/_failing/Detail.controller.failing.qunit.ts`.
 *
 * The integration test `test/integration/ts-validate-refusal.test.ts` + the
 * generate-layer firewall guard in `test/unit/generation-retry-loop.test.ts` pin
 * the `karma-call-count == 0 on TS` invariant STRUCTURALLY with counting fakes;
 * this file is the REAL-binary counterpart for the generate path.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  E2E_REAL_ENABLED,
  createTsGenerateSandbox,
  type CliRunResult,
  type GenerateSandbox,
} from './_shared.js';

const DETAIL_CONTROLLER_REL = 'webapp/controller/Detail.controller.ts';
const DETAIL_TEST_REL = 'webapp/test/unit/controller/Detail.controller.qunit.ts';
const DETAIL_QUARANTINE_REL =
  'webapp/test/_failing/Detail.controller.failing.qunit.ts';

// A real generate run is LLM generation + the TS static lane (`tsc --noEmit` +
// `ui5lint`, each a cold whole-project type-model rebuild) over up to 3
// attempts. No karma/CDN/browser (firewalled for TS), but still give it a wide
// ceiling matching the other generate witnesses.
const RUN_TIMEOUT_MS = 12 * 60_000;

let sandbox: GenerateSandbox | null = null;
let runResult: CliRunResult | null = null;

beforeAll(async () => {
  if (!E2E_REAL_ENABLED) return;
  sandbox = createTsGenerateSandbox('sapui5-gents-');
  runResult = await sandbox.run([
    'generate',
    DETAIL_CONTROLLER_REL,
    '--qunit-only',
    '--force',
  ]);
}, RUN_TIMEOUT_MS);

afterAll(() => {
  sandbox?.remove();
  sandbox = null;
  runResult = null;
});

/** A compact diagnostic of the CLI run for a failed assertion. */
function runSummary(): string {
  if (runResult === null) return 'run did not execute';
  return `exitCode=${runResult.exitCode}; stderr tail:\n${runResult.stderr.slice(-600)}`;
}

/** Concatenated text of every persisted prompt for the sandbox run. */
function concatPrompts(sb: GenerateSandbox): string {
  const dir = sb.path('.sapui5-validator', 'last-run', 'prompts');
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return '';
  }
  return names
    .map((n) => {
      try {
        return readFileSync(`${dir}/${n}`, 'utf8');
      } catch {
        return '';
      }
    })
    .join('\n');
}

/** Verify-step artifact names (e.g. `<callId>-karma.txt`) for the sandbox run. */
function verifyArtifacts(sb: GenerateSandbox): string[] {
  const dir = sb.path('.sapui5-validator', 'last-run', 'verify');
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** The `generatedTests` entry for the uncovered Detail controller, or undefined. */
function detailEntry(
  sb: GenerateSandbox,
): { sourceFile: string; testFile: string; status: string; verification?: string } | undefined {
  return sb
    .readReport()
    .generatedTests.find((g) => g.sourceFile.replace(/\\/g, '/').endsWith(DETAIL_CONTROLLER_REL));
}

describe.skipIf(!E2E_REAL_ENABLED)('V1.9.2 — TypeScript generate run emits a static-only .qunit.ts', () => {
  test('TS-aware discovery (HB-DISC): a TS-framed prompt for the uncovered .ts controller reached the model', () => {
    if (sandbox === null) throw new Error('sandbox not initialised');
    expect(sandbox.reportExists(), 'sandbox report.json not produced').toBe(true);

    // The uncovered `.ts` controller was enumerated and a generate prompt was
    // built for it — a JS-only discovery regression would find ZERO `.ts`
    // targets and the entry below would be absent.
    expect(
      detailEntry(sandbox),
      `expected a generatedTests entry for ${DETAIL_CONTROLLER_REL} — TS-aware ` +
        `discovery must enumerate the uncovered .ts controller (HB-DISC)`,
    ).toBeDefined();

    const prompts = concatPrompts(sandbox);
    // GA1-10 / FS-4 — a TS controller is fenced ` ```typescript `, never JS/AMD.
    expect(
      prompts.includes('```typescript'),
      'no TS-fenced (```typescript) prompt found — the TS framing did not reach the model',
    ).toBe(true);
    // The uncovered controller's ES-module/class source made it into a prompt —
    // proof the `.ts` file was discovered and handed to a generate call.
    expect(
      prompts.includes('export default class Detail'),
      'the uncovered .ts controller source was not embedded in any prompt — discovery did not enumerate it',
    ).toBe(true);
  });

  test('THE FIREWALL: karma was never invoked for the TS generate run', () => {
    if (sandbox === null) throw new Error('sandbox not initialised');
    expect(sandbox.reportExists(), 'sandbox report.json not produced').toBe(true);

    // The JS path writes `<callId>-karma.txt` dumps (baseline probe + per-attempt
    // verify) under last-run/verify/. A TS run writes NONE: the baseline probe is
    // lint-only for TS and the verify input routes to the static-only lane, which
    // has no karma branch. Any karma artifact here means the firewall was breached.
    const karmaArtifacts = verifyArtifacts(sandbox).filter((name) =>
      name.toLowerCase().includes('karma'),
    );
    expect(
      karmaArtifacts,
      `expected zero karma verify artifacts on the TS generate run; found: ${JSON.stringify(karmaArtifacts)}`,
    ).toEqual([]);
  });

  test('the accept/reject predicate fired — a file-backed static-only outcome was recorded', () => {
    if (sandbox === null) throw new Error('sandbox not initialised');
    const entry = detailEntry(sandbox);
    expect(entry, `no generatedTests entry for ${DETAIL_CONTROLLER_REL}`).toBeDefined();
    if (entry === undefined) return;

    // The predicate produced a terminal, file-backed outcome: ACCEPTED (`passed`)
    // or REJECTED-after-3 (`quarantined`). `no-output` (the LLM produced no
    // parseable content across all 3 attempts) is a rare flake, surfaced loudly
    // here rather than passing silently.
    expect(
      ['passed', 'quarantined'],
      `expected the accept/reject predicate to land a file-backed outcome for ` +
        `${DETAIL_CONTROLLER_REL}; got status='${entry.status}'. A 'no-output' is a ` +
        `rare LLM flake (no parseable content in 3 attempts) — re-run the gate. ` +
        `${runSummary()}`,
    ).toContain(entry.status);

    // An accepted TS QUnit pass is STATIC-ONLY (ui5lint + tsc + shape check,
    // never karma) — the marker the report must carry so `passed` cannot
    // overstate what was verified (FS-8). Quarantined entries claim no
    // verification depth, so the marker is asserted only on the pass.
    if (entry.status === 'passed') {
      expect(
        entry.verification,
        `an accepted TS generate pass must be reported verification: "static-only" ` +
          `(never a silent green implying karma execution); got '${entry.verification ?? 'undefined'}'`,
      ).toBe('static-only');
    }
  });

  test('the generated artifact is a .ts — landed as .qunit.ts (accepted) or quarantined as .failing.qunit.ts', () => {
    if (sandbox === null) throw new Error('sandbox not initialised');
    const entry = detailEntry(sandbox);
    expect(entry, `no generatedTests entry for ${DETAIL_CONTROLLER_REL}`).toBeDefined();
    if (entry === undefined) return;

    if (entry.status === 'passed') {
      // TG-MODULEID — an accepted test lands at the standard layout path as a
      // `.qunit.ts` (the project's idiom), NEVER a `.qunit.js`.
      expect(
        existsSync(sandbox.path(DETAIL_TEST_REL)),
        `expected the accepted generated test at ${DETAIL_TEST_REL}`,
      ).toBe(true);
      expect(
        entry.testFile.replace(/\\/g, '/').endsWith('.qunit.ts'),
        `accepted TS test must be a .qunit.ts, not .js; report testFile='${entry.testFile}'`,
      ).toBe(true);
    } else {
      // TG-QUARANTINE-TS — a 3×-failing TS test moves to webapp/test/_failing/
      // with the `.failing.qunit.ts` suffix, unregistered.
      expect(
        existsSync(sandbox.path(DETAIL_QUARANTINE_REL)),
        `expected the quarantined test at ${DETAIL_QUARANTINE_REL}`,
      ).toBe(true);
      expect(
        entry.testFile.replace(/\\/g, '/').endsWith('.failing.qunit.ts'),
        `quarantined TS test must use the .failing.qunit.ts suffix; report testFile='${entry.testFile}'`,
      ).toBe(true);
    }
  });
});
