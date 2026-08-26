# SAPUI5 Validator — V1 Specification

A CLI that validates SAPUI5 projects and generates tests using a hybrid
deterministic-plus-LLM approach. Linters and test runners are ground
truth. Claude is invoked surgically and every artifact it produces is
verified before being accepted.

---

## 1. Fixed Architectural Decisions

### 1.1 Hybrid deterministic + LLM
The CLI is deterministic TypeScript orchestrating existing SAPUI5
tooling (ui5lint, eslint, karma/QUnit/OPA5). Claude is invoked only
for: generating tests that follow project patterns, identifying
semantic problems linters miss, proposing fixes that require
understanding intent, identifying missing tests.

### 1.2 Verification pattern
Every LLM-produced artifact is written to disk, then lint-checked and
executed. Failures feed back to the LLM for correction in a closed
loop. LLM output is **never** accepted without deterministic
verification. Retry cap is 3 rounds per artifact.

### 1.3 No internal subagents in V1
Single Claude per invocation. No Task tool delegation, no subagent
files. Future writer-reviewer pattern is a V2 concern. This is a
**runtime** rule (the CLI launches one `claude` per invocation);
dev-time tooling under `.claude/` (the cycle agents documented in
`.claude/WORKFLOW.md`) is out of its scope.

### 1.4 Transport: subprocess wrapper over `claude -p`
The CLI invokes the official `claude` binary via subprocess. Reason:
the developer's Max plan covers the official CLI but not API/SDK
billing. All invocations use `--output-format json` and pass an
explicit `--allowedTools` allowlist.

### 1.5 ClaudeRunner abstraction
A `ClaudeRunner` interface exists from day one. `BinaryRunner` is the
only V1 implementation. All consuming code depends on the interface.
Future `SDKRunner` is a single-file swap.

### 1.6 Stack
- Language: TypeScript (strict mode)
- Runtime: Node.js current LTS (≥ 20.x)
- Distribution: npm package with `bin` entry; supports global install
  and local devDependency

### 1.7 Permission scope for runtime `claude -p` invocations
The allowlist — the maximum grant on any `claude -p` call:

```
Read, Grep, Glob, Edit,
Bash(npm test*), Bash(ui5lint*), Bash(eslint*), Bash(npx ui5*)
```

Never: `Bash(rm*)`, `Bash(git push*)`, `Bash(git commit*)`, or any
state-mutating command outside the project's source folders.

**Per-call subset (V1.9.4 PERF-7).** A call site MAY narrow the grant to a
**subset** of the allowlist — never a superset. `buildClaudeArgs` takes an
additive-optional `tools?: readonly string[]` (named `tools`, not
`allowedTools`, so the eslint ban on a literal `allowedTools:` key elsewhere
still holds); it resolves `input.tools ?? ALLOWED_TOOLS` and **asserts every
entry is in `ALLOWED_TOOLS`, throwing otherwise** — a load-bearing runtime guard
so the optional param can only *narrow*, never widen, the §1.7 set. The
read-only checks (`src/checks/_shared.ts`) use this to send only
`['Read','Grep','Glob']` (a findings check never edits or runs Bash); the
test-authoring `generate` and refinement-fix calls keep the full grant. With
`tools` unset the allowlist is byte-identical to before this amendment.

---

## 2. Interview Decisions

### 2.1 Scope and commands

- **Two commands, one binary.** `sapui5-validate validate` and
  `sapui5-validate generate`. Each command has explicit semantics; the
  user opts into the heavier `generate` step.
- **Test types generated:** QUnit and OPA5. `generate` produces QUnit
  tests by default; OPA5 journeys are opt-in via `--opa5-only`
  (V1.3-4 decision — OPA5 journey auto-registration is out of V1
  scope, so default-on OPA5 would ship a vacuous pass; opted-in
  journeys are generated and verified but must be registered by
  hand). `--qunit-only`
  is retained and equivalent to the default. Generated QUnit tests
  adapt to the project's sinon dialect when detectable — `'modern'`
  (npm-installed sinon), `'sap-bundled'` (the karma-ui5 default —
  `sap/ui/thirdparty/sinon`, sinon 1.17), or `'unknown'`; on
  `'sap-bundled'` the prompt steers the LLM away from sinon 2.x APIs
  (`.callsFake`, `.resolves`, `.rejects`, `sinon.createSandbox()`).
- **Granularity:** Both whole-project and per-file. Whole-project is
  default; passing a path scopes to that file.
- **Interaction model:** Auto-apply with checkpoint. The CLI refuses
  to start unless the git working tree is clean. Changes land
  immediately; the user reviews via `git diff`.

### 2.2 Project detection

A directory is a valid SAPUI5 project if **either** is true:

1. `ui5.yaml` exists at the project root, **or**
2. `webapp/manifest.json` exists AND has `sap.app.type === "application"`
   AND `webapp/Component.js` (or `.ts`) exists.

If neither condition is met, exit non-zero with a clear message.

### 2.3 Baseline state policy (mode-dependent)

- **`validate`:** Pre-existing lint or test failures are part of the
  work. The CLI tries to fix them with LLM, same retry budget. A run
  exits 0 only if all baseline issues are resolved (strict).
- **`generate`:** Refuse to run if the existing test suite is red or
  if lint fails on existing code. The existing suite is executed on
  every run, regardless of file scope (a single-file or changed-files
  run included). Print the failures and exit non-zero. Rationale:
  don't pile new tests onto a broken project. A karma test runner
  that is installed but cannot start (config error, missing browser
  launcher, missing plugin) is reported distinctly via the
  `karma-unavailable` exit reason, not `baseline-failed` — the latter
  means the existing tests genuinely failed or lint failed.

### 2.4 No-tests state (generate)

When the project has no existing test files, the CLI **prompts
interactively** to select a starter template. Built-in templates:

- `sap.m` mobile app
- `sap.f` flexible column
- `Fiori Elements`

After a template is chosen, the CLI seeds a minimal test file and
proceeds. Non-interactive runs (`--json` or non-TTY) without an
existing convention fail with a clear message and exit non-zero.

### 2.5 TypeScript

**`validate` supports TypeScript SAPUI5 projects (V1.9), source-static.**
A TS-detected `validate` run discovers `.ts` controllers and `.qunit.ts`
tests, runs the seven checks over the `.ts` source (framed as TypeScript —
ES-module/class, never steered toward `sap.ui.define` AMD), and verifies any
fix through a **static-only** lane: `ui5lint` + `tsc --noEmit` +
(config-gated) `eslint`. It **never** runs karma or `ui5 build` on a TS
project — the **never-build firewall** (see §2.10): karma-running / building a
`.ts` requires a `.ts`→JS transpile — Babel, `ui5-tooling-transpile`, or any
other tool, under **whatever** config (the project's own `babel.config.js`, a
preset, or none), in-process **or** as a subprocess — and that transpile is
arbitrary code execution, the one trust boundary the CLI never crosses. The
prohibition is on the transpile itself, not on a particular config file.

