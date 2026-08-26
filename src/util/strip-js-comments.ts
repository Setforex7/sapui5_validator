/**
 * Strip JS line + block comments while preserving string literals.
 * Returns a string of the SAME LENGTH as the input — comment characters
 * are replaced with spaces (newlines inside block comments are kept) so
 * byte offsets in the stripped content map cleanly onto the original.
 *
 * String-aware: a `//` or `/*` inside a `"`, `'`, or backtick literal is
 * NOT treated as a comment, and string contents (including escapes) pass
 * through untouched.
 *
 * Regex-literal aware (A4): a `/` at an expression position starts a regex
 * literal, so a quote inside it (e.g. `var re = /(['"])/`) no longer flips the
 * scanner into a phantom string state that would swallow a trailing comment or
 * following config. The regex/division ambiguity cannot be fully resolved by a
 * scanner — see `regexLiteralAllowed` for the conservative heuristic and its
 * one documented residual case (statement-position `if (x) /re/`).
 *
 * Shared by `src/project/test-layout.ts` (tolerant karma-config regexes)
 * and `src/project/controller-imports.ts` (so a commented-out
 * `sap.ui.define([...])` above the live one cannot hijack the import
 * parse — V1.4-11).
 *
 * COR-5: pass `{ maskRegexLiterals: true }` to ALSO blank regex-literal bodies
 * to spaces (still length-preserving). The default leaves them intact (a
 * regex's body is code, not a comment). `controller-imports.ts` opts in so a
 * `/sap.ui.define(['sap/m/Button'])/` regex literal cannot be mistaken for the
 * real `sap.ui.define([` head and fabricate phantom imports.
 *
 * V1.9 GA1-09 — **TypeScript audit (no rewrite).** Comments, strings, and
 * template literals are lexically identical in JS and TS, so the masker is
 * correct on TS source for those constructs (witnessed in the test suite over a
 * TS-shaped controller and a `karma.conf.ts`). The one residual TS-specific
 * hazard is the regex-vs-division heuristic ({@link regexLiteralAllowed}):
 * `<` and `>` are in {@link REGEX_PREFIX_PUNCT} (they are JS comparison/shift
 * operators), so a `/` immediately following a `>` that actually *closes a TS
 * generic* (`Map<string, number>`) or follows a TS `as`/angle-bracket cast is
 * classified as a regex start rather than division. This is the SAME class as
 * the already-documented `if (x) /re/` statement-position residual — bounded,
 * and harmless on the surfaces these strippers actually run over (karma-config
 * object literals and `sap.ui.define` import arrays, neither of which places a
 * generic-closing `>` immediately before a division `/`). A full fix needs a
 * type-aware lexer, which is explicitly out of V1.9 scope (no `typescript`
 * dependency); the witness in `strip-js-comments.test.ts` pins both the
 * works-as-is cases and this residual so a future regression is a signal.
 */
export interface StripJsCommentsOptions {
  readonly maskRegexLiterals?: boolean;
}

export function stripJsComments(
  content: string,
  options: StripJsCommentsOptions = {},
): string {
  const mask = options.maskRegexLiterals === true;
  let i = 0;
  const out: string[] = [];
  let stringQuote: '"' | "'" | '`' | null = null;
  while (i < content.length) {
    const ch = content.charAt(i);
    const next = content.charAt(i + 1);
    if (stringQuote !== null) {
      out.push(ch);
      if (ch === '\\' && next !== '') {
        out.push(next);
        i += 2;
        continue;
      }
      if (ch === stringQuote) stringQuote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      stringQuote = ch as '"' | "'" | '`';
      out.push(ch);
      i++;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < content.length && content.charAt(i) !== '\n') {
        out.push(' ');
        i++;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      out.push(' ', ' ');
      i += 2;
      while (i < content.length) {
        const cc = content.charAt(i);
        const cn = content.charAt(i + 1);
        if (cc === '*' && cn === '/') {
          out.push(' ', ' ');
          i += 2;
          break;
        }
        out.push(cc === '\n' ? '\n' : ' ');
        i++;
      }
      continue;
    }
    if (ch === '/' && regexLiteralAllowed(out)) {
      // Regex-literal awareness (A4). A `/` at an expression position starts a
      // regex literal, not division — and a quote *inside* it (e.g. `/(['"])/`)
      // must NOT flip the scanner into a phantom string state, or a trailing
      // `// comment` and any following real config would be swallowed. The body
      // is code (not a comment), so it passes through unchanged; character
      // classes are tracked so a `/` inside `[...]` is not read as the close.
      // COR-5: under `maskRegexLiterals`, the whole literal (delimiters + body)
      // is blanked to spaces so a `sap.ui.define([...])` *inside* a regex can
      // never be mistaken for the real head.
      out.push(mask ? ' ' : '/');
      i++;
      let inClass = false;
      while (i < content.length) {
        const rc = content.charAt(i);
        if (rc === '\\') {
          out.push(mask ? ' ' : rc);
          const rn = content.charAt(i + 1);
          if (rn !== '') {
            out.push(mask ? ' ' : rn);
            i += 2;
          } else {
            i++;
          }
          continue;
        }
        if (rc === '\n') break; // unterminated literal — let the outer loop handle the newline
        out.push(mask ? ' ' : rc);
        i++;
        if (rc === '[') inClass = true;
        else if (rc === ']') inClass = false;
        else if (rc === '/' && !inClass) break; // closing delimiter
      }
      continue;
    }
    out.push(ch);
    i++;
  }
  return out.join('');
}

// A `/` begins a regex literal (rather than division) only at an expression
// position. We approximate that from the previous significant character of the
// already-emitted output (comments are blanked to spaces there, so they read as
// whitespace and are skipped). Conservative by design: the regex/division
// ambiguity cannot be fully resolved by a scanner, so a `/` after `)`, `]`, or
// `}` is treated as division (the common `if (x) /re/` statement-position case
// is the documented residual limitation). This is sufficient for the karma/
// controller config shapes the strippers actually see.
const REGEX_PREFIX_PUNCT: ReadonlySet<string> = new Set([
  '(', ',', '=', ':', '[', '{', ';', '!', '&', '|', '?', '+', '-', '*', '%', '<', '>', '^', '~',
]);
const REGEX_PREFIX_KEYWORDS: ReadonlySet<string> = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'do',
  'else', 'case', 'yield', 'await', 'throw',
]);

function regexLiteralAllowed(out: readonly string[]): boolean {
  let j = out.length - 1;
  while (j >= 0) {
    const c = out[j];
    if (c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r') break;
    j--;
  }
  if (j < 0) return true; // start of input → expression position
  const prev = out[j] ?? '';
  if (REGEX_PREFIX_PUNCT.has(prev)) return true;
  if (/[A-Za-z0-9_$]/.test(prev)) {
    // Identifier/number/keyword ending here — a regex follows only a keyword.
    let k = j;
    while (k >= 0 && /[A-Za-z0-9_$]/.test(out[k] ?? '')) k--;
    return REGEX_PREFIX_KEYWORDS.has(out.slice(k + 1, j + 1).join(''));
  }
  return false; // ) ] } closing quote etc. → postfix position → division
}
