# Changelog

All notable changes to `sapui5-validator` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.5.1] — 2026-08-26

### Fixed
- Generated TypeScript tests no longer import from
  `"sap/ui/thirdparty/qunit-2"`: the import type-checks, but the project's
  ESM→AMD transpile loaded `qunit-2.js` a second time ("QUnit has already
  been defined") and no test ever ran. Both TypeScript prompts now forbid
  importing `QUnit` (a pre-loaded browser global); JavaScript prompts
  unchanged.
- The TypeScript test shape check rejects any mention of that module
  specifier (post comment-strip, any import spelling), feeding the
  refinement feedback and the quarantine reason.

### Added
- TypeScript `generate` runs now stamp the run-level `report.verification`
  marker (`static-only` / `lint-only`) and print the never-executed banner —
  previously only per-test suffixes said so. `schemaVersion: 2` unchanged.

## [1.5.0] — 2026-07-13

### Added
- **Cross-run detection result cache, on by default.** `validate` serves
  unchanged detection checks from a per-project content-hash cache under
  `.sapui5-validator/cache/`. Only batched semantic detection calls are
  cached — never fix refinement, generation, verification/acceptance, the
  deterministic checks, or error findings. The key hashes the fully
  assembled batch prompt plus the prompt version, check-id set, model, and
  `claude` CLI version; a hit consumes no budget or per-category cap.
  Entries are untrusted input: strict validation on read; tampered content
  degrades to a miss. On real SAPUI5 projects, a warm re-run after a typical
  edit ran about half the LLM calls at roughly a tenth of the cost, with
  byte-identical findings.
- **Honesty surfaces.** Served findings carry `cached: true`; `report.json`
  gains `cache: { hits, misses, servedRunIds }`; the audit trail records
  each serve and never fabricates a transcript for a call that did not
  happen; the CLI and HTML report label cached results; reports with
  `cached` markers but no counters are refused.
- **`--cache` / `--no-cache` on `validate`** (default on); the programmatic
  `ValidateOptions.cache` stays opt-in for embedders.

### Changed
- `--force` bypasses cache reads (a forced run is a fresh measurement) while
  still writing fresh entries. `report.json` stays `schemaVersion: 2`.

## [1.4.0] — 2026-07-11

### Changed
- **Both commands now default to `--concurrency 2`** (`--concurrency 1`
  restores the previous sequential behavior), raised after measured
  real-project speedups of roughly 10–22% with no correctness cost.
- `validate` parallelises its findings-only semantic-check batches and now
  accepts `--concurrency`.
- TypeScript `generate` stays serial by construction (a whole-project
  `tsc --noEmit` racing a peer's in-flight generated file would fail sound
  candidates); glob-auto projects also stay serial; the JavaScript verify
  lane remains serialized, preserving verify-then-accept.

### Added
- **Pool-wide rate-limit backoff:** a run-wide signal drains new worker
  dispatch during an HTTP 429 window.
- **`RunReport.concurrency`** records the degree actually used.
  `schemaVersion: 2`; the never-build firewall is untouched.

## [1.3.0] — 2026-07-04

### Changed
- **Prompt transport: argv → stdin.** The `claude -p` prompt travels over
  the child's stdin; the argv carries flags only, so a large file whose
  assembled prompt used to overflow the OS process-argument ceiling is now
  checked normally. The pre-spawn argv guard remains as a flags-only
  invariant; the audit trail logs the byte-identical prompt.

### Added
- **`RunReport.claudeVersion`** — the detected `claude` CLI version on every
  report, with a warning when it differs from the version this release was
  validated against.
- **`envelope-contract-mismatch`** — a well-formed but wrong-shape `claude`
  envelope is a distinct outcome from malformed model output and skips the
  reformat retry.

### Fixed
- A numeric `api_error_status` (e.g. a 400 "prompt too long" or an enveloped
  429) becomes a per-file API-error finding — the run continues — instead of
  aborting; an enveloped numeric 429 normalises to `'429'` and rides the
  rate-limit backoff.

## [1.2.0] — 2026-07-02

### Added
- **Usage/cost observability:** per-run token usage, cost, turns, and
  session id surfaced as additive-optional `RunReport.usage` /
  `RunReport.totalCostUsd` plus one summary line.
- **`--model <name>`** on both commands plus an opt-in TTY menu; a
  non-default choice is recorded on `RunReport.model`; no model-name
  literals exist in the source.
- **`RunReport.contentTruncations`** counts fix refinements attempted
  against a byte-capped view of the file.

### Changed
- **Batched check fan-out (3N→N controller calls, 2M→M view calls):** one
  prompt per controller covers `no-direct-dom`, `no-sync-odata`, and
  `missing-test-coverage`; one per view covers `missing-i18n` and
  `globals-in-views`. Findings keep their own `checkId`; per-category cap
  accounting is preserved.
- **Smaller generate prompts:** controller source is comment-stripped
  (length-preserving; the audit trail keeps raw bytes); the OPA5 prompt
  embeds a derived view-surface summary instead of the full XML.
- **Read-only checks get a `Read`/`Grep`/`Glob` tool subset** — a per-call
  list can only narrow the frozen allowlist, never widen it.
- **12 KiB refinement content cap** (prevents process-argument overflows)
  with an explicit "return the corrected FULL file" truncation marker.
- **Budget menu recommendation** re-pinned from `candidates × 3` to
  `ceil(candidates × 2)`; the 3-attempt retry cap is unchanged.

### Fixed
- On Linux a missing binary (ENOENT) yielded an empty stderr; the executor
  now falls back to the spawn library's message.

## [1.1.1] — 2026-06-29

### Fixed
- **`static-only` is gated on `tsc` actually running:** a project without
  its own `typescript` dependency skips `tsc --noEmit`, so such runs now
  report `lint-only` instead of a false "type-checked" claim.
  `RunReport.verification` widens additively to
  `"static-only" | "lint-only"`.
- A mid-run HTTP 429 arriving as a non-envelope body is recognised on the
  raw output, engaging the backoff and the honest `rate-limited` exit
  reason instead of "malformed output".
- A TypeScript test importing its controller by a relative path or tsconfig
  alias is reported as a wrong-import miss, not "vacuous".
- On the bundled sinon 1.17 dialect, the TypeScript prompt appends an
  ES-module sinon clause instead of a contradictory AMD clause.
- The shape check accepts `QUnit.test.only` / `.skip`.

### Changed
- `verification: "lint-only"` now also signals a TypeScript run without
  `tsc`; install `typescript` in the project for the full `static-only`
  check.

## [1.1.0] — 2026-06-27

### Added
- **`generate` for TypeScript SAPUI5 — `.qunit.ts`, static-only,
  QUnit-only.** Emits native ES-module `.qunit.ts` tests (controller
  imported by its ES specifier, never AMD), accepted only if they pass the
  static lane — `ui5lint` + `tsc --noEmit` + config-gated `eslint` — plus a
  shape check (a `QUnit.test` asserting against the controller), so a
  type-checking-but-vacuous test cannot be accepted. Three failed attempts
  quarantine to `webapp/test/_failing/<Name>.failing.qunit.ts`. Per-test
  `verification: "static-only"` on the CLI and in `report.json`. Requires
  an existing `webapp/test/` layout; OPA5-for-TypeScript is deferred.

### Security
- **Never-build firewall extended to `generate`.** The verify input carries
  the source language at its choke point, structurally routing TypeScript
  runs to the static-only lane — karma-running a `.ts` would transpile it
  through the project's own babel config (arbitrary in-process code
  execution). A "karma call count is 0 on TypeScript" guard is asserted at
  the verify step and the baseline probe; JavaScript path byte-identical.