The honest cost is a documented V1.9 limit: a TS fix is proven to compile +
lint + type-check, but the **test suite is never executed**, so "this fix did
not break a test" is not runtime-verified for TypeScript. The run reports
`verification: "static-only"` when `tsc` actually ran; when the project does
**not** ship its own `typescript` the `tsc --noEmit` step is skipped (the CLI
bundles no `tsc`) and the lane narrows to `ui5lint`, so the marker is gated down
to **`lint-only`** (V1.9.3 D1) — it never claims "type-checked" when `tsc` did
not run. The marker is surfaced on the CLI and in `report.json` so the limit is
explicit — never a silent "clean". A TS project with no usable static toolchain
(`ui5lint` absent) still refuses with `missing-required-tooling`, never a silent
pass.

**`generate` supports TypeScript source-static (since 1.1.0).** On a TS project
`generate` emits idiomatic `.qunit.ts` unit tests (ES-module / `class`, the
controller imported by its ES specifier — never `sap.ui.define` AMD) and accepts
each through the **same static-only lane** `validate` uses (`ui5lint` + `tsc
--noEmit` + config-gated `eslint`), plus a shape check that the test asserts
against the controller under test — **never karma** (the never-build firewall).
The TS prompt contract and the shape gate both forbid importing QUnit (V1.9.9):
`@sapui5/types` declares `sap/ui/thirdparty/qunit-2`, so
`import QUnit from "sap/ui/thirdparty/qunit-2"` is tsc-green — but the
project's ESM→AMD transpile loads qunit-2.js a **second** time next to the
testsuite HTML's `<script>` tag, double-defining QUnit and killing the whole
suite at runtime. `QUnit` must stay the ambient global; any mention of the
qunit-2 specifier in a generated test is rejected by the shape gate
(condition (d), `checkTsTestShape`) and refined or quarantined.
A generated test is reported `verification: "static-only"` (or `lint-only` when
the project ships no `typescript` and `tsc` was skipped — V1.9.3 D1); since
V1.9.9 a TS `generate` run also stamps the **run-level**
`report.verification` marker and prints the same honest never-executed banner
`validate` prints. One that
cannot pass the lane in 3 attempts is quarantined to
`webapp/test/_failing/<Name>.failing.qunit.ts`. TS generation is **QUnit-only**
and requires an existing `webapp/test/` layout this cycle; OPA5-for-TS and `.ts`
scaffolding remain deferred (§7).

### 2.6 Git working-tree policy

Refuse to run if the working tree is dirty. `--force` flag overrides.
Aligns with the auto-apply-with-checkpoint model: `git diff` is the
audit trail.

The clean-tree gate **fails closed** (COR-1): only the absence of a git
repository is treated as "proceed" (a non-versioned tree gives the user
file-system control, and `--force` exists for explicit overrides). Any
*other* git failure — a corrupt index, a locked ref, a permission error —
aborts the run with a clear error rather than being silently swallowed as
"clean"; re-run with `--force` to bypass the check once the tree is known
to be safe.

### 2.7 Test layout detection

Detect from `karma.conf.js` (or `karma.conf.ts`) and/or
`webapp/test/testsuite.qunit.html`:

- Parse karma config for test glob roots.
- Parse `testsuite.qunit.html` for `<a>` entries pointing at QUnit
  test pages, and (V1.3-4) for the karma-ui5 html-mode
  `sap.ui.require([...])` module-id array. `generate` also *writes*
  that array — and the karma `files:` array — to register the QUnit
  tests it produces so the verify step actually executes them
  (SPEC §2.9).
- If neither file exists, fall back to standard SAPUI5 layout:
  - QUnit: `webapp/test/unit/<mirror of webapp/>/<Name>.qunit.js`
  - OPA5: `webapp/test/integration/<Journey>.qunit.js`
- If a path cannot be inferred unambiguously, exit non-zero.

### 2.8 LLM-driven semantic checks (V1: 7 baked-in)

Each check is one module under [src/checks/](https://github.com/Setforex7/sapui5_validator/tree/master/src/checks/), structured
so the list is easily extended. V1 checks:

1. **No direct DOM access in controllers** — flag uses of
   `document.querySelector`, `document.getElementById`, jQuery selectors
   outside `byId()` lookups.
2. **No synchronous OData calls** — flag `async: false` or sync
   `loadData` / `read` calls on OData models.
3. **Missing teardown in tests** — flag QUnit modules that create UI
   controls without `afterEach` cleanup / `destroy()`.
4. **Missing i18n** — flag hardcoded human-readable strings in views
   (`.view.xml`) that should be `{i18n>...}` keys.
5. **Manifest / Component drift** — flag routes, targets, models, or
   dataSources declared in `manifest.json` that are unreferenced (or
   vice versa) in `Component.js`.
6. **Globals in views** — flag XML view bindings to global window
   properties or undefined controller methods.
7. **Missing test for exported public method** — flag controllers /
   helpers whose exported methods have no corresponding QUnit test.

Each check returns findings of the shape:

```typescript
{
  checkId: string;
  file: string;
  line?: number;
  message: string;
  source: 'check' | 'baseline';   // required on every finding
} & (
  | { proposedFix: { newFileContent: string } }  // single file only
  | { proposedFix: null; explanation: string }   // multi-file: surfaced, no auto-apply
)
```

If a finding genuinely requires multi-file changes, the LLM is
prompted to return `proposedFix: null` and a human-readable
explanation. The finding is surfaced; no auto-apply.

`newFileContent` is hard-capped at `MAX_GENERATED_FILE_BYTES` (1 MiB,
`src/util/schema.ts`); a larger body is rejected at the `zod` trust
boundary as malformed output and never written to disk (SEC-3).

### 2.9 Fix scope rules

- **`validate` fixes:** Single file per finding. Multi-file fixes are
  surfaced as findings without `proposedFix` and require human action.
- **`generate`:** Multi-file writes allowed (test file + update to
  `testsuite.qunit.html` and/or karma `files` glob if needed). All
  touched files go through the verification pipeline post-write.

### 2.10 Verification pipeline per artifact

For any file the CLI writes (fix or generated test):

1. `ui5lint` on the file (required if installed; project-aware).
2. `eslint` on the file (optional; skip with warning if not configured).
3. Test runner on the affected test file(s):
   - QUnit: run via karma if present, else fail and surface that karma
     is required for verification. A karma that is present but cannot
     start — a config error, a missing browser launcher, or a missing
     plugin — is classified distinctly from a test that ran and failed;
     it aborts `generate` with a `karma-unavailable` exit reason rather
     than being absorbed into a per-test verification failure.
   - OPA5: same — karma if present, else lint-only fallback with a
     warning that OPA5 was not executed.

**TypeScript static lane (V1.9 — the never-build firewall).** For a
TypeScript-detected `validate` run the pipeline takes a **static-only** lane:
`ui5lint` → `tsc --noEmit` → (config-gated) `eslint`, with **no karma / `ui5
build` step at all** — step 3 above is structurally absent for `.ts`, and both
of validate's karma calls (the baseline suite probe and the post-fix suite
gate) are skipped. Karma-running or building a `.ts` would transpile it —
Babel / `ui5-tooling-transpile` / any tool, under whatever config (or none),
in-process **or** as a subprocess — which is arbitrary code execution (the one
trust boundary the CLI never crosses), so **any** `.ts`→JS transpile is
forbidden by construction, not by convention — the ban is on the transpile, not
on a named config file (a `configFile:false` "hermetic" Babel is still a
forbidden transpile on a `.ts` artifact). `tsc --noEmit` is the **project's own** `tsc` (invoked exactly
like the other tools — `shell:false`, explicit args, the same per-subprocess
timeout), never a dependency bundled into the CLI, and is skipped when the
project ships no `typescript` (ui5lint still type-checks the `.ts`). eslint
lints `.ts` only when the project ships a TS-aware eslint config (a
`typescript-eslint` parser); otherwise `.ts` is dropped from the eslint step
(ui5lint covers it) rather than fed a parse error. The run carries
`verification: "static-only"`: the test suite is never executed for
TypeScript, a documented limit — not a silent "clean".

