import { z, type ZodTypeAny } from 'zod';
import { SEMANTIC_CHECK_IDS } from '../types.js';

/**
 * LLM-facing checkId schema. Only the seven SPEC §2.8 semantic ids are
 * accepted — the orchestrator stamps `baseline-*` ids itself when
 * synthesising baseline findings, the LLM never produces them.
 */
export const checkIdSchema = z.enum(SEMANTIC_CHECK_IDS);

/**
 * SEC-3 (V1.8) — hard ceiling on an LLM-produced file body. The outbound
 * prompt is bounded, but the inbound `newFileContent` / `content` payload had
 * no tool-side limit: the only ceiling was execa's implicit ~100 MB stdout
 * default, so a runaway model response could be written to disk as a multi-MB
 * file. A body over the cap is rejected at the trust boundary and surfaces as a
 * malformed-output finding, never a multi-MB write.
 *
 * `z.string().max()` counts UTF-16 code units, not bytes; for the source code
 * these fields carry (overwhelmingly ASCII) that is ≈ bytes, and even in the
 * worst case it bounds the on-disk size to ≤ 4× this value — far under the
 * execa default and far above any legitimate generated test or fixed file
 * (realistically < 100 KB). A named constant per CLAUDE.md (no hard-coded caps).
 */
export const MAX_GENERATED_FILE_BYTES = 1024 * 1024;

export const fixProposalSchema = z.object({
  newFileContent: z.string().max(MAX_GENERATED_FILE_BYTES),
});

const baseFindingShape = {
  checkId: checkIdSchema,
  file: z.string().min(1),
  line: z.number().int().positive().optional(),
  message: z.string().min(1),
};

export const autoFixableFindingSchema = z.object({
  ...baseFindingShape,
  proposedFix: fixProposalSchema,
});

/**
 * A finding the LLM cannot auto-fix — `proposedFix` is `null` by contract.
 *
 * V1.3.1-5 behavior boundary: a real `claude` run reproducibly OMITS the
 * `proposedFix` key on manual findings (a model dropping a null-valued field,
 * even though the check prompt explicitly asks for `proposedFix: null`).
 * `.default(null)` treats a *missing* key as `null` so the finding parses
 * either way; an explicit non-null value still fails (a manual finding must
 * not carry a fix). The inferred output type stays exactly `null`, so
 * `normalizeFinding`'s `proposedFix === null` discriminator is unchanged.
 */
export const manualFindingSchema = z.object({
  ...baseFindingShape,
  proposedFix: z.null().default(null),
  explanation: z.string().min(1),
});

export const findingSchema = z.union([autoFixableFindingSchema, manualFindingSchema]);

export const findingsSchema = z.array(findingSchema);

export const generatedFileSchema = z.object({
  path: z.string().min(1),
  content: z.string().max(MAX_GENERATED_FILE_BYTES),
});

export const generatorOutputSchema = z.object({
  files: z.array(generatedFileSchema).min(1),
});

/**
 * V1.3.1-3 — schema for the `-f json` output of `ui5lint` and `eslint`,
 * parsed by the batched baseline-lint path (`src/verify/baseline-lint.ts`).
 *
 * Subprocess stdout crosses the trust boundary (CLAUDE.md §2.12), so the JSON
 * array is validated before any field is read. Both linters emit a top-level
 * array of per-file results; the shape below is the intersection both
 * produce — extra tool-specific keys (eslint's `suppressedMessages`,
 * ui5lint's `ui5TypeInfo`) pass through untouched. A parse failure here is
 * the signal the baseline-lint path uses to route a tool failure (an eslint
 * exit-2 config error, a crash, a timeout) to `unattributable` rather than
 * mistaking it for "all files clean".
 */
export const lintMessageSchema = z
  .object({
    ruleId: z.string().nullable().optional(),
    severity: z.number().optional(),
    line: z.number().optional(),
    column: z.number().optional(),
    message: z.string(),
  })
  .passthrough();

export const lintFileReportSchema = z
  .object({
    filePath: z.string().min(1),
    messages: z.array(lintMessageSchema),
    errorCount: z.number(),
    warningCount: z.number(),
    fatalErrorCount: z.number(),
  })
  .passthrough();

export const lintReportSchema = z.array(lintFileReportSchema);

export type LintMessage = z.infer<typeof lintMessageSchema>;
export type LintFileReport = z.infer<typeof lintFileReportSchema>;

export type SafeJsonResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export function safeJson<S extends ZodTypeAny>(
  stdout: string,
  schema: S,
): SafeJsonResult<z.infer<S>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    return {
      ok: false,
      error: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, error: `Schema validation failed: ${result.error.message}` };
  }
  return { ok: true, data: result.data };
}
