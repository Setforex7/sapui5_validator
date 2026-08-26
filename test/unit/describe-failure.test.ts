/**
 * V1.4-8 (Area B2) — witness for `describeFailure`'s buried-error
 * surfacing. The cap_try ProductService quarantine reason in
 * `report.json` was uninformative because `joinFeedback` places karma
 * stderr (a benign `[DEP0060]` banner + "server started") before
 * stdout (the browser `ERROR`), and the previous head-only slice
 * captured only the banner. `describeFailure` now keeps the head AND
 * appends error-signal / stack-frame lines.
 */

import { describe, expect, test } from 'vitest';
import { describeFailure } from '../../src/generation/retry-loop.js';
import type { VerifyResult } from '../../src/verify/pipeline.js';

function makeResult(feedbackForLlm: string): VerifyResult {
  return {
    ok: false,
    steps: [],
    failedStep: 'karma',
    feedbackForLlm,
  };
}

describe('describeFailure — V1.4-8 buried-error surfacing', () => {
  test('cap_try ProductService shape: benign banner head, real error below → error surfaces', () => {
    const feedback = [
      '(node:25960) [DEP0060] DeprecationWarning: The `util._extend` API is deprecated.',
      '(Use `node --trace-deprecation ...` to show where the warning was created)',
      '',
      'Karma v6.4.4 server started at http://localhost:9876/',
      'INFO [launcher]: Starting browser ChromeHeadless',
      "ERROR Uncaught ReferenceError: sinon is not defined",
      '  at webapp/resources/sap/ui/thirdparty/sinon-qunit.js:34:1',
    ].join('\n');
    const msg = describeFailure(makeResult(feedback));
    expect(msg).toContain('karma failed:');
    // The real error and its stack frame are present despite sitting
    // below the benign banner.
    expect(msg).toContain('sinon is not defined');
    expect(msg).toContain('sinon-qunit.js:34');
  });

  test('common case: error is in the head → head preserved, no loss', () => {
    const feedback = [
      'ERROR Expected true to be false',
      '  at webapp/test/unit/foo.qunit.js:10:3',
      'extra context line',
      'another context line',
    ].join('\n');
    const msg = describeFailure(makeResult(feedback));
    expect(msg).toContain('Expected true to be false');
    expect(msg).toContain('foo.qunit.js:10');
  });

  test('output is capped and deduplicated (no runaway / repeated lines)', () => {
    const errorLine = 'ERROR something broke';
    const feedback = Array.from({ length: 50 }, () => errorLine).join('\n');
    const msg = describeFailure(makeResult(feedback));
    // The repeated line appears once; the message stays bounded.
    const occurrences = msg.split(errorLine).length - 1;
    expect(occurrences).toBe(1);
    expect(msg.split('\n').length).toBeLessThanOrEqual(9); // prefix + <=8 lines
  });

  test('no failedStep → returns raw feedback unchanged', () => {
    const result: VerifyResult = {
      ok: false,
      steps: [],
      feedbackForLlm: 'raw feedback',
    };
    expect(describeFailure(result)).toBe('raw feedback');
  });
});