A failing step is fed back to the LLM with the exact error output.
Retry cap: 3 rounds per artifact. After 3 failures:

- **Fix proposal:** Revert the file to its pre-fix state. Record the
  failure in the report.
- **Generated test:** Keep the file, but rename it to
  `<Name>.failing.qunit.js` and move it under
  `webapp/test/_failing/`. Update `testsuite.qunit.html` to exclude
  `_failing/` (if a karma `files` glob is in play, ensure it does not
  pick up `_failing/`). Record the failure.

Refinement prompts cap the embedded verify feedback at
`MAX_PROMPT_FEEDBACK_BYTES` (16 KiB; ANSI stripped, karma per-test
progress lines dropped, head+tail truncation with an explicit elision
marker, never-drop guards for stack-frame and failure-keyword lines) to
bound its token cost: the feedback is the volatile part of the prompt —
it changes each attempt, so it is re-sent as uncacheable input on every
retry, and the cap keeps that input-token cost bounded. (Pre-V1.9.6 the
prompt travelled on argv and the cap kept it under the Windows
`CreateProcess` 32,767-char ceiling; since the V1.9.6 TR-1 stdin
transport that ceiling no longer applies.) The `VerifyResult.feedbackForLlm`
field and the on-disk audit trail at `last-run/verify/<callId>-<step>.txt`
remain raw and unmodified — the prompt-vs-audit asymmetry is intentional
and load-bearing for debuggability.

In addition, the karma verification step distinguishes *bootstrap-time
runner unavailability* (karma never reached a runnable state — pre-V1.3.3
`'runner-unavailable'`) from *runtime module-load failure* (karma
launched, the browser launched, but a project-config-shaped UI5 module
dependency failed to load and karma's `browserNoActivityTimeout` fired).
The latter is classified as `'module-load-failure'` and routed to a
per-test quarantine on first occurrence with a `phase: 'module-load'`
reason; refinement is not attempted because the LLM cannot fix a
karma-config gap from the test-file side. The quarantine message names
the failed module ID when extractable and suggests the missing
`client.libs` entry. The on-disk audit trail at
`last-run/verify/<callId>-<step>.txt` remains raw and unmodified.

Before that classification runs, a karma failure carrying
transient-network evidence (`ENOTFOUND` / a failed proxy) triggers
exactly one **zero-LLM-budget** karma re-run
(`hasTransientNetworkEvidence`, `src/verify/pipeline.ts`); a second
consecutive transient failure is classified run-level as
`'runner-unavailable'`, so a CDN/DNS blink never quarantines a sound
candidate (R2.1c).

**Proactive prevention layer (V1.4).** The classifier above is the
*reactive* surface — it handles a module-load failure after karma has
already burned `browserNoActivityTimeout` on it. V1.4 adds a *proactive*
layer that predicts the failure before any LLM call. A deterministic
project dependency graph (`buildProjectGraph`) parses each in-scope
controller's `sap.ui.define([...])` imports, derives their library
namespaces, and diffs them against what karma-ui5 will preload in the test
runtime — the union of `manifest.json`'s `sap.ui5.dependencies.libs`, the
karma.conf.js `client.libs` override, the always-available set
(`sap.ui.core`, `sap.ui.thirdparty`), and the `sap.ui.core`-bundled
namespaces (`sap.ui.model`, `sap.base`, …). Each remaining import is a
*gap*. A deterministic `baseline-unpreloaded-libs` baseline check (no LLM;
runs alongside `baseline-ui5lint` / `baseline-eslint` / `baseline-karma`)
emits one finding per gap. Gaps are then split by a best-effort CDN probe
against the configured karma `ui5.url`: a **CDN-served** lib gets a
`manifest.json` auto-fix (declare it under `sap.ui5.dependencies.libs`,
the whole `libs` object re-alphabetised, indent + trailing newline
preserved); a **CDN-absent** lib (e.g. SAPUI5-only `sap.ui.export` on the
OpenUI5 CDN) is NOT written to the manifest — that would only make karma
hang — and is instead routed to a test-side stub: the generation prompt
gains a block instructing the LLM to pre-register a no-op stub module so
karma's loader resolves it from cache. Probe uncertainty (timeout, network
error, non-404/410, no `ui5.url`) conservatively defaults to "served", so
an offline run never regresses the manifest path. Because `ui5.url` comes
from the untrusted `karma.conf.js`, the probe target is validated before any
network call (SEC-2): a non-`http(s)` scheme or a loopback / private /
link-local / cloud-metadata host is refused *without* a fetch and recorded as
unprobed (`cdnProbed: false`, conservatively assumed served), and redirects
are never followed (`redirect: 'error'`) — so a hostile `ui5.url` cannot turn
the probe into a server-side request forgery. The manifest auto-fix is
applied only under the explicit `--auto-apply-baseline-fixes` flag (default
off); without it, controllers whose gap is CDN-served are skipped with
`generatedTests[].status: 'skipped-baseline'` (no LLM call, no quarantine
file), and the user is told to re-run with the flag. The reactive
classifier stays in place as defense-in-depth for a lib that is declared
but still fails to load (CDN outage, future karma-ui5 change).

This entire proactive prevention layer is **JavaScript-only** (V1.9.1-D1/D2).
It exists solely to prevent a karma-ui5 preload hang, and the never-build
firewall guarantees a TypeScript `validate` run never starts karma (both of
validate's karma call sites are gated off for `.ts` — see the TypeScript static
lane above), so the predicted failure is structurally unreachable for TypeScript.
The dependency-graph build and the `baseline-unpreloaded-libs` check (with its
CDN probe) are therefore skipped for a TypeScript run — leaving the check on
forced a permanent non-zero exit with no path to exit 0 on an otherwise-clean
TypeScript project (every CDN-absent gap is `proposedFix: null`, unclearable by
any flag). The documented tradeoff is that the minor manifest-preload-hygiene
signal ("imported library not declared in `manifest.json`") is not surfaced for
TypeScript; UI5 lazy-loads undeclared libraries at runtime, so this is a preload
optimization hint, not a correctness check.

### 2.11 Tooling availability (required vs optional)