### Known limitations
- Generated TypeScript tests are type-checked and linted but never executed;
  a mid-run rate limit surfaces as `no-output` (fixed in 1.1.1).

## [1.0.1] — 2026-06-24

Fixes defects found by validating a real TypeScript SAPUI5 project.

### Fixed
- **TypeScript `validate` can now reach exit 0.** The
  `baseline-unpreloaded-libs` check predicts a karma preload hang, but a
  TypeScript run never executes karma — yet the check forced a permanent
  exit 1 with no flag to clear it. It and its CDN probe are now gated off
  for TypeScript (UI5 lazy-loads undeclared libraries at runtime).
- **Deep core-bundled namespaces no longer false-flagged (JavaScript too):**
  the exclusion is now prefix-aware, so an import like `sap/base/i18n/…` no
  longer produces a bogus gap — except under `sap.ui`, which stays
  exact-only so its real layered libraries remain flaggable.
- The `unfixed-findings` exit message no longer claims findings were
  "reverted after 3 attempts" when they were never fix-attempted.
- **Deterministic `missing-test-coverage` triage:** sources that no in-scope
  test references collapse into one rolled-up finding with zero LLM calls (on
  a real project: 49→36 LLM calls, 85 coverage findings→1).

## [1.0.0] — 2026-06-22

