// Corpus: V1.9 GA1-09 residual — a `/` whose previous significant character
// is a generic-closing `>` is misread as a regex start (`>` is a JS operator
// in REGEX_PREFIX_PUNCT; the scanner has no type awareness). The spec pins
// what the masker ACTUALLY does today; a future type-aware fix flips the pin.
declare function pick<T>(): T;
const half = pick<Map<string, number>>
/ 2; // tail
const keep = 1;