At startup, probe for required and optional tools. Hard fail on
missing required; warn-and-skip on missing optional.

- **Always required:** `ui5lint` (or `@ui5/linter`), some test runner
  (`karma` is the only V1-supported runner — see 2.10). For a
  **TypeScript** project, karma is reclassified to *optional* — the
  static-only lane never runs it (§2.5/§2.10) — leaving only `ui5lint`
  required (a TS project with `ui5lint` absent still refuses).
- **Conditionally required:** If `package.json` lists `karma` as a
  devDependency, karma must be runnable; if it lists `eslint`, eslint
  must be runnable.
- **Optional:** `eslint` when not in `package.json` (skip with warning).
- **Probe once per run** and cache the result.

### 2.12 Claude availability and rate limits

- **Missing `claude` binary:** Hard fail at startup (a `claude --version`
  probe) with the message: `Install: npm i -g @anthropic-ai/claude-code,
  then run \`claude /login\` to authenticate.` Exit non-zero.
- **Auth missing (installed but logged-out):** NOT a startup hard-fail —
  exercising auth would burn an LLM call before the user has consented to one
  (see `src/claude/availability.ts`). A logged-out binary is detected on the
  first LLM call, where it surfaces as a `ClaudeApiError`: a per-file finding
  in `validate`, a quarantine / no-output in `generate`. The run still exits
  non-zero; re-run after `claude /login`. (A startup auth probe or a clean
  first-auth-error abort is a candidate follow-up, gated on first capturing the
  real logged-out envelope shape.)
- **Rate limit / quota errors from `claude -p`:** Exponential backoff
  (1s, 4s, 16s) up to 3 attempts per call. A 429 / rate-limit signal is
  recognised whether it arrives as a well-formed `is_error` envelope **or** as a
  non-envelope body (plain text / a truncated page) that does not parse — the
  latter is classified at the transport boundary (`RATE_LIMIT_SIGNAL_RE`, the
  same surface the result classifier uses) and routed onto the same backoff
  schedule, so a transient limit surfaces the honest `rate-limited` reason
  instead of degrading to `malformed`/`no-output` (V1.9.3 D2). Under a
  **concurrent** `generate` run (`--concurrency N>1`, §2.15) the backoff is
  **pool-aware** (THR-4, V1.9.7): a run-wide `RateLimitSignal`
  (`src/claude/rate-limit-signal.ts`) closes on any worker's first 429 backoff
  and the pool drains **new** dispatches until the window clears, then restores
  K — so K workers do not each burn their own backoff schedule and budget
  against one hot quota window. The backing-off call's own retry is never paused
  (that is the recovery path), a **persistent** limit still exhausts to the same
  terminal `rate-limited` exit, and budget is charged only for dispatched
  (never drained) work. The sequential default is unaffected — a lone worker has
  no peers to drain. In addition, the
  CLI enforces a **per-run LLM call budget**: default 50 calls, override
  with `--max-llm-calls N`. A per-category ceiling `--per-check-cap <pct>`
  (validate only; default 35% of `--max-llm-calls`) stops one check id
  from starving the others; attempts skipped at the ceiling are reported
  under `report.json`'s `cappedChecks`. Before the LLM phase, both
  `validate` and `generate` estimate how many calls the resolved scope
  will plausibly need and — on an interactive run where the recommended
  count exceeds the budget — offer a menu to raise it (`--no-prompt`
  skips the menu; both commands also treat `--json` as non-interactive).
  When the budget
  is exhausted, the CLI finishes any in-flight work, writes partial
  results to disk and the report, and exits non-zero with a clear
  message.
- **Malformed `claude` output (not valid JSON, or fails schema):**
  One reformat retry with a stricter prompt. If still bad, save raw
  stdout+stderr to `.sapui5-validator/last-run/llm-error-<file>.txt`
  and exit non-zero. (A body carrying a rate-limit signal is classified as
  rate-limited *before* this path — see the rate-limit bullet above, V1.9.3 D2 —
  so a 429 is never mis-saved as malformed output.)

  Before the one-shot reformat retry fires, the envelope interpretation
  step attempts a conservative recovery: if the inner payload is a
  single balanced JSON object/array surrounded by non-JSON prose (a
  real-world shape produced when the model emits an explanation
  preamble despite the system prompt's prohibition), the extractor
  strips the prose and parses the JSON body. The recovery is
  intentionally conservative — exactly one balanced block, no markdown
  fences, no JSON5 permissiveness — so any ambiguous shape still routes
  through the existing reformat retry. Successful recovery emits a
  `[WARN] LLM emitted prose preamble` line on stderr and records the
  preamble length on the `EnvelopeInterpretation` success variant; the
  `last-run/llm-error-<callId>.txt` audit dump remains written only
  when both attempts fail, byte-for-byte raw.

### 2.13 CLAUDE.md handling

**Read if present, never write.** The CLI passes any CLAUDE.md found
at the project root as context to `claude -p` (via the prompt body,
since `claude -p` reads CLAUDE.md from the project root automatically
when invoked there). The CLI does not create, modify, or rename it.

### 2.14 Caching: git-aware change scoping

- **Default behaviour:** Operate only on files changed vs `main`
  (`git diff --name-only main...HEAD` plus the unstaged/staged set).
  Drastically reduces LLM cost on CI.
- **`--all` flag:** Force the CLI to run on every applicable file in
  the project.
- **`--base <ref>`:** Override the comparison ref (e.g., `develop`,
  `origin/main`).
- Within the selected scope, the **cross-run result cache (§2.14a)** may
  additionally serve unchanged detection checks from a previous run.
  (The V1 "no content-hash cache" restriction was retired in V1.9.8 on
  measured evidence — see §2.14a. §2.14 scoping and §2.14a result
  caching are different mechanisms: scoping decides *which files* are
  examined; the result cache decides whether an examination's *LLM call*
  can be skipped.)

### 2.14a Caching: cross-run detection result cache (V1.9.8)

- **What is cached:** ONLY the batched semantic *detection* calls of
  `validate` (the controller and view batches). A cache HIT serves the
  findings a previous run's byte-identical batch prompt produced —
  no LLM call, no budget consumption, no per-category cap increment.
- **What is NEVER cached:** fix refinement, generation, all
  verification/acceptance (verify-then-accept always runs live), the
  deterministic checks (baseline lint, unpreloaded-libs, project graph,
  sinon dialect, test layout — recomputed every run), the non-batched
  detection loops (`missing-teardown`, `manifest-component-drift`), and
  error findings (transport failures are never stored).
- **Key:** sha256 over the fully assembled batch prompt (which subsumes
  the primary file bytes, the paired test/controller content and the
  coverage flag) + `PROMPT_VERSION` (a builder ratchet in
  `src/checks/batch.ts`, pinned by a content-hash test) + the batch
  check-id set + the run's model (literal `default` when the binary
  picks) + the probed `claude` CLI version. Bytes are hashed as read: a
  CRLF flip is a legitimate MISS.
