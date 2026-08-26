# Golden parser corpus (V1.9.5 INF-4)

Input files for the four hand-rolled text parsers, one directory per parser:

| Directory            | Parser(s)                                                         | Spec (table-driven)                                |
| -------------------- | ----------------------------------------------------------------- | -------------------------------------------------- |
| `controller-imports/`| `parseControllerImports`, `parseEsModuleImports` (`src/project/controller-imports.ts`) | `test/unit/parser-corpus-controller-imports.test.ts` |
| `json-envelope/`     | `extractJsonValue` (`src/util/json-envelope.ts`)                   | `test/unit/parser-corpus-json-envelope.test.ts`      |
| `strip-js-comments/` | `stripJsComments` (`src/util/strip-js-comments.ts`)                | `test/unit/parser-corpus-strip-js-comments.test.ts`  |
| `test-layout/`       | `parseKarmaClientLibs`, `parseKarmaUi5Url`, `parseKarmaConfig`, `parseTestSuiteHtml`, `detectTestLayout`, `resolveQUnitRoot` (`src/project/test-layout.ts`) | `test/unit/parser-corpus-test-layout.test.ts`        |

## The append-on-incident rule

**Every future parser incident adds its input file here + a table row in the
corresponding corpus spec IN THE SAME COMMIT as the fix.** The corpus is the
regression memory for parsers whose bugs historically surfaced only on real
projects (V1.4-11, COR-5, COR-10, A3/A4, F4, GA1-03/08/09).

## The corpus pins CURRENT behavior

Entries are golden pins of what the parser does **today**, not what it should
ideally do. Entries for still-open gaps carry a **KNOWN LIMITATION** marker in
their spec row; a future fix flips that expectation **deliberately** (the red
spec is the signal that the limitation closed). Current KNOWN LIMITATION pins:

- `controller-imports/a2-named-define.js` — V1.5 #A2 (OPEN): the named
  `sap.ui.define("id", [...])` form yields `[]`.
- `controller-imports/a6-two-defines.js` — V1.5 #A6 (pinned product decision):
  only the FIRST array-form define is parsed.
- `controller-imports/adv-template-literal-define.js` — a template literal
  carrying `sap.ui.define([...])` text ABOVE the real define hijacks the head
  search: the parser returns the phantom `fake/dep` and DROPS the real import
  (template contents survive comment-masking; same class as pre-COR-5 regex
  bodies, unfixed for template literals).
- `strip-js-comments/ga1-09-generic-division.ts` — V1.9 GA1-09 residual: a `/`
  after a generic-closing `>` is misread as a regex start and the trailing
  `// tail` comment leaks unmasked.

## Encoding invariants (do not "fix")

- The local `.gitattributes` (`* -text`) exempts this tree from the repo-root
  `* text=auto eol=lf` rule so the corpus stays **byte-exact** across commits
  and checkouts. Never remove it.
- `adv-bom-*` files start with a literal UTF-8 BOM (`EF BB BF`); `adv-crlf-*`
  and `suite-crlf.testsuite.html` are pure CRLF. The specs guard these traits
  (a normalized fixture fails loudly). Regenerate such files only from a Node
  script writing raw bytes — PowerShell/editor round-trips corrupt them.
- Never name a corpus data file `*.test.ts` (vitest would collect it).

## Read-only at test time

Specs only `readFileSync` from this tree. Directory-shaped cases
(`test-layout/`) materialize the corpus content into a fresh
`mkdtempSync(join(tmpdir(), ...))` sandbox per case and `rmSync` it in
`afterEach` — never write into this directory from a test.
