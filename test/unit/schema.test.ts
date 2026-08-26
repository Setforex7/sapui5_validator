import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  findingSchema,
  findingsSchema,
  fixProposalSchema,
  generatedFileSchema,
  generatorOutputSchema,
  manualFindingSchema,
  MAX_GENERATED_FILE_BYTES,
  safeJson,
} from '../../src/util/schema.js';

describe('fixProposalSchema', () => {
  it('parses a valid fix proposal', () => {
    const result = fixProposalSchema.safeParse({ newFileContent: 'sap.ui.define([], () => {});' });
    expect(result.success).toBe(true);
  });

  it('rejects missing newFileContent', () => {
    const result = fixProposalSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

// SEC-3 (V1.8) — an LLM file body over MAX_GENERATED_FILE_BYTES must be
// rejected at the trust boundary (→ malformed-output finding), never written.
// Fails on revert: drop the `.max(...)` and the over-cap payload parses.
describe('SEC-3 — LLM file-body size cap', () => {
  it('accepts a body exactly at the cap', () => {
    const atCap = 'a'.repeat(MAX_GENERATED_FILE_BYTES);
    expect(fixProposalSchema.safeParse({ newFileContent: atCap }).success).toBe(true);
    expect(
      generatedFileSchema.safeParse({ path: 'webapp/test/X.qunit.js', content: atCap }).success,
    ).toBe(true);
  });

  it('rejects a fixProposal newFileContent over the cap', () => {
    const overCap = 'a'.repeat(MAX_GENERATED_FILE_BYTES + 1);
    expect(fixProposalSchema.safeParse({ newFileContent: overCap }).success).toBe(false);
  });

  it('rejects a generatedFile content over the cap', () => {
    const overCap = 'a'.repeat(MAX_GENERATED_FILE_BYTES + 1);
    expect(
      generatedFileSchema.safeParse({ path: 'webapp/test/X.qunit.js', content: overCap }).success,
    ).toBe(false);
  });

  it('an over-cap fix in an auto-fixable finding fails the finding schema', () => {
    const overCap = 'a'.repeat(MAX_GENERATED_FILE_BYTES + 1);
    const result = findingSchema.safeParse({
      checkId: 'no-direct-dom',
      file: 'webapp/controller/Main.controller.js',
      message: 'x',
      proposedFix: { newFileContent: overCap },
    });
    expect(result.success).toBe(false);
  });
});

describe('findingSchema', () => {
  it('parses an auto-fixable finding', () => {
    const finding = {
      checkId: 'no-direct-dom' as const,
      file: 'webapp/controller/Main.controller.js',
      line: 42,
      message: 'document.querySelector is forbidden',
      proposedFix: { newFileContent: '// fixed' },
    };
    const result = findingSchema.safeParse(finding);
    expect(result.success).toBe(true);
    if (result.success && result.data.proposedFix !== null) {
      expect(result.data.proposedFix.newFileContent).toBe('// fixed');
    }
  });

  it('parses a manual finding with explanation', () => {
    const finding = {
      checkId: 'manifest-component-drift' as const,
      file: 'webapp/manifest.json',
      message: 'routes/Detail unreferenced',
      proposedFix: null,
      explanation: 'Requires Component.js edit alongside manifest.',
    };
    const result = findingSchema.safeParse(finding);
    expect(result.success).toBe(true);
  });

  it('rejects an unknown checkId', () => {
    const result = findingSchema.safeParse({
      checkId: 'no-such-check',
      file: 'a.js',
      message: 'x',
      proposedFix: { newFileContent: 'y' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a manual finding missing explanation', () => {
    const result = findingSchema.safeParse({
      checkId: 'no-direct-dom',
      file: 'a.js',
      message: 'x',
      proposedFix: null,
    });
    expect(result.success).toBe(false);
  });

  // V1.3.1-5 witness — a real `claude` run reproducibly omits the null-valued
  // `proposedFix` key on manual findings, which surfaced as a "Schema
  // validation failed" finding in the e2e-real schema-envelope test. A missing
  // key must be tolerated and normalized to `null`, not rejected.
  it('parses a manual finding with proposedFix omitted, normalizing it to null', () => {
    const result = findingSchema.safeParse({
      checkId: 'missing-test-coverage',
      file: 'webapp/controller/Main.controller.js',
      message: 'onInit has no test',
      explanation: 'Add a QUnit test exercising onInit.',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.proposedFix).toBeNull();
    }
  });

  it('still rejects a manual finding that carries a non-null proposedFix shape mismatch', () => {
    // `proposedFix` present but neither a valid fix object nor null → the
    // leniency is strictly "missing ⇒ null", not "anything ⇒ null".
    const result = findingSchema.safeParse({
      checkId: 'missing-test-coverage',
      file: 'a.js',
      message: 'x',
      proposedFix: 'not-a-fix',
      explanation: 'y',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty file path', () => {
    const result = findingSchema.safeParse({
      checkId: 'no-direct-dom',
      file: '',
      message: 'x',
      proposedFix: { newFileContent: 'y' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-positive line number', () => {
    const result = findingSchema.safeParse({
      checkId: 'no-direct-dom',
      file: 'a.js',
      line: 0,
      message: 'x',
      proposedFix: { newFileContent: 'y' },
    });
    expect(result.success).toBe(false);
  });
});

describe('manualFindingSchema', () => {
  // The `manual-only` checks (e.g. missing-test-coverage) validate against
  // `z.array(manualFindingSchema)` directly — not the union — so this is the
  // exact e2e-real schema-envelope failure path.
  it('parses a manual finding with proposedFix omitted (e2e-real failure path)', () => {
    const result = manualFindingSchema.safeParse({
      checkId: 'missing-test-coverage',
      file: 'webapp/controller/Main.controller.js',
      message: 'onInit has no test',
      explanation: 'Add a QUnit test exercising onInit.',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.proposedFix).toBeNull();
    }
  });

  it('parses a manual finding with an explicit proposedFix: null', () => {
    const result = manualFindingSchema.safeParse({
      checkId: 'missing-test-coverage',
      file: 'a.js',
      message: 'x',
      proposedFix: null,
      explanation: 'y',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a manual finding whose proposedFix is a fix object', () => {
    const result = manualFindingSchema.safeParse({
      checkId: 'missing-test-coverage',
      file: 'a.js',
      message: 'x',
      proposedFix: { newFileContent: 'y' },
      explanation: 'z',
    });
    expect(result.success).toBe(false);
  });
});

describe('findingsSchema', () => {
  it('parses a mixed array of findings', () => {
    const result = findingsSchema.safeParse([
      {
        checkId: 'no-direct-dom',
        file: 'a.js',
        message: 'x',
        proposedFix: { newFileContent: 'y' },
      },
      {
        checkId: 'manifest-component-drift',
        file: 'b.json',
        message: 'y',
        proposedFix: null,
        explanation: 'multi-file',
      },
    ]);
    expect(result.success).toBe(true);
  });
});

describe('generatorOutputSchema', () => {
  it('requires at least one file', () => {
    expect(generatorOutputSchema.safeParse({ files: [] }).success).toBe(false);
    expect(
      generatorOutputSchema.safeParse({
        files: [{ path: 'webapp/test/unit/Foo.qunit.js', content: '' }],
      }).success,
    ).toBe(true);
  });

  it('rejects empty path entries', () => {
    expect(
      generatorOutputSchema.safeParse({ files: [{ path: '', content: 'x' }] }).success,
    ).toBe(false);
  });
});

describe('safeJson', () => {
  it('returns ok=false on invalid JSON', () => {
    const result = safeJson('not json', z.object({ a: z.number() }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Invalid JSON/);
  });

  it('returns ok=false on schema mismatch', () => {
    const result = safeJson('{"a":"oops"}', z.object({ a: z.number() }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Schema validation failed/);
  });

  it('returns the parsed data on a match', () => {
    const result = safeJson('{"a":1}', z.object({ a: z.number() }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.a).toBe(1);
  });
});
