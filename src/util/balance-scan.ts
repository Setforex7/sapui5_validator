/**
 * Find the index of the delimiter that closes the one opened at `openIndex`,
 * balancing nested `open`/`close` pairs and skipping string literals (single,
 * double, and template quotes, honouring backslash escapes) so a delimiter
 * inside a string is never miscounted. Returns the index of the matching close,
 * or `null` when the input is unbalanced before end-of-string.
 *
 * `open` and `close` must be distinct single characters (e.g. `[`/`]`). The
 * scanner does NOT strip comments: callers that need comment-blindness pass
 * content pre-masked by `stripJsComments`, which preserves byte offsets so the
 * returned index maps straight back onto the original content.
 *
 * Shared by `src/generation/registration.ts` (F1 — testsuite/karma registration
 * arrays) and `src/project/test-layout.ts` (F4 — the karma `files:` array),
 * replacing a non-greedy `[\s\S]*?]` that truncated at the first inner `]` (an
 * inline comment `]`, an object-form `included:[...]` entry, or a char-class
 * glob).
 */
export function findMatchingDelimiter(
  content: string,
  openIndex: number,
  open: string,
  close: string,
): number | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openIndex; i < content.length; i++) {
    const ch = content.charAt(i);
    if (quote !== null) {
      if (ch === '\\') {
        i++; // skip the escaped character
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === open) {
      depth++;
      continue;
    }
    if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return null;
}
