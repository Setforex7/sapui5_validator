/**
 * V1.5 runtime-audit characterization tests — see V1.5-DIAGNOSIS.md.
 *
 * Each `test.fails(...)` below encodes the DESIRED (correct) behavior for a
 * confirmed bug. It is GREEN today precisely because the bug makes the
 * assertion fail; when the bug is fixed the assertion will pass, `test.fails`
 * will flip the test RED, and the author must delete the `.fails` marker (and
 * the bug note) as part of the fix. So `npm test` stays green now AND each test
 * is a fix-beacon that fires exactly when the underlying defect is closed.
 *
 * One case (A6) is a plain pin of CURRENT behavior because the desired output
 * is a genuine product decision, not yet made.
 *
 * Scope note: only cheaply-reachable, deterministic, offline gaps are pinned
 * here. The orchestration-level (C1/C2/G1) and real-toolchain (B1 e2e, D1/D2)
 * cases are documented in V1.5-DIAGNOSIS.md with their own suggested tests.
 */

import { Buffer } from 'node:buffer';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { libNameFor } from '../../src/project/lib-namespace.js';
import { parseControllerImports } from '../../src/project/controller-imports.js';
import { parseKarmaUi5Url } from '../../src/project/test-layout.js';
import { stripJsComments } from '../../src/util/strip-js-comments.js';
import {
  MAX_PROMPT_FEEDBACK_BYTES,
  prepareFeedbackForPrompt,
} from '../../src/util/prompt-feedback.js';
import { isRateLimitedResult } from '../../src/checks/_shared.js';
import { detectSapUi5Project } from '../../src/project/detect.js';
import { formatExitMessage } from '../../src/output/messages.js';
import type { ClaudeRunResult } from '../../src/claude/runner.js';
import type { ExitReason } from '../../src/types.js';

describe('V1.5 #A1 — libNameFor derives the real library for a deep two-segment lib path', () => {
  // FIXED (V1.5 Batch 7): libNameFor matches the longest KNOWN SAP UI5 library
  // prefix (KNOWN_SAP_UI5_LIBRARIES) before the 3-segment cap, so a deep module
  // path no longer over-shoots into a phantom namespace (sap.viz.ui5) that would
  // be auto-written to manifest.json and re-create the karma hang V1.4 prevents.
  test('a deep sap.viz module derives sap.viz, not the phantom sap.viz.ui5', () => {
    expect(libNameFor('sap/viz/ui5/controls/VizFrame')).toBe('sap.viz');
  });

  test('a genuine 3-segment library is unaffected (still the 3-segment cap)', () => {
    expect(libNameFor('sap/ui/comp/smartfield/SmartField')).toBe('sap.ui.comp');
  });

  test('a shallow module of a known library is unchanged', () => {
    expect(libNameFor('sap/m/Button')).toBe('sap.m');
  });
});

describe('V1.5 #A2 — parseControllerImports misses the named sap.ui.define form', () => {
  const named =
    'sap.ui.define("app/controller/Foo", ["sap/ui/export/Spreadsheet"], function (S) {});';

  test('pins CURRENT behavior: a named define yields zero imports', () => {
    // The head regex /sap\.ui\.define\s*\(\s*\[/ does not match `define("id", [`,
    // so the real imports are silently dropped and no unpreloaded-lib gap fires.
    expect(parseControllerImports(named)).toEqual([]);
  });

  test.fails('DESIRED: a named define still surfaces its imports', () => {
    expect(parseControllerImports(named)).toEqual(['sap/ui/export/Spreadsheet']);
  });
});

describe('V1.5 #A6 — parseControllerImports parses only the first sap.ui.define', () => {
  const twoDefines = [
    'sap.ui.define(["sap/m/Button"], function (Button) {});',
    'sap.ui.define(["sap/ui/export/Spreadsheet"], function (S) {});',
  ].join('\n');

  // PIN of current behavior — whether multi-define should be supported at all
  // is an undecided product question (see A6). This locks the truncation so a
  // future change to it is a deliberate, reviewed decision rather than a
  // silent drift.
  test('pins CURRENT behavior: only the first define array is parsed', () => {
    expect(parseControllerImports(twoDefines)).toEqual(['sap/m/Button']);
  });
});

describe('V1.5 #A3 — parseKarmaUi5Url crosses a nested object before url:', () => {
  // FIXED (V1.5 Batch 2): the ui5 block body is brace-balanced and string-aware,
  // so a legal `paths`/`config` sibling object before `url` no longer hides it.
  // (A null here wrongly defaulted every gap to cdnServed:true and routed a
  // CDN-absent lib to the manifest fix -> karma hang.)
  const nested =
    "config.set({ ui5: { paths: { 'my/app': './webapp' }, url: 'https://sdk.openui5.org' } });";

  test('extracts the top-level url despite a nested sibling object', () => {
    expect(parseKarmaUi5Url(nested)).toBe('https://sdk.openui5.org');
  });
});