First public release, adding TypeScript-SAPUI5 support for `validate` (no
new runtime dependency; the JavaScript path is byte-identical).

### Added
- **TypeScript support for `validate`.** Auto-detected (`.ts` controllers
  under `webapp/`, a `tsconfig.json`, or a `ui5-tooling-transpile` task) and
  validated end-to-end: TS-aware discovery (excluding `.d.ts` and generated
  files), an ES-module import parser feeding the dependency-graph checks,
  and the seven semantic checks framed as TypeScript (ES-module / `class`,
  never AMD). `generate` still refuses TypeScript (added in 1.1.0).
- **`tsc --noEmit` verify step.** The static lane is `ui5lint` +
  `tsc --noEmit` + config-gated `eslint`; `tsc` runs as the project's own
  subprocess (never bundled with the CLI) and is skipped when the project
  ships no `typescript`.
- **`verification: "static-only"` marker** on every passing TypeScript run
  (CLI and `report.json`); the post-fix suite gate records `not-run` — a
  TypeScript run is never a silent "clean".

### Security
- **The never-build firewall.** A TypeScript run never invokes `karma` or
  `ui5 build` — enforced structurally and asserted by tests (karma call
  count proven 0). Transpiling a `.ts` through the project's own babel
  config would be arbitrary in-process code execution — the one trust
  boundary the CLI never crosses. The cost is the documented static-only
  verify limit.

## [0.9.0] — 2026-06-16

Deploy-readiness release: security hardening, correctness fixes, and
packaging / CI.

### Security
- **Symlink/junction traversal DoS:** project globs pass
  `followSymbolicLinks: false` through a shared helper with a loud
  file-count cap, so a junction cycling back to an ancestor fails fast.
- **CDN-probe SSRF guard:** the karma-supplied `ui5.url` is validated before
  any network call — non-`http(s)` schemes and loopback / private /
  metadata hosts refused without a fetch; redirects never followed.
- **Bounded LLM file bodies:** an over-cap payload becomes a
  malformed-output finding, not an unbounded write.
- `--` end-of-options for eslint positionals; control-character stripping on
  LLM/project-supplied names in terminal output; the baseline lint path
  rejects `..`-escaping paths.

### Fixed
- The clean-tree guard fails closed on git errors; a rate-limit-exhausted
  call still writes its audit pair; success-path audit writes are
  best-effort.
- Object-form karma `files:` entries round-trip; `client.libs` parsing is
  brace-balanced; `sap.ui.define` head matching is regex-literal-aware.
- Layout-aware controller resolution; the per-category cap fails safe; the
  npx fallback is time-bounded; the HTML report renders `generatedTests`,
  `postFixSuite`, and `sinonDialect` sections.
- A pre-existing glob-style `.gitignore` covering `.sapui5-validator/` is
  recognised; the Windows argv guard measures UTF-16 code units (no false
  refusals of CJK-heavy prompts); `generate` no longer mis-attributes a
  rate-limit exhaustion as a content failure.

### Changed
- **Packaging:** `LICENSE` (ISC), repository metadata,
  `publishConfig.access: "public"`, sourcemaps trimmed, shebang asserted.