- **Store:** `.sapui5-validator/cache/detection-cache.json`, inside the
  scanned project and therefore **untrusted input**: strict zod
  validation per entry on read — anything corrupt, tampered, or
  unknown-versioned degrades to a MISS, never a crash and never served.
  Writes go through `assertInsideProject()`. LRU-capped (256 entries).
- **Honesty surfaces:** served findings carry `cached: true` (stamped at
  serve time, never stored); `report.json` carries run-level
  `cache: { hits, misses, servedRunIds }`; the audit trail records each
  serve in `cache-hits.json` (key + file + source run id) and **never
  fabricates a prompt/response transcript** for a call that did not
  happen. `writeReport` refuses a report with `cached` markers but no
  run-level counters (the marker and the counter move together).
- **Defaults & flags:** the CLI defaults `--cache` **on** (since 1.5.0;
  evidence: the V1.9.8 Phase-3 cold→warm gate — 17/17 hits on unchanged
  trees, byte-identical served findings, zero stale incidents, 32→15
  calls per run). `--no-cache` disables for a run. **`--force` bypasses
  cache reads** (a forced run is a deliberate fresh measurement) but
  still writes fresh entries.

### 2.15 Concurrency

**Parallel by default (V1.9.7, THR-1).** Both `validate` and `generate` default
to `--concurrency 2`; `--concurrency 1` restores the sequential V1 contract
byte-for-byte. The default was raised on evidence, not optimism: the V1.6
blessing measured **~1.7× at K=2** on a real project with verify-then-accept
intact; the V1.9.5 baseline recorded **zero rate-limit backoff on the JS lane at
K=1** (the only 429s were an account-level 5-hour session quota hit on the TS
lane — environmental, and concurrency-neutral because K raises wall-clock, not
total consumption); and V1.9.7 landed a pool-wide rate-limit backoff (**THR-4**,
Phase 1) that drains new dispatch during any 429 window *before* raising the
default (**THR-1**, Phase 3).

**`generate` parallelism (V1.6, verify-lane-gated).** `--concurrency N` (N > 1)
processes up to N candidates through a bounded worker pool so their slow
`claude -p` generation calls overlap — the dominant cost on a real
whole-project run (~84.5 %, measured on a real SAPUI5 project).
Correctness is preserved by a single run-wide **verify lane** (a
`Semaphore(1)`): the register→verify→accept critical section is mutually
exclusive across workers, so during any worker's whole-suite karma run the only
registered-but-unverified test is that worker's own. Without it, a concurrent
worker's not-yet-verified (possibly failing) test would be executed by another
worker's karma run and a *sound* test would be wrongly quarantined — a SPEC §1.2
verify-then-accept violation. The pool's bounded degree doubles as the shared
client-side LLM-concurrency limiter.

The original V1 note that a worker pool would "touch only an orchestrator file"
did **not** hold: the verify lane (in `src/generation/retry-loop.ts`) and a
discovery-mode gate were both required. Parallelism is honoured only in
**lane-safe discovery modes** — `testsuite-require` and `karma-files-glob`,
where karma loads ONLY the registered modules/files, so the in-lane
registration fully controls what karma executes. A `glob-auto`/`unknown`
project (karma auto-collects any on-disk `*.qunit.js` via a glob) falls back to
serial, with a note, because the lane cannot keep a parallel worker's
in-progress file out of another worker's glob. Serialising the *cheap* verify
step — rather than duplicating karma ports for fully-parallel verify — keeps the
~2× win whenever verification time ≪ generation time (the measured case); a
project with a large, slow-executing karma suite would see the serialised verify
become the bound, at which point per-worker karma isolation (distinct ports +
scoped suites) is the next step — still deferred (§7). The realised speed-up
against a real project is confirmed by a `test:e2e-real` run at the default N
(V1.9.7 Phase 5, the gate on raising the default).

**`validate` parallelism (V1.9.7, THR-2).** `validate` runs its findings-only
semantic-check batches (the N controller + M view batched calls) through the
same bounded degree. Those calls have no verify step and no file-write hazard,
so `validate` needs neither the verify lane nor the discovery-mode restriction:
its effective K always equals the requested `--concurrency`. Per-index result
slots keep `report.json` findings in target order regardless of completion
order (byte-stable across worker scheduling), and the cap-check → budget →
record prelude is synchronous, so the per-category skip-whole cap and the call
budget stay exact under interleaving. The `ClaudeRunner` interface and the
verification-pipeline interface are unchanged.

**TypeScript `generate` runs serially (V1.9.7, THR-3 — evidence-refused).**
`generate` forces `--concurrency` to **1 on a TypeScript project regardless of
discovery mode**. The TS verify lane runs a **whole-project `tsc --noEmit`**
(no file positionals, driven by the project's `tsconfig.json` — the only verify
adapter that reads the whole source tree, not a single file), while the
generated test is written to disk *outside* the verify lane. So at K > 1 a peer
worker's in-flight or broken `.qunit.ts` — still on disk during its refinement,
and guaranteed inside the tsconfig `include` by the scaffold scope guard — would
fail a *sound* candidate's whole-project tsc and wrongly quarantine it. This is
the same hazard that forces a JS `glob-auto` project serial (the verify globs
the disk); the verify-lane `Semaphore(1)` cannot prevent it (it serialises tsc
*timing*, not file *presence*), and TS has no in-lane registration gate the way
karma does. THR-3 proposed *overlapping* the TS static verifies for extra
speed; it was **evidence-refused**: the win is negligible (a measured
`tsc --noEmit` ≈ 2.7 s against ~200–370 s of LLM per candidate — verify is
< 1.5 % of wall-clock), 2× concurrent `tsc` is memory-fine (≈ 596 MB, so memory
was *not* the blocker), and the whole-project-tsc read makes overlap a
correctness hazard, not just a memory one. The LLM-generation overlap TS would
otherwise gain is given up to keep verify-then-accept sound.

### 2.16 Configuration

**No `.sapui5-validator.json` in V1.** All behavior is driven by:

- Detected project state (`ui5.yaml`, `manifest.json`, `karma.conf.js`,
  `package.json`, `testsuite.qunit.html`).
- CLI flags.

### 2.17 Output

**Always emit both human and JSON.**

- **Human output:** stdout. Quiet by default — per-file status lines
  only (`[OK]`, `[FIX]`, `[GEN]`, `[SKIP]`, `[FAIL]`). `--verbose`
  expands to show phases per file (`linting → LLM review → verify`).
  `generate` additionally prints a status line as each project-wide
  baseline phase (lint, existing karma suite) begins, so a slow baseline
  guard is visibly working rather than mistaken for a hang; `--verbose`
  adds per-phase elapsed timing. These lines go to stderr, so `--json`
  stdout stays a clean report contract.
- **JSON output:** Written to `.sapui5-validator/report.json` on every
  run. Stable schema (versioned). Includes per-file findings,
  proposed/applied fixes, generated test paths, LLM call counts,
  duration, exit reason.
- **HTML output (opt-in):** `--html` (validate only) renders
  `.sapui5-validator/report.html` next to `report.json` after the run.
  It is a non-blocking presentation artifact (a write failure is
  swallowed) and is never part of the success contract.
