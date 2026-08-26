/**
 * Tolerant JSON read shared by every `manifest.json` parse site (A5).
 *
 * `readFileSync(path, 'utf8')` does NOT strip a leading UTF-8 BOM (U+FEFF),
 * and `JSON.parse` throws on it — yet a BOM-prefixed file is still valid JSON,
 * and SAP tooling / Windows editors routinely emit one. Without this, a
 * BOM-prefixed manifest aborts project detection (`detect.ts`) or silently
 * collapses the dependency graph's known-library set (`dependency-graph.ts`,
 * `unpreloaded-libs.ts`, `generate.ts`) into a false-positive gap.
 *
 * `parseJsonWithBom` strips a single leading BOM and otherwise behaves exactly
 * like `JSON.parse` — it throws the same `SyntaxError` on genuinely malformed
 * JSON, so callers keep their existing try/catch and degraded fallbacks.
 */

/** Strip a single leading UTF-8 BOM (U+FEFF) if present; otherwise return as-is. */
function stripBom(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

/**
 * Parse JSON that may begin with a UTF-8 BOM. Throws `SyntaxError` on malformed
 * JSON, identical to `JSON.parse`. Returns `unknown` — callers validate the
 * shape (zod / manual narrowing) at the trust boundary per SPEC §2.12.
 */
export function parseJsonWithBom(content: string): unknown {
  return JSON.parse(stripBom(content));
}