- **CI / supply chain:** Node 20/22 matrix with type-check, audit, and
  pack-dry-run gates; the release workflow fires only on a published GitHub
  Release — tagging alone cannot publish; production `npm audit` is clean.

## [0.8.1] — 2026-06-12

Security patch release.

### Security
- **Symlink/junction write-containment bypass:** every project write goes
  through one shared realpath-based assert (root and nearest existing
  ancestor canonicalized); an escape throws `OutsideProjectRootError`,
  never a silent skip — replacing a lexical check a junction provably
  bypassed.
- **Uncontained `generate` write path:** the generated-test target (derived
  from the project's own karma `files:` glob) is asserted before any LLM
  call; the quarantine move, registration, manifest, and report/audit
  writes carry the same assert.
- **Audit trail guaranteed gitignored:** a self-scoped
  `.sapui5-validator/.gitignore` (`*`) is written every run, so scanned
  source and LLM transcripts are never git-trackable.
- **Dead dependency removed** (`diff` + `@types/diff`), clearing the only
  runtime-reachable `npm audit` advisory.

### Changed
- A write target resolving outside the project root (e.g. a monorepo karma
  glob at `../shared/test/**`) is refused loudly instead of written.

## [0.8.0] — 2026-06-11

Verify-pipeline integrity: the verify → revert → quarantine spine holds
under environmental failure, exceptions, and concurrency.

### Fixed
- **Karma classifier hardening:** `module-load-failure` requires positive
  module-system evidence; bootstrap markers anchor to karma's own error
  lines; transient network failures retry once, then classify
  `runner-unavailable` — an environmental blip can never permanently
  quarantine a sound test.
- **Post-fix suite gate on `validate`:** the qunit suite runs once after
  the fix phase; on red, all applied fixes revert byte-exact, recorded
  under `revertedFixes` with the new `postFixSuite` field.
- **Exception safety:** a throwing verify releases the lane permit and
  unregisters the candidate; the quarantine rename retries on Windows
  EPERM.
- `--auto-apply-baseline-fixes` refuses heuristic-derived namespaces when
  no CDN probe ran; more libraries join the known-library table.
- **OPA5 parity:** a quarantined journey is contained like a QUnit test,
  and a `passed` journey karma never executed carries
  `verification: "lint-only"`.

## [0.7.1] — 2026-06-11

### Fixed
- Fix findings are pinned to the scanned target and the resolved path is
  asserted inside the project root before any write.
- When budget/rate-limit exhaustion kills the initial call, the report says
  `no-output` instead of fabricating a `quarantined` entry.
- The CLI sets `process.exitCode` instead of `process.exit()`, so piped
  `--json` stdout is never truncated.
- The fix-refinement LLM path gains the same 429 backoff as other call
  sites.
- Base-ref fallback chain (requested → `origin/HEAD` → `main` → `master`)
  with a stderr notice whenever the scope widens to the full project.
- The clean-tree check disregards the `.gitignore` amendment the tool
  itself wrote.
- The controller module-id pin threads into refinement prompts; four check
  prompts gain the fix-or-`proposedFix:null` dual-shape block.

## [0.7.0] — 2026-06-10

### Added
- **Opt-in parallel `generate` (`--concurrency N`, default 1).**
  Measurement of a real whole-project run attributed ~85% of the time to
  sequential LLM generation latency; a bounded worker pool now overlaps
  those calls while a single run-wide verify lane serialises
  register→verify→accept, so no worker's whole-suite karma run can see
  another's unverified test. Measured 2.27× faster at N=2 on a real
  project with verify-then-accept intact.
- **Lane-safe discovery gate:** glob-auto projects (karma auto-collects any
  on-disk `*.qunit.js`) fall back to serial with an explanatory note.

### Fixed
- **Wrong controller import for `*.controller.js` files:** the prompt gave
  the file path but not the module id, so the model intermittently
  imported a non-existent module (karma 404 → page hang → spurious
  quarantine). The prompt now pins the exact module id, derived the same
  way as registration.

## [0.6.0] — 2026-06-06

Runtime hardening: parser robustness on legal-but-unusual inputs.

### Fixed
- A leading UTF-8 BOM no longer aborts `manifest.json` parsing (shared
  BOM-stripping reader on all five parse sites).
- Comment stripping is regex-literal-aware, and nested `ui5.url` parsing is
  brace-balanced and string-aware, so legal config shapes no longer disable
  the CDN probe or swallow `client.libs`.
- The registration and karma `files:` parsers use string-aware delimiter
  matching over comment-masked content — an inline `]`, object-form entry,
  or char-class glob no longer corrupts a rewrite.
- A test quarantined under `webapp/test/_failing/` is kept out of glob-auto
  karma suites and the `validate` scope.
- A pre-spawn guard fails an argv-overflowing prompt deterministically with
  an accurate message; refinement feedback is byte-budgeted under its cap.
- Library derivation matches the longest entry in a curated known-library
  table before the 3-segment heuristic (`sap/viz/…` → `sap.viz`, not a
  phantom namespace that could hang karma via the manifest).

## [0.5.0] — 2026-06-02

Adds a proactive prevention layer for the karma module-load failures 0.4.2
could only diagnose after the fact.

### Added
- **Project dependency graph:** a deterministic pass computes each
  controller's `sap.ui.define` imports against the manifest's declared libs
  and the karma `client.libs` override — the gap being libraries that will
  not preload in karma-ui5's test runtime.
- **`baseline-unpreloaded-libs` check + `--auto-apply-baseline-fixes`:** a
  no-LLM baseline check emits one finding per gap with a proposed
  `manifest.json` patch, applied only under the explicit flag (default
  off); otherwise affected controllers are skipped with `report.json`
  status `'skipped-baseline'`. Wired into both commands.
- **Project-context prompt block:** for a non-preloading library, the
  generation prompt instructs the LLM to pre-register a no-op stub module.
- **karma-CDN availability probe:** a CDN-served library takes the
  manifest-fix path; a CDN-absent one routes to the stub path (declaring it
  would only hang karma); probe uncertainty defaults to "served".

### Changed
- System prompt strengthened with shape examples; importing
  `sap/ui/thirdparty/sinon-qunit` is forbidden (it throws against the
  bundled sinon).
- Module-load quarantine messages discriminate the failure against the
  project graph, including an own-module case — a controller is never told
  to add its own namespace to the manifest.
- Core-bundled namespaces (`sap.ui.model`, `sap.base`, …) are excluded from
  the gap; a commented-out `sap.ui.define` can no longer hijack the import
  parse.

## [0.4.2] — 2026-05-27

### Fixed
- **Prose-preamble JSON recovery:** a single balanced JSON body surrounded
  by LLM prose is recovered cleanly (fenced code blocks still refused; raw
  output still dumped to the audit trail on malformed calls).
- **Distinct `module-load-failure` classification:** a missing karma
  `client.libs` preload hangs the test page until karma's inactivity
  timeout; previously classified as a test failure, burning refinement
  calls on a config gap the LLM cannot fix. The retry loop now
  short-circuits with a quarantine message naming the failed module id and
  the suggested `client.libs` entry.

## [0.4.1] — 2026-05-25

### Fixed
- **Refinement prompts overflowed Windows' 32,767-character `CreateProcess`
  limit** on large karma failures, killing the subprocess. LLM-facing
  feedback is now capped at 16 KiB (ANSI stripped, head+tail truncation
  with an elision marker; failure lines never dropped) while the audit
  trail keeps raw bytes; `generatedTests[].refinementTruncations` counts
  capped refinements and quarantines carry a structured
  `quarantineReason.phase`.
- **Sinon dialect detection:** karma-ui5 bundles sinon 1.17, but generated
  tests used sinon 2.x-only APIs and crashed. The dialect is now detected
  once per run (surfaced as `RunReport.sinonDialect`) and a bundled-sinon
  clause steers both the initial and refinement prompts toward
  1.17-compatible APIs.

## [0.4.0] — 2026-05-22

`generate`-command robustness release.

### Added
- **LLM-call estimate + interactive call-limit menu on `generate`** (parity
  with `validate`; suppressed under `--no-prompt`, `--json`, non-TTY
  stdin); `--no-prompt` is now accepted by both commands.
- **Baseline progress output** — a status line per phase (timing under
  `--verbose`), on stderr so `--json` stdout stays clean.
- **`karma-unavailable` exit reason** for a runner that is installed but
  cannot start, distinct from `baseline-failed` and
  `missing-required-tooling`; caught before any LLM call.
- **Generated-test registration:** each test's module id is written into
  `testsuite.qunit.html` (and the karma `files:` glob where in play) before
  verification, so karma actually executes it instead of passing
  vacuously; quarantined tests are unregistered.
- **`no-output` generated-test status** in `report.json`, distinguishing a
  generation that produced no file from a quarantined one.

### Changed
- `generate` is QUnit-only by default; OPA5 journeys are opt-in via
  `--opa5-only`.
- Baseline lint is batched in chunked JSON invocations; the baseline karma
  probe is unconditional; verify subprocesses are time-bounded.
- Every typed LLM-call error is handled inside `generate`; a hot rate-limit
  window ends the run with the `rate-limited` exit reason, preserving
  partial progress.

### Fixed
- An omitted `proposedFix` key normalizes to `null` instead of tripping
  schema validation; an uncaught `generate` error produces an emergency
  report naming `generate`, not `validate`.

## [0.3.0] — 2026-05-19

### Added
- **Dynamic LLM call-limit management:** the CLI estimates the calls the
  detected scope needs and presents an interactive menu (keep / accept
  recommendation / custom / cancel). `--per-check-cap <percent>` (default
  `35`) caps any single check category's share of the budget;
  `--no-prompt` skips the menu; rate-limit errors produce a dedicated
  `rate-limited` exit reason with partial results preserved on disk.
- **User-friendly error messages** with a suggested next step; technical
  detail stays in the audit log under `.sapui5-validator/last-run/`.
- **HTML report generation:** `validate --html` writes a static
  `report.html` (inline CSS, no JavaScript, no external assets).

### Changed
- The audit log's documented semantics now match its additive behavior:
  files accumulate across runs.

## [0.2.1] — 2026-05-14

### Fixed
- `--version` reported a hard-coded `0.1.0`; the CLI now reads the version
  from `package.json` at startup.

## [0.2.0] — 2026-05-14

Fixes six bugs exposed by the first run against a real SAPUI5 project.

### Fixed
- `ui5lint` rejected the absolute paths it was given; paths are now
  project-relative POSIX, and a path outside the project root is a typed
  error.
- A `claude` subprocess killed before producing output (typically an
  oversized prompt) is a distinct `ClaudeProcessKilledError` instead of
  "malformed output", and the futile reformat retry is skipped.
- The `claude -p --output-format json` envelope is now unwrapped before
  schema validation (previously every check failed); a non-success
  envelope becomes a typed `ClaudeApiError`.
- Vendor and minified files (`*.min.js`, `vendor/`, `thirdparty/`,
  `dist/`, …) are excluded from all scopes; an explicit matching path is
  refused with a typed error.
- The audit log was written empty — prompts/responses are now recorded via
  a runner decorator and verify transcripts by the verify pipeline;
  `--keep-history` routing into `runs/<ISO>/` works, correlated by call
  id.

### Added
- **Real-toolchain E2E tier** (opt-in via an environment gate) invoking
  the real `claude`, `ui5lint`, `eslint`, and `karma` against a fixture
  project.
- **Typed error classes:** `ClaudeProcessKilledError`, `ClaudeApiError`,
  `Ui5LintFileOutsideProjectError`, `ExcludedPathScopeError`.

## [0.1.0] — Initial release

First release of `sapui5-validator`: the `sapui5-validate` CLI with
`validate` and `generate` commands, the seven baked-in semantic checks, the
verify-then-accept pipeline with a 3-retry cap, the `ClaudeRunner`
abstraction over `claude -p --output-format json`, git-aware change
scoping, and the `.sapui5-validator/report.json` + audit-log artifacts.
See [SPEC.md](SPEC.md) for the design.