- **Non-TTY detection:** Disable color and spinners but keep the
  human format on stdout. JSON is always at the artifact path.

### 2.18 Audit log

Per-run transcript of LLM prompts, responses, and verification
outputs:

- **Default:** `.sapui5-validator/last-run/` — additively
  populated per call. Each LLM call writes UUID-keyed files into
  `prompts/`, `responses/`, and `verify/`. Process-kill / API-error
  / malformed-output dumps land directly at the root of
  `last-run/` as `llm-error-<callId>.txt`. The directory is NOT
  cleared between runs; users who want a clean slate should
  delete `last-run/` manually.
- **`--keep-history`:** Writes to `.sapui5-validator/runs/<ISO-timestamp>/`
  instead, preserving prior runs. Note: `llm-error-<callId>.txt`
  files currently still pool in `last-run/` root rather than the
  timestamped directory — known asymmetry, will be addressed in
  a future version.

Behavior rationale: UUIDs are unique per call, so cross-run name
collisions cannot occur. Each individual run's audit trail remains
intact regardless of what previous runs left behind. The
`report.json` artifact at `.sapui5-validator/report.json` IS
overwritten on each run and reflects only the latest invocation.

Keeping `.sapui5-validator/` (scanned-source snapshots + LLM transcripts)
out of git uses two mechanisms (v0.8.1):

- **Primary — self-scoped ignore.** On the first run that writes to the
  directory, the validator writes `.sapui5-validator/.gitignore` containing
  `*`. This guarantees nothing inside the tool's own directory is ever
  git-trackable, **on any project shape** — including projects with no root
  `.gitignore` — without touching the user's own files. The `*` matches the
  ignore file itself, so the directory never dirties the clean-tree gate.
- **Defense-in-depth — root amend.** The validator also adds
  `.sapui5-validator/` to the project's root `.gitignore`, but **only if**
  that file already exists and doesn't already mention the directory. It
  **never creates** a root `.gitignore`; the user owns that file. The
  clean-tree gate disregards this one-line courtesy amendment on the next run
  (any other edit keeps the file dirty).

**Future consideration (V1.3+):** Whether to implement true
clean-slate semantics on `last-run/` is a design decision deferred
to a dedicated session. Trade-offs: clean-slate matches user
intuition but loses forensic data from runs that crashed; current
additive behavior preserves all data but requires manual cleanup
and SPEC clarity.

### 2.19 Exit codes

- **`validate`:** Exit 0 only if linters pass, all tests pass, and all
  findings are either fixed or have no `proposedFix` (i.e., the
  remaining work needs a human). If any auto-fixable finding was not
  successfully applied, exit non-zero.
- **`generate`:** Exit 0 if at least one test was successfully added
  and no test file ended up in `_failing/` for a file the user
  explicitly requested. Per-file failures during a full-project run do
  not block exit 0 as long as overall progress was made.
- **Both:** Hard-fail conditions (missing `claude` binary, dirty tree without
  `--force`, malformed Claude output after retry, missing required
  tooling, an unrunnable karma test runner, baseline failures in
  `generate` mode) exit non-zero. A logged-out `claude` is detected per-call
  rather than at startup (§2.12) and still exits non-zero.
- **Cancellation:** declining the call-limit menu (§2.12) exits **0** with
  `cancelled-by-user` — no work was attempted. Every other non-success
  reason (`budget-exhausted`, `rate-limited`, `typescript-project`,
  `no-tests-template-required`, `not-sapui5-project`, `error`, …) exits
  non-zero; `report.json`'s `exitReason.kind` carries the specific cause.

### 2.20 CLI surface

```
sapui5-validate validate [path]   [--all] [--base <ref>] [--verbose]
                                  [--max-llm-calls N] [--per-check-cap <pct>]
                                  [--concurrency N] [--model <name>]
                                  [--cache | --no-cache]
                                  [--no-prompt] [--html] [--force] [--json]
                                  [--keep-history] [--auto-apply-baseline-fixes]
sapui5-validate generate [path]   [--all] [--base <ref>] [--verbose]
                                  [--max-llm-calls N] [--concurrency N]
                                  [--model <name>] [--no-prompt] [--force]
                                  [--json] [--keep-history] [--qunit-only]
                                  [--opa5-only] [--auto-apply-baseline-fixes]
sapui5-validate --version
sapui5-validate --help
```

`path` is optional: omitted = whole project (scoped by changed-files
default); a file path scopes to that file. `--json` switches stdout
from human to JSON (the file artifact is always written either way).
`--no-prompt` skips the interactive call-limit menu (§2.12) on either
command — both `validate` and `generate` accept it for CI / scripted use.
`--auto-apply-baseline-fixes` (default off, both commands) applies the
deterministic `manifest.json` fix for CDN-served `baseline-unpreloaded-libs`
gaps (§2.10); without it, those gaps are surfaced and the affected
controllers are skipped (`generate`) or counted as unfixed (`validate`).
For **CDN-absent** gaps (a SAPUI5-only library on an OpenUI5 test CDN), the
flag is a **no-op in `validate`**: there is no manifest fix that helps and
`validate` generates no test, so the gap remains an unfixed finding and the
run exits non-zero regardless of the flag. The remedy is to repoint `ui5.url`
at a CDN that serves the library or declare it in karma's `client.libs`.
(`generate` instead steers the generated test to pre-register a no-op stub for
the module — see §2.10.)

`--concurrency <N>` (**default 2**, V1.9.7 THR-1; both `validate` and
`generate`) sets the bounded dispatch degree described in §2.15. On `generate`,
`N > 1` overlaps the per-candidate `claude -p` generation calls while a verify
lane serialises verification, honoured only in lane-safe discovery modes
(otherwise it falls back to serial); on `validate` it overlaps the findings-only
check batches with no lane restriction. `--concurrency 1` restores the
sequential V1 contract.

---

## 3. V1 Scope (concise)

A Node-based CLI named `sapui5-validate` with two commands —
`validate` and `generate` — that operates on SAPUI5 projects
(JavaScript fully; TypeScript on both commands, source-static —
never karma, the §2.5 never-build firewall) detected via `ui5.yaml`
or `manifest.json`+`Component.js`. `validate` runs ui5lint, eslint,
and the project's karma test suite (on TypeScript: ui5lint +
`tsc --noEmit` + config-gated eslint, no karma), plus seven baked-in
LLM-driven semantic checks; LLM-proposed single-file fixes are
auto-applied and verified, with a 3-retry cap. `generate` produces
QUnit and OPA5 tests for code lacking coverage, verified the same
way (on TypeScript: QUnit-only `.qunit.ts`, accepted through the
static-only lane). Unchanged detection checks are served from a
cross-run result cache (default on since 1.5.0; §2.14a). The CLI
dispatches with a bounded default concurrency of 2 (restore
sequential with `--concurrency 1`), defaults to git-changed files
since `main`, requires a clean working tree, hard-fails on missing
`claude`/required tools, and always emits both a human terminal
report and `.sapui5-validator/report.json`.

---

## 4. File / Folder Structure

