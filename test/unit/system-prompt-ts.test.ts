/**
 * V1.9 GA1-10 — the TypeScript-framed system prompt + the language selector.
 *
 * Pairs with `system-prompt.test.ts` (the JS byte-for-byte pin). Here:
 *   - `systemPromptFor('js')` IS the byte-identical {@link SYSTEM_PROMPT};
 *   - `systemPromptFor('ts')` IS {@link TS_SYSTEM_PROMPT};
 *   - the TS prompt re-frames the project as TypeScript and replaces the AMD
 *     generator example with an ES-module/class one (never steering an
 *     ES-module `.ts` toward `sap.ui.define`), while keeping the findings
 *     envelope + the no-literal-fence (AH4) contract.
 */

import { describe, expect, test } from 'vitest';
import {
  SYSTEM_PROMPT,
  TS_SYSTEM_PROMPT,
  systemPromptFor,
} from '../../src/checks/_shared.js';

describe('systemPromptFor — language selector', () => {
  test("'js' returns the byte-identical JS SYSTEM_PROMPT", () => {
    expect(systemPromptFor('js')).toBe(SYSTEM_PROMPT);
  });
  test("'ts' returns the TS_SYSTEM_PROMPT", () => {
    expect(systemPromptFor('ts')).toBe(TS_SYSTEM_PROMPT);
  });
});

describe('TS_SYSTEM_PROMPT (GA1-10)', () => {
  test('re-frames the project as TypeScript', () => {
    expect(TS_SYSTEM_PROMPT).toContain('SAPUI5 (TypeScript) projects');
    expect(TS_SYSTEM_PROMPT).not.toContain('SAPUI5 (JavaScript) projects');
  });

  test('replaces the AMD generator example with an ES-module/class one', () => {
    // The JS prompt models `{"newFileContent":"sap.ui.define([], function(){});"}`.
    // The TS prompt MUST NOT — that AMD shape would corrupt an ES-module `.ts`.
    expect(TS_SYSTEM_PROMPT).not.toContain('sap.ui.define([], function(){});');
    expect(TS_SYSTEM_PROMPT).toContain('export default class');
    expect(TS_SYSTEM_PROMPT).toContain(
      'NEVER wrap it in `sap.ui.define([...], function () { ... })`',
    );
  });

  test('keeps the findings envelope and the SINGLE-JSON-value framing', () => {
    expect(TS_SYSTEM_PROMPT).toContain('{"findings":[]}');
    expect(TS_SYSTEM_PROMPT).toContain('SINGLE JSON value');
    expect(TS_SYSTEM_PROMPT).toContain('Rejected shapes (the parser refuses these):');
  });

  test('AH4 — no literal markdown fences in the TS prompt body either', () => {
    expect(TS_SYSTEM_PROMPT.includes('```')).toBe(false);
  });
});
