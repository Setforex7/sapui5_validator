/**
 * V1.4-5 (AH5, supports plan §V1.4-5 "New witnesses" item) —
 * documentation witness for the strengthened system prompt.
 * `system-prompt.test.ts` snapshot-pins the literal text; this file
 * pins the *intent*: each rejected-shape phrase is named, each is
 * tied to a real historical real-project failure mode, and each
 * appears in the prompt.
 *
 * LLM behaviour isn't testable from here, but the prompt content
 * is. If V1.4-7's cap_try re-run still produces prose preambles
 * after this prompt lands, V1.5+ adds the sanctioned
 * `fixProposalSchema.explanation` field (diagnosis §4.1).
 */

import { describe, expect, test } from 'vitest';
import { SYSTEM_PROMPT } from '../../src/checks/_shared.js';

const REJECTED_SHAPES: ReadonlyArray<{
  readonly label: string;
  readonly phrase: string;
  readonly example: string;
  readonly historicalCase: string;
}> = [
  {
    label: 'prose-preamble',
    phrase: 'Prefixing with prose:',
    example: 'The issue: foo bar. {"newFileContent":"..."}',
    historicalCase:
      'V1.3.3-4 Bug A — cap_try v0.4.0/v0.4.1 LLM emitted "The issue: …\\n\\n{…}" on refinement, breaking the JSON.parse step inside interpretEnvelope until extractJsonValue was added.',
  },
  {
    label: 'markdown-fence',
    phrase: 'Wrapping in fences:',
    example: '(three backticks)json {"newFileContent":"..."} (three backticks)',
    historicalCase:
      'V1.3.3 backlog §4.3 (deferred V1.5+) — extractJsonValue refuses fenced input by design; the prompt binds the LLM away from emitting it in the first place.',
  },
  {
    label: 'trailing-commentary',
    phrase: 'Trailing commentary:',
    example: '{"newFileContent":"..."} // hope this helps',
    historicalCase:
      'Observed in pre-V1.3 fixture runs (the LLM appending a one-line summary after the JSON envelope).',
  },
];

describe('SYSTEM_PROMPT — rejected-shape phrase coverage', () => {
  for (const shape of REJECTED_SHAPES) {
    test(`names the "${shape.label}" rejected shape`, () => {
      expect(SYSTEM_PROMPT).toContain(shape.phrase);
      expect(SYSTEM_PROMPT).toContain(shape.example);
      // Sanity-tie to the historical case the phrase guards against —
      // the assertion is documentary; the string itself is in the
      // test file so a future contributor reading the failure sees
      // the WHY before they "fix" it.
      expect(shape.historicalCase.length).toBeGreaterThan(0);
    });
  }

  test('frames an acceptable shape explicitly (DO example)', () => {
    expect(SYSTEM_PROMPT).toContain('Acceptable response');
    expect(SYSTEM_PROMPT).toContain('{"newFileContent":"sap.ui.define([], function(){});"}');
  });

  test('AP5 — does NOT remove the V1.3.3-4 safety net (extractJsonValue stays)', () => {
    // This is a pointer-test: the strengthened prompt should
    // *reduce* preamble frequency, never *replace* the recovery
    // surface. If a future contributor moves extractJsonValue out
    // of src/util/json-envelope.ts, this test stays green (it
    // doesn't import the function) — but the V1.4-5 commit message
    // memorialises the layered-defence principle and the V1.3.3-4
    // tests still pin the recovery. Documentary check only.
    expect(SYSTEM_PROMPT).toContain('the parser refuses these');
  });
});