```
sapui5-validator/
├── package.json  tsconfig.json  tsconfig.eslint.json  vitest.config.ts
├── eslint.config.js                # enforces invariants: no `export default`, no double-`as`, `allowedTools:` only in claude/runner.ts
├── .prettierrc  .gitignore  README.md  SPEC.md  CHANGELOG.md  CLAUDE.md  LICENSE
├── .github/workflows/              # ci.yml (build+lint+typecheck+test+audit+pack, Node 20/22 × ubuntu/windows); release.yml (inert until a GitHub Release)
├── .claude/                        # dev-time workflow tooling: agents/ commands/ settings.json WORKFLOW.md (see §1.3)
├── src/
│   ├── cli.ts                      # commander entry, dispatch (validate, generate)
│   ├── types.ts                    # shared types: Finding, FixProposal, CheckId, ExitReason, RunReport
│   ├── commands/
│   │   ├── validate.ts  generate.ts
│   │   └── baseline.ts             # internal baseline lint/karma capture (NOT a CLI command)
│   ├── claude/
│   │   ├── runner.ts               # ClaudeRunner interface + ALLOWED_TOOLS + buildClaudeArgs (§1.7)
│   │   ├── binary-runner.ts        # subprocess impl over `claude -p`; envelope parse, typed errors
│   │   ├── budget.ts               # per-run call budget + rate-limit backoff
│   │   ├── availability.ts         # `claude --version` install probe
│   │   └── fake-runner.ts          # in-memory fake ClaudeRunner (tests; build-excluded from dist/)
│   ├── budget/                     # cap.ts (--per-check-cap, default 35%)  estimator.ts  menu.ts
│   ├── project/
│   │   ├── detect.ts  glob-project.ts  test-layout.ts  tooling.ts  git.ts
│   │   ├── ts-guard.ts             # TS router (V1.9/1.1.0): validate + generate static-only
│   │   ├── dependency-graph.ts  controller-imports.ts  controller-resolve.ts
│   │   └── lib-namespace.ts  cdn-probe.ts  karma-ui5-defaults.ts  sinon-dialect.ts
│   ├── checks/
│   │   ├── index.ts                # registry of the 7 checks (CHECKS)
│   │   ├── types.ts  _shared.ts    # _shared.ts = the single sanctioned LLM call path
│   │   ├── no-direct-dom.ts  no-sync-odata.ts  missing-teardown.ts  missing-i18n.ts
│   │   ├── manifest-component-drift.ts  globals-in-views.ts  missing-test-coverage.ts
│   │   └── unpreloaded-libs.ts     # deterministic karma-hang prediction (NOT one of the 7)
│   ├── generation/
│   │   ├── qunit.ts  opa5.ts  prompt-context.ts  registration.ts  retry-loop.ts
│   │   └── templates/index.ts      # sap.m / sap.f / fiori-elements starter scaffold
│   ├── verify/                     # pipeline.ts  ui5lint.ts  eslint.ts  tsc.ts  karma.ts  baseline-lint.ts
│   ├── output/                     # human.ts  report.ts  html.ts  messages.ts  strip-control.ts  tty.ts
│   ├── audit/                      # log.ts  runner.ts (audit-logging ClaudeRunner decorator)
│   └── util/
│       ├── exec.ts  schema.ts  paths.ts  containment.ts  concurrency.ts  prompt-feedback.ts
│       └── gitignore.ts  json-read.ts  json-envelope.ts  balance-scan.ts  strip-js-comments.ts
├── test/
│   ├── fixtures/                   # minimal-project  no-tests-project  dirty-baseline  ts-project  ts-helloworld
│   │                              #   e2e-real-project  e2e-real-ts-project  llm-envelopes  prompts
│   ├── unit/  (+ __snapshots__/)
│   ├── integration/               # validate/generate vs fixtures (fake ClaudeRunner)
│   └── e2e-real/                   # real-toolchain suite (real claude/ui5lint/eslint/karma/tsc)
└── scripts/                        # prepare-fixture.ts  guard-precommit.mjs  release-check.mjs
```

### ClaudeRunner interface (binding contract)

```typescript
export interface ClaudeRunner {
  run(args: ClaudeRunArgs): Promise<ClaudeRunResult>;
}

export interface ClaudeRunArgs {
  prompt: string;
  systemPrompt?: string;
  allowedTools: readonly string[];   // never empty; restrictive allowlist
  cwd: string;                       // project root
  outputFormat: 'json';              // V1: always 'json'
  signal?: AbortSignal;
}

export interface ClaudeRunResult {
  ok: boolean;
  json: unknown;                     // parsed structured output
  raw: string;                       // raw stdout for audit
  stderr: string;
  exitCode: number;
  durationMs: number;
  callId: string;                    // for audit log correlation
}
```

`BinaryRunner` is the only V1 implementation. All callers depend on
`ClaudeRunner`. Tests use an in-memory fake implementation. In
`src/claude/runner.ts` every field of both interfaces is `readonly`,
and the module also exports `ALLOWED_TOOLS`, `FORBIDDEN_TOOL_PATTERNS`,
and `buildClaudeArgs()` — the only sanctioned constructor of
`ClaudeRunArgs` (§1.7), enforced by an eslint rule that bans a literal
`allowedTools:` property elsewhere.

---

## 5. npm Dependencies

### Runtime

| Package | Why |
|---|---|
| `commander` | CLI parsing. Mature, stable, no surprises. |
| `execa` | Subprocess wrapper for `claude`, `ui5lint`, `eslint`, `npx karma`, `git`. Better defaults than `child_process`. |
| `zod` | Runtime schema validation of LLM JSON output (per 2.12 — schema validation gates acceptance). |
| `picocolors` | Terminal coloring. Tiny, no dependencies. |
| `fast-glob` | Glob expansion for test layout detection and file iteration. |
| `simple-git` | Typed git operations (clean-tree check, changed-since-ref). |

### Dev / build / test

| Package | Why |
|---|---|
| `typescript` | Language. Strict mode. |
| `@types/node` | Node typings. |
| `tsx` | Fast TS execution for `npm run dev` and integration test runs. |
| `vitest` | Test runner. Fast, watch mode, good TS DX. |
| `@vitest/coverage-v8` | Line-coverage provider for the >80% coverage DoD (§6 item 14). |
| `eslint` | Lint our own code. |
| `typescript-eslint` | TS-aware lint rules — the flat combined package (`eslint.config.js`). |
| `cross-env` | Cross-platform env var for the `test:e2e-real` script (`VALIDATOR_E2E_REAL=1`). |
| `prettier` | Formatter. |

### Peer / external (must exist in the target SAPUI5 project, not in our deps)

- `@ui5/cli` (`ui5`), `@ui5/linter` (`ui5lint`), `karma`,
  `karma-ui5`, `eslint` (where configured).
- **`typescript` (`tsc`)** — for a TypeScript project only (V1.9). `validate`
  invokes the project's own `tsc --noEmit` as the type-check step of the
  static verify lane (§2.10), exactly like `ui5lint` / `eslint` / `karma`: a
  detected, fixed tool run on explicit paths under the shared per-subprocess
  timeout. It is **never bundled into the CLI**, and `tsc` is skipped when the
  project ships no `typescript` (ui5lint still type-checks the `.ts`). The CLI's
  runtime dependency set above is therefore **unchanged** (6 packages) — TS
  support adds no new runtime dependency.