describe('V1.5 #A4 — stripJsComments is regex-literal aware', () => {
  // FIXED (V1.5 Batch 2): a regex literal containing a quote no longer flips the
  // scanner into a phantom string state, so a trailing // comment after it is
  // still stripped. Length preservation is unchanged.
  const src = "var re = /(['\"])/; // libs comment";

  test('blanks the trailing line comment after a quote-bearing regex literal', () => {
    const out = stripJsComments(src);
    expect(out).toHaveLength(src.length); // length preservation still holds
    expect(out).not.toContain('// libs comment');
  });
});

describe('V1.5 #A5 — a UTF-8 BOM on manifest.json is tolerated by detection', () => {
  // FIXED (V1.5 Batch 2): every manifest read goes through parseJsonWithBom,
  // which strips a leading U+FEFF before JSON.parse, so a BOM-prefixed (but
  // valid) manifest — what SAP tooling / Windows editors emit — is accepted.
  let dir = '';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'v15-bom-'));
    mkdirSync(join(dir, 'webapp'), { recursive: true });
    // Valid manifest JSON, but prefixed with a UTF-8 BOM (U+FEFF) — exactly
    // what SAP tooling / Windows editors emit. No ui5.yaml, so detection must
    // go through the manifest+component path (where a naive JSON.parse would
    // trip on the BOM before parseJsonWithBom strips it).
    const manifest = JSON.stringify({ 'sap.app': { type: 'application' } });
    writeFileSync(join(dir, 'webapp', 'manifest.json'), '﻿' + manifest, 'utf8');
    writeFileSync(join(dir, 'webapp', 'Component.js'), '// component', 'utf8');
  });

  afterEach(() => {
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
  });

  test('BOM-prefixed (but valid) JSON is accepted', () => {
    expect(detectSapUi5Project(dir).ok).toBe(true);
  });
});

describe('V1.5 #B2 — prepareFeedbackForPrompt never exceeds its 16 KiB cap', () => {
  // FIXED (V1.5 Batch 5): the hoisted block is byte-budgeted, so even an
  // all-hoist input (every line a stack frame / Error keyword, so the head and
  // tail loops come back empty) returns <= cap and cannot re-open the Windows
  // argv overflow the cap exists to prevent.
  const deepStack = Array.from(
    { length: 3000 },
    (_, i) => `    at frame${i} (mod.js:${i}:1)`,
  ).join('\n');

  test('an all-hoist deep stack returns text within the cap', () => {
    const out = prepareFeedbackForPrompt(deepStack);
    expect(Buffer.byteLength(out.text, 'utf8')).toBeLessThanOrEqual(MAX_PROMPT_FEEDBACK_BYTES);
  });

  test('still preserves the failure signal (top frames survive)', () => {
    const out = prepareFeedbackForPrompt(deepStack);
    expect(out.text).toContain('at frame0 '); // the highest-value top frame is kept
    expect(out.truncatedBytes).toBeGreaterThan(0); // and the rest is truncated, not dropped silently
  });
});

describe('V1.5 #D3 — isRateLimitedResult misses the gerund "rate-limiting"', () => {
  const rlResult = (stderr: string): ClaudeRunResult => ({
    ok: false,
    json: null,
    raw: '',
    stderr,
    exitCode: 1,
    durationMs: 0,
    callId: 'cid-test',
  });

  test('pins CURRENT behavior: "rate limit exceeded" matches, "rate-limiting" does not', () => {
    expect(isRateLimitedResult(rlResult('Error: rate limit exceeded'))).toBe(true);
    expect(isRateLimitedResult(rlResult('Error: you are currently rate-limiting'))).toBe(false);
  });

  test.fails('DESIRED: the gerund form is recognised as rate-limited', () => {
    expect(isRateLimitedResult(rlResult('Error: you are currently rate-limiting'))).toBe(true);
  });
});

describe('V1.5 #I1 — unfixed-findings message points at the real report path', () => {
  // FIXED (V1.5 Batch 1): the report is written to .sapui5-validator/report.json
  // (see reportPath()), not under last-run/. messages.ts no longer appends the
  // wrong last-run/ segment for this exit reason.
  const reason: ExitReason = { kind: 'unfixed-findings', remaining: 1 };

  test('names .sapui5-validator/report.json, not last-run/report.json', () => {
    const msg = formatExitMessage(reason) ?? '';
    expect(msg).toContain('.sapui5-validator/report.json');
    expect(msg).not.toContain('last-run/report.json');
  });
});