The CLI does not bundle these. It detects and invokes them.

---

## 6. Definition of Done for V1

A V1 release is considered done when **all** of the following are true:

1. **Installation:** `npm i -g sapui5-validator` (or local
   devDependency) yields a `sapui5-validate` binary that runs on
   Node 20+ on Windows and Linux (both CI-verified; macOS is expected
   to work but is not in the CI matrix).
2. **Project detection** correctly identifies projects per 2.2 across
   the fixtures in [test/fixtures/](https://github.com/Setforex7/sapui5_validator/tree/master/test/fixtures/) and refuses
   non-SAPUI5 directories with a clear message.
3. **TypeScript routing (V1.9):** `validate` supports a TypeScript project
   *source-static* — TS-aware discovery, the seven checks over `.ts`, and the
   static-only verify lane (`ui5lint` + `tsc --noEmit` + config-gated `eslint`,
   **no karma**) per 2.5 / 2.10; **`generate` (since 1.1.0)** likewise proceeds
   on a `.ts` project — QUnit-only, emitting `.qunit.ts` accepted through that
   same static-only lane, karma never invoked (the never-build firewall).
4. **Clean-tree guard** refuses to run on a dirty working tree;
   `--force` bypasses.
5. **`validate` end-to-end:** On the `minimal-project` fixture seeded
   with three known semantic issues (one per check across DOM access,
   missing i18n, manifest drift), the CLI:
   - Flags all three.
   - Auto-applies the LLM-proposed fixes.
   - Verifies via ui5lint, eslint, and karma — all green post-fix.
   - Exits 0.
   - Writes a valid `.sapui5-validator/report.json` matching the
     documented schema.
   - Writes audit log to `.sapui5-validator/last-run/`.
6. **`generate` end-to-end:** On the `minimal-project` fixture with
   one controller lacking a test, the CLI:
   - Generates a QUnit test file under the detected test root.
   - Generates an OPA5 journey when the project has an opa5 directory.
   - Runs karma; tests pass.
   - Exits 0.
7. **Retry-then-fail behavior verified:**
   - A fixture controller that the LLM cannot produce a working test
     for after 3 rounds ends up under `webapp/test/_failing/` with a
     `.failing.qunit.js` suffix, **excluded** from the regular suite,
     and the report records the failure.
   - A fix proposal that fails verification 3 times leaves the source
     file at its pre-fix state.
8. **Hard-fail behavior verified:** With `claude` unavailable, missing
   `ui5lint`, or malformed LLM output (mocked via the fake
   `ClaudeRunner`), the CLI exits non-zero with the specified message
   and writes nothing to the user's source tree.
9. **Per-run budget enforced:** With `--max-llm-calls 1` on a fixture
   that requires more, the CLI exits non-zero, writes partial
   progress, and the report reflects the budget exit reason.
10. **Output:** Quiet status-line default, `--verbose` phase output,
    and JSON via `--json` and the artifact file all work on TTY and
    non-TTY (piped) stdout.
11. **No internal subagents.** Code search shows no use of the Task
    tool or subagent files inside the runtime path. The
    `ClaudeRunner` interface is the sole indirection; a fake
    implementation is used in the test suite.
12. **Allowed-tools allowlist** is asserted in unit tests on every
    code path that constructs a `ClaudeRunArgs`. No `Bash(rm*)`,
    `Bash(git push*)`, `Bash(git commit*)` ever appears.
13. **Documentation:** A `README.md` covers install, the two
    commands, all flags, exit codes, the `.sapui5-validator/` layout,
    and a "what V1 does not do" section listing OPA5 headless without karma
    and multi-file fixes during `validate`.
    (V1.9 added TypeScript `validate` support and 1.1.0 added TypeScript
    `generate` — both source-static; the README documents the static-only verify
    limit. OPA5-for-TypeScript and `.ts` scaffolding remain deferred.
    Parallelism shipped in V1.6/V1.9.7 (§2.15) and the detection result cache
    in V1.9.8 (§2.14a) — both formerly on this list.)
14. **Tests:** Unit tests cover each module under [src/](https://github.com/Setforex7/sapui5_validator/tree/master/src/) at >80%
    line coverage. Integration tests in [test/integration/](https://github.com/Setforex7/sapui5_validator/tree/master/test/integration/)
    run against fixtures using the fake `ClaudeRunner`.
15. **CI:** A GitHub Actions workflow runs build + lint + typecheck +
    tests, plus `npm audit --omit=dev` and an `npm pack --dry-run`
    packaging check, on push and PR against Node 20 and 22 on
    `ubuntu-latest` and `windows-latest`.

---

## 7. Explicitly Deferred (Not V1)

- ~~TypeScript SAPUI5 projects.~~ **Shipped (V1.9 + 1.1.0):** both `validate`
  (V1.9) and `generate` (1.1.0) support TypeScript source-static — the static-only
  verify lane behind the never-build firewall (§2.5, §2.10); `generate` emits
  `.qunit.ts` QUnit tests accepted on that lane, never karma. Still deferred:
  **OPA5-for-TypeScript**, **`.ts` test scaffolding** for no-test-layout projects,
  and any runtime/browser execution of TypeScript (karma via
  `karma-ui5-transpile`, `ui5 build`) — the last hard-blocked from the default
  untrusted-repo path by the never-build firewall.
- Headless OPA5 execution without a project-provided karma config.
- Detecting/warning when the **target project's own karma harness cannot
  transpile TS** (e.g. karma-ui5 `ui5: { url }` mode bypasses the ui5.yaml
  `ui5-tooling-transpile-middleware`, so `*.qunit.js` requests 404) — it would
  require statically parsing the user's `karma.conf.js` (arbitrary JS the
  validator must never execute). The run-level `verification` banner (V1.9.9)
  is the honest signal instead: the tests were not executed.
- ~~Parallel per-file processing.~~ **Shipped (1.4.0):** `generate` has a
  `--concurrency N` worker pool for lane-safe JS discovery modes and
  `validate` parallelises its findings-only check batches; both
  default to `--concurrency 2` — see §2.15. **TypeScript `generate`
  runs serially** — measured evidence refused parallelising it: its whole-project
  `tsc --noEmit` makes concurrency a correctness hazard for a negligible win
  (§2.15). Still deferred: **fully-parallel verify** (per-worker karma isolation —
  distinct ports + scoped suites).
- ~~Content-hash result caching across runs.~~ **Shipped (V1.9.8 / 1.5.0):**
  the cross-run **detection** result cache, default on — see §2.14a. Still
  never cached: fix refinement, generation, verification/acceptance, and the
  deterministic checks.
- Multi-file LLM fixes during `validate`.
- A `.sapui5-validator.json` config file.
- A V2 `SDKRunner` implementation behind the existing `ClaudeRunner`
  interface.
- Internal subagents (writer-reviewer, scoped investigators).
- A `--warn-only` tier for semantic findings.
