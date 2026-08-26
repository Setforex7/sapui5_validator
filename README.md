# sapui5-validator

[![CI](https://github.com/Setforex7/sapui5_validator/actions/workflows/ci.yml/badge.svg)](https://github.com/Setforex7/sapui5_validator/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org/)
[![License: ISC](https://img.shields.io/badge/license-ISC-blue)](LICENSE)

A Node CLI — `sapui5-validate` — that runs a fixed set of SAPUI5 anti-pattern
checks over a SAPUI5 project and generates QUnit / OPA5 tests for code that
lacks coverage. `validate` **and** `generate` support both **JavaScript** and
**TypeScript** SAPUI5 (TypeScript is verified *source-static* — see
[TypeScript SAPUI5 support](#typescript-sapui5-support) for the static-only
verify limit; generated TypeScript tests are `.qunit.ts`, type-checked + linted
but never karma-executed). It is a **hybrid
deterministic + LLM** tool: existing
SAPUI5 tooling (`ui5lint`, `eslint`, `karma`) is ground truth, and `claude -p`
is invoked surgically — every artifact it produces is written to disk, verified
by those linters/test runners, and reverted if verification fails.

## Quick start

> ### Prerequisite: the `claude` CLI
>
> This tool drives Anthropic's `claude` CLI as a subprocess. **Install and
> authenticate it first** — otherwise every run hard-fails at startup with a
> `missing-claude` error:
>
> ```bash
> npm i -g @anthropic-ai/claude-code   # provides the `claude` binary
> claude /login                        # authenticate once
> ```
>
> You also need **Node.js 20+**, and the target SAPUI5 project must bring its
> own **`ui5lint`** (`@ui5/linter`) and **`karma`** (if it uses one). See
> [Install](#install) for the complete prerequisite list.

```bash
# Install the validator globally (ad-hoc use across projects)
npm install --global sapui5-validator

# From a SAPUI5 project root, on a clean git tree:
sapui5-validate validate          # validate files changed vs main
sapui5-validate validate --all    # validate the whole project
sapui5-validate generate          # generate tests for uncovered code
```

The validator **refuses to run on a dirty working tree** so `git diff` is
always the audit trail (`--force` overrides). The full command reference,
flags, and output schema are below.

This README is the user-facing surface. The full design — architectural
decisions, the seven checks in detail, the scope boundary — lives in
[SPEC.md](SPEC.md); the release history lives in [CHANGELOG.md](CHANGELOG.md).

---

## What this CLI does

- **Runs seven specific semantic checks** over your controllers and views —
  not "general SAPUI5 validation". The checks are baked in and fixed
  ([SPEC §2.8](SPEC.md)):

  1. `no-direct-dom` — DOM lookups (`document.getElementById`,
     `document.querySelector`, jQuery selectors) outside `byId()` in controllers
  2. `no-sync-odata` — synchronous OData reads / `async: false`, plus
     fire-and-forget unawaited promises
  3. `missing-teardown` — QUnit modules and `onInit` subscriptions without
     matching `afterEach` / `onExit` cleanup
  4. `missing-i18n` — hardcoded human-readable strings in `.view.xml` files
     that should be `{i18n>...}` keys
  5. `manifest-component-drift` — routes / targets / models / dataSources
     declared in `manifest.json` but unreferenced in `Component.js` (or
     vice-versa)
  6. `globals-in-views` — XML view bindings to undefined controller methods or
     `window` globals
  7. `missing-test-coverage` — exported public methods with no corresponding
     QUnit test

- **Runs `ui5lint`, `eslint`, and the project's `karma` suite** as a baseline
  pre-pass, and funnels pre-existing per-file lint failures through the same
  auto-fix loop as the semantic findings.
- **Auto-applies single-file LLM fixes** and re-verifies them in a 3-retry
  loop. A fix that still fails after 3 rounds is reverted to its pre-fix state.
- **Generates QUnit + OPA5 tests** for uncovered controllers/views. A generated
  test that cannot be made to pass in 3 rounds is quarantined under
  `webapp/test/_failing/` rather than added to the suite.
- **Always writes `.sapui5-validator/report.json`** and a per-run audit log of
  every LLM prompt, response, and verification transcript.

## What this CLI does NOT do

- It is **not** a linter replacement. The seven checks above are the entire
  semantic surface. It will not catch arbitrary SAPUI5 mistakes outside that
  list.
- It does **not** generate **OPA5 journeys or scaffold a `.ts` test layout for
  TypeScript**. `generate` supports TypeScript projects (since 1.1.0) — it emits
  `.qunit.ts` unit tests verified *source-static* (see
  [TypeScript SAPUI5 support](#typescript-sapui5-support)) — but TypeScript
  generation is **QUnit-only**, accepts tests **statically** (type-checked +
  linted, never karma-executed), and requires an existing `webapp/test/` layout.
  OPA5-for-TypeScript and `.ts` scaffolding are deferred.
- It does **not** do **multi-file fixes during `validate`**. Findings that
  genuinely need changes across files come back with `proposedFix: null` and a
  human-readable explanation; you resolve them manually. (`generate` is allowed
  multi-file writes — test file + testsuite entry + karma glob.)
- It defaults to **`--concurrency 2`** for both commands (V1.9.7); pass
  `--concurrency 1` to restore the sequential V1 contract. `validate` dispatches
  its findings-only semantic-check batches in parallel (they have no
  verify/write hazard, so there is no lane restriction). `generate` overlaps the
  per-candidate LLM generation — the dominant cost — for projects that register
  their tests explicitly (a `sap.ui.require` testsuite or an explicit karma
  `files:` list), while a verify lane keeps verification serialised so
  verify-then-accept is preserved; a glob-auto project and every **TypeScript**
  `generate` run stay serial by construction. See [SPEC §2.15](SPEC.md).
- It **caches detection results across runs** (since 1.5.0, default on):
  unchanged batched detection checks are served from
  `.sapui5-validator/cache/` — `--no-cache` disables, `--force` bypasses reads.
  **Detection only**: fix refinement, generation, verification/acceptance and
  the deterministic checks always run live ([SPEC §2.14a](SPEC.md)).
- It has **no config file**. All behavior comes from detected project state and
  CLI flags ([SPEC §2.16](SPEC.md)). The vendor/minified exclusion list is
  hard-coded for this release.
- It does **not** use a `--warn-only` tier, internal subagents, or an
  SDK-backed transport. See [SPEC §7](SPEC.md) for the full deferred list.

---

## TypeScript SAPUI5 support

`validate` supports **TypeScript SAPUI5** projects (since V1.9), verified
**source-static**. A TypeScript project is detected automatically — `.ts`
controllers under `webapp/`, a `tsconfig.json`, or a `ui5-tooling-transpile`
task — so no flag is needed:

```bash
# From a TypeScript SAPUI5 project root, on a clean git tree:
sapui5-validate validate          # validate .ts files changed vs main
sapui5-validate validate --all    # validate the whole TypeScript project
```

`validate` discovers your `.ts` controllers and `.qunit.ts` tests, runs the
seven semantic checks over the TypeScript source — framed as TypeScript
(ES-module / `class`), never rewritten into `sap.ui.define` AMD — and verifies
every fix it applies.

### The static-only verify limit (read this)

**For a TypeScript project, the test suite is never executed.** A TypeScript fix
is verified **statically only** — it must

- **compile** — `tsc --noEmit`, run as your project's own TypeScript (only when
  your project ships its own `typescript`; the CLI never bundles one);
- **lint clean** — `ui5lint`, which type-checks `.ts` natively; and
- **pass `eslint`** — only when your project ships a TypeScript-aware eslint
  config (otherwise `.ts` is left to `ui5lint`),

but `karma` is **never** run — neither the baseline suite probe nor the post-fix
suite gate. So for TypeScript, *"this fix did not break a test"* is **not**
runtime-verified; a fix is proven only to compile, lint, and type-check. A
TypeScript run that ran `tsc` reports `verification: "static-only"`; one whose
project does **not** ship its own `typescript` skips `tsc` (the lane narrows to
`ui5lint`) and honestly reports **`lint-only`** instead — it never claims
"type-checked" when `tsc` did not run. Either way the marker is on the CLI status
line and in `report.json`, so the limit is always explicit — never a silent
"clean". Install `typescript` in the project for the full `static-only` check.

**Why karma is skipped — the never-build firewall.** Running a `.ts` test under
karma (or `ui5 build`) requires transpiling it through the project's own
`babel.config.js`, which is arbitrary JavaScript that would run **in-process**.
Because this CLI is built to run on repositories you may not fully trust, it
**never** executes project-defined build code — so it refuses to build or
karma-run TypeScript *by construction*, and accepts the static-only verify limit
as the safe trade. A TypeScript project with no usable static toolchain
(`ui5lint` absent) still refuses with `missing-required-tooling` — never a silent
pass.

**The proactive unpreloaded-library prevention layer does not run for
TypeScript.** On JavaScript, `validate` runs a deterministic
`baseline-unpreloaded-libs` check that predicts a karma-ui5 *preload hang* before
any test runs (the same check `generate` runs — described under the `generate`
command below). That prediction is about a karma runtime — and the never-build
firewall guarantees
a TypeScript run never starts karma — so the check (and its CDN probe) is **gated
off for TypeScript**: it cannot prevent a hang that can never happen, and leaving
it on forced a permanent non-zero exit on otherwise-clean TypeScript projects. The
documented cost is that the minor "you imported a library you didn't declare in
`manifest.json`" preload-hygiene hint is not surfaced for TypeScript; this is
acceptable because UI5 lazy-loads undeclared libraries at runtime (the manifest
`libs` list is a preload optimization, not a correctness requirement).

**`generate` supports TypeScript — static-only, QUnit-only (since 1.1.0).** On a
TypeScript project, `generate` emits idiomatic `.qunit.ts` unit tests (ES-module
/ `class`, importing the controller by its ES specifier — never `sap.ui.define`
AMD) and accepts each through the **same static-only lane** `validate` uses:
`tsc --noEmit` + `ui5lint` + config-gated `eslint`, plus a shape check that the
test actually asserts against the controller under test (so a type-checking-but-
vacuous test cannot be accepted) and never imports QUnit — `QUnit` stays the
ambient global; an `import … from "sap/ui/thirdparty/qunit-2"` is tsc-green but
double-defines QUnit at runtime and kills the whole suite, so the gate rejects
it (since 1.5.1). **karma is never run** (the never-build
firewall), so a generated TypeScript test is type-checked and linted but **not
executed** — reported per-test as `verification: "static-only"`, never a silent
green; since 1.5.1 the run-level `verification` marker + banner appear on
`generate` too, exactly as on `validate`. A test that cannot pass the lane in 3 attempts is quarantined to
`webapp/test/_failing/<Name>.failing.qunit.ts`. TypeScript generation is
**QUnit-only** and requires an existing `webapp/test/` layout; OPA5-for-TypeScript
and `.ts` scaffolding are deferred. The full contract is in
[SPEC §2.5](SPEC.md) and [SPEC §2.10](SPEC.md).

---

## Install

The validator ships as a Node package with a `sapui5-validate` binary.

```bash
# Global install — for ad-hoc use across projects
npm install --global sapui5-validator

# Local devDependency — for CI / repeatable project runs
npm install --save-dev sapui5-validator
# then: npx sapui5-validate validate
```

Requires:

- **Node.js 20 or newer.**
- The **`claude` CLI**, installed and authenticated. The validator hard-fails at
  startup if `claude --version` does not run cleanly:

  ```text
  Install: npm i -g @anthropic-ai/claude-code, then run `claude /login` to authenticate.
  ```

  **Tested version range:** the `claude -p --output-format json` envelope this
  tool depends on is validated against **claude `2.x` (≥ `2.1.200`)**. The CLI
  version used is probed once per run and recorded in
  `report.json` (`claudeVersion`) and the audit trail. A version outside the
  tested range only **warns** — it never blocks the run — because a newer CLI is
  almost always compatible. If the CLI's envelope shape ever does drift, the run
  ends with a distinct `envelope-contract-mismatch` exit reason naming the
  version (never a misattributed "malformed output" error).

- The target SAPUI5 project must bring its own **`ui5lint`** (`@ui5/linter`)
  and, if it uses one, **`karma`**. The validator detects and invokes these
  rather than bundling them ([SPEC §2.11](SPEC.md)).

---

## Usage examples

```bash
# Validate the current branch (files changed vs `main`)
sapui5-validate validate

# Validate every applicable file in the project
sapui5-validate validate --all

# Validate a single file
sapui5-validate validate webapp/controller/Main.controller.js

# Generate QUnit + OPA5 tests for code lacking coverage
sapui5-validate generate

# Generate only QUnit tests, with a 20-call LLM budget
sapui5-validate generate --qunit-only --max-llm-calls 20

# Emit JSON to stdout (for CI scraping); .sapui5-validator/report.json
# is always written either way.
sapui5-validate validate --json
```

The CLI **refuses to run on a dirty working tree** so `git diff` is always the
audit trail. Use `--force` to override (see "Flags" below).

### A concrete run

Validating a project whose `Main.controller.js` reaches into the DOM directly
and whose `Main.view.xml` has a hardcoded button label:

```text
$ sapui5-validate validate --all
[OK]   webapp/Component.js
[FIX]  webapp/controller/Main.controller.js  no-direct-dom (1 fix applied)
[FIX]  webapp/view/Main.view.xml             missing-i18n (1 fix applied)
[OK]   webapp/controller/Details.controller.js

validate: 4 files, 2 findings, 2 fixed, 0 unfixed — exit 0
report: .sapui5-validator/report.json
```

`git diff` then shows exactly what changed: `document.getElementById(...)`
rewritten to `this.byId(...)`, and `text="Save"` rewritten to
`text="{i18n>save}"`. Each change was verified by `ui5lint` / `eslint` / `karma`
before being kept.

---

## Commands

### `validate`

Runs the baseline `ui5lint` / `eslint` / `karma` pre-pass on every in-scope
file, then the seven semantic checks. Single-file fixes are auto-applied and
re-verified in a 3-retry loop; pre-existing lint failures go through the same
loop ([SPEC §2.3](SPEC.md)).

```
sapui5-validate validate [path]
  --all                     Operate on every applicable file (ignore git-changed scope)
  --base <ref>              Override comparison ref (default: main)
  --verbose                 Show phase output (linting / LLM review / verify)
  --max-llm-calls <N>       Per-run LLM call budget (default 50)
  --per-check-cap <pct>     Per-check-id ceiling as a percentage of --max-llm-calls (default 35)
  --concurrency <N>         Dispatch up to N semantic-check batches at once
                            (default 2; use --concurrency 1 for sequential)
  --model <name>            Forward a specific model id to `claude -p` for this
                            run (default: your Claude Code model)
  --no-prompt               Skip the dynamic call-limit menu (CI / scripted use)
  --html                    Write report.html alongside report.json when the run completes
  --force                   Bypass the clean-tree guard
  --json                    Emit JSON to stdout instead of status lines
  --keep-history            Persist audit log under runs/<ISO>/ instead of last-run/
  --auto-apply-baseline-fixes  Apply the deterministic manifest.json fix for
                            baseline-unpreloaded-libs findings (default off)
  --cache                   Serve unchanged detection checks from the cross-run
                            result cache under .sapui5-validator/cache/
                            (DEFAULT ON since 1.5.0). Detection calls only —
                            fixes, generation and all verification are never
                            cached. Served findings carry "cached": true and the
                            run-level "cache" counters in report.json; an audit
                            hit record lands in last-run/cache-hits.json. NOTE:
                            --force bypasses cache READS (a forced run is a
                            fresh measurement) but still writes fresh entries.
  --no-cache                Disable the detection result cache for this run
```

On an interactive run, `validate` estimates how many LLM calls the detected
scope is likely to need and offers to bump `--max-llm-calls` to that
recommendation before any LLM is invoked. `--per-check-cap` prevents one check
category from monopolising the budget. Pass `--no-prompt` to skip the menu
(useful in CI). Pass `--html` to additionally render
`.sapui5-validator/report.html` — a static, JavaScript-free HTML
report you can open directly in a browser or share for code review.

### `generate`

Refuses to start on a red baseline ([SPEC §2.3](SPEC.md)) — generating tests on
top of broken production code is pointless. Then iterates uncovered controllers
and produces a verified QUnit test per candidate (OPA5 journeys are opt-in via
`--opa5-only`). Every file is verified; failures after 3 retries are
**quarantined** under `webapp/test/_failing/<Name>.failing.qunit.js`, excluded
from the regular suite so a human can review the LLM's last attempt.

```
sapui5-validate generate [path]
  --all                     Operate on every applicable file (ignore git-changed scope)
  --base <ref>              Override comparison ref (default: main)
  --verbose                 Show phase output (baseline lint / karma / generate / verify)
  --max-llm-calls <N>       Per-run LLM call budget (default 50)
  --concurrency <N>         Process up to N candidates at once (default 2; use
                            --concurrency 1 for sequential). Overlaps the slow
                            LLM generation while a verify lane serialises
                            verification. Honoured only for projects that
                            register tests explicitly (sap.ui.require testsuite /
                            explicit karma files: list); a glob-auto project or a
                            TypeScript project runs serially. (V1.6 / V1.9.7)
  --model <name>            Forward a specific model id to `claude -p` for this
                            run (default: your Claude Code model)
  --no-prompt               Skip the dynamic call-limit menu (CI / scripted use)
  --force                   Bypass the clean-tree guard
  --json                    Emit JSON to stdout instead of status lines
  --keep-history            Persist audit log under runs/<ISO>/ instead of last-run/
  --qunit-only              Generate only QUnit unit tests; skip OPA5 journeys
  --opa5-only               Generate only OPA5 journeys; skip QUnit unit tests
  --auto-apply-baseline-fixes  Apply the deterministic manifest.json fix for
                            baseline-unpreloaded-libs findings before generating
                            (default off; otherwise affected controllers are
                            skipped with status 'skipped-baseline')
```

`generate` runs a deterministic **`baseline-unpreloaded-libs`** check
([v0.5.0](CHANGELOG.md)) before any LLM call: it parses each controller's
`sap.ui.define` imports and flags libraries that karma-ui5 will not preload
in the test runtime (not declared in `manifest.json` and not in karma's
`client.libs`), which would otherwise hang karma at
`browserNoActivityTimeout`. For a library the configured karma CDN actually
serves, `--auto-apply-baseline-fixes` adds it to
`sap.ui5.dependencies.libs`; for a library the CDN does **not** serve (a
SAPUI5-only library on an OpenUI5 test CDN), the manifest fix would not help,
so the validator instead steers the generated test to pre-register a no-op
stub for the module. Without the flag, affected controllers are surfaced and
skipped (`generatedTests[].status: 'skipped-baseline'`).

`generate` checks the project baseline first — it lints the in-scope files and
runs the existing karma suite, refusing to start if either is red. That phase
prints a status line as each part begins (`--verbose` adds per-phase elapsed
timing) so a slow baseline guard is never mistaken for a hang. After candidate
discovery it prints an estimate of how many LLM calls the run will need and, on
an interactive run where that estimate exceeds `--max-llm-calls`, offers the
same call-limit menu `validate` has; pass `--no-prompt` to skip it. Each
generated QUnit test is registered with the project's test suite
(`testsuite.qunit.html` / the karma `files:` glob) **before** verification, so
karma actually executes it rather than passing vacuously over a file it never
loaded.

When the project has **no existing tests under `webapp/test/`**, an interactive
TTY run prompts for a starter template (`sap.m`, `sap.f`, or `Fiori Elements`)
and scaffolds it before generation. In `--json` mode or when stdin is not a TTY,
this is a hard fail ([SPEC §2.4](SPEC.md)).

---

## Output

The validator emits two artifacts on every run:

1. **stdout** — quiet status lines by default (`[OK]`, `[FIX]`, `[GEN]`,
   `[SKIP]`, `[FAIL]`); `--verbose` expands to per-phase output; `--json`
   switches stdout to the same JSON shape written to disk.
2. **`.sapui5-validator/report.json`** — always written. Versioned JSON
   (schema v2) with per-file findings, applied / reverted fixes, generated test
   paths, LLM call counts, duration, and exit reason.

### `report.json` schema (v2)

```jsonc
{
  "schemaVersion": 2,
  "command": "validate" | "generate",
  "startedAt": "<ISO timestamp>",
  "finishedAt": "<ISO timestamp>",
  "durationMs": <number>,
  "llmCallCount": <number>,
  "llmCallBudget": <number>,
  "exitReason": { "kind": "<see Exit codes below>", ... },
  "exitCode": <number>,
  "files": [
    {
      "file": "webapp/controller/Main.controller.js",
      "findings": [
        {
          "checkId": "no-direct-dom" | ... | "baseline-ui5lint" | ...,
          "file": "...",
          "line": 11,
          "message": "...",
          "source": "check" | "baseline",
          "proposedFix": { "newFileContent": "..." } | null,
          "explanation": "...", // present iff proposedFix is null
          "cached": true        // optional (V1.9.8); present iff served from the --cache store instead of a live LLM call
        }
      ],
      "appliedFixes": [{ "checkId": "...", "source": "..." }],
      "revertedFixes": [{ "checkId": "...", "source": "...", "reason": "..." }]
    }
  ],
  "generatedTests": [
    {
      "sourceFile": "webapp/controller/Other.controller.js",
      "testFile": "webapp/test/unit/controller/Other.controller.qunit.js",
      "status": "passed" | "quarantined" | "no-output" | "skipped-baseline",
      "verification": "lint-only",       // optional (v0.8.0); on passed OPA5 journeys karma never executed: lint-verified only
      "refinementTruncations": <number>, // optional; count of refinement prompts whose karma feedback was truncated
      "quarantineReason": {              // optional; present on quarantined / no-output entries
        "phase": "initial" | "refinement" | "module-load",
        "message": "..."
      }
    }
  ],
  "cappedChecks": { "<checkId>": <number> },            // optional; per-category LLM calls skipped at the --per-check-cap ceiling
  "sinonDialect": "modern" | "sap-bundled" | "unknown", // optional; set on generate runs only
  "postFixSuite": {                                     // optional; validate runs that applied at least one fix (v0.8.0)
    "status": "passed" | "failed" | "not-run",
    "reason": "...",                 // why the gate did not run, or the failing suite's feedback head
    "revertedFiles": ["..."],        // on "failed": files restored byte-exact to their pre-fix content
    "revertFailedFiles": ["..."]     // on "failed": files whose restore FAILED — the unverified fix is still on disk
  },
  "cache": {                                            // optional (V1.9.8); present iff the run had --cache enabled
    "hits": <number>,                // detection lookups served from the cache (no LLM call, no budget)
    "misses": <number>,              // lookups not served (dispatched live, cap-skipped, or --force-bypassed)
    "servedRunIds": ["<ISO>"]        // optional; the startedAt of the run(s) whose entries were served
  }
}
```

These trailing fields are **optional and additive** (`schemaVersion` stays
`2`): readers that ignore unknown keys keep working. `cappedChecks`,
`sinonDialect`, `postFixSuite` and `cache` are top-level; `verification`,
`refinementTruncations` and `quarantineReason` are per `generatedTests[]`
entry; `cached` is per finding and moves together with the top-level `cache`
counters (a report with `cached` markers but no `cache` counters is refused
at write time — the V1.9.8 honesty guard).

`postFixSuite` (v0.8.0) records the single post-fix karma suite gate on
`validate`: after the fix phase, if any fixes were applied and qunit tests are
in scope, the suite runs **once**; on red, **all** applied fixes are reverted
to their byte-exact pre-fix content and re-booked under `revertedFixes` with a
reason naming the suite failure. `status: "not-run"` means the gate could not
run (no qunit tests in scope, karma runner unavailable) — applied fixes are
retained on lint-only verification and the report says so rather than claiming
suite verification. A non-empty `revertFailedFiles` always rides with a
non-zero exit whose `error` reason names the affected files.

`source` distinguishes findings produced by the seven semantic checks
(`'check'`) from baseline pre-existing lint failures funnelled through the fix
loop (`'baseline'`). v1 readers can default a missing `source` field to
`'check'`.

`generatedTests[].status` is `passed` (generated and verified — and, for QUnit,
registered with the project test suite; OPA5 journeys (`--opa5-only`) are
generated and verified but **not** auto-registered, so you must add them to your
OPA5 suite manually — see [SPEC §2.1](SPEC.md)), `quarantined` (could not be made
to pass in 3 retries — moved under `webapp/test/_failing/`), `no-output` (the LLM
produced no usable file, e.g. the subprocess was killed on an oversized prompt),
or `skipped-baseline` (v0.5.0 — the controller imports a library flagged by the
`baseline-unpreloaded-libs` check and `--auto-apply-baseline-fixes` was not
passed, so no test was generated; re-run with the flag).

Because OPA5 journeys are not auto-registered, the per-artifact karma run
cannot actually execute them (outside `glob-auto` discovery, where the broad
karma `files:` glob collects the journey anyway): such a `passed` entry carries
`verification: "lint-only"` (v0.8.0) and the CLI status line says so — the
report never claims karma verification that did not happen. A quarantined
journey is contained like a quarantined QUnit test: it moves under
`webapp/test/_failing/` and, on `glob-auto` projects, a karma `exclude` for
`**/test/_failing/**` is injected so the next run's baseline is not poisoned.

### Audit log

Per-run transcript of LLM prompts, responses, and verification stderr lives
under `.sapui5-validator/`:

- **Default:** `.sapui5-validator/last-run/{prompts,responses,verify}/` —
  additively populated with UUID-keyed files per LLM call; **not** cleared
  between runs (delete `last-run/` manually for a clean slate). Only
  `.sapui5-validator/report.json` is overwritten each run. See [SPEC §2.18](SPEC.md).
- **`--keep-history`:** `.sapui5-validator/runs/<ISO-timestamp>/...` — preserves
  prior runs.

When `claude` produces output that cannot be used (killed process, malformed
JSON, or an error envelope), the raw capture is saved as
`.sapui5-validator/last-run/llm-error-<callId>.txt`.

The validator writes a self-scoped `.sapui5-validator/.gitignore` (containing
`*`) on first run, so its audit trail is never git-trackable on any project. As
defense-in-depth it also amends the project's root `.gitignore` to add
`.sapui5-validator/` if that file exists and does not already mention it — it
never creates a root `.gitignore` ([SPEC §2.18](SPEC.md)).

---

## Exit codes

| Code | When                                                                                          |
| ---- | --------------------------------------------------------------------------------------------- |
| `0`  | `validate`: all lint / tests / checks pass and every auto-fixable finding was applied         |
|      | `generate`: at least one test added; no quarantined test for an explicitly-requested file     |
| `1`  | Any non-success exit. The `exitReason.kind` field on `report.json` carries the specific cause |

`exitReason.kind` is one of:

| `kind`                       | Meaning                                                                     |
| ---------------------------- | --------------------------------------------------------------------------- |
| `success`                    | Normal completion, exit 0                                                   |
| `not-sapui5-project`         | No `ui5.yaml` and no `webapp/manifest.json` matching the SPEC §2.2 contract  |
| `typescript-project`         | Reserved defensive guard. Since 1.1.0 both `validate` and `generate` proceed on TypeScript projects (static-only — see [TypeScript SAPUI5 support](#typescript-sapui5-support)); this reason is kept in the report schema as a defensive floor and is unreachable in the normal flow |
| `dirty-tree`                 | Working tree has uncommitted changes; pass `--force` to override            |
| `missing-required-tooling`   | `ui5lint` or `karma` (when configured) is unavailable                       |
| `missing-claude`             | `claude --version` failed; install / authenticate per SPEC §2.12            |
| `baseline-failed`            | A baseline lint or test failure. For `validate`, a failure that could not be attributed to a single file (missing dependency, etc.); for `generate`, the existing lint/tests are red and it refuses to add tests on top of a broken project |
| `karma-unavailable`          | `generate` aborted because the karma test runner is installed but could not start — a config error, a missing browser launcher, or a missing plugin. Distinct from `baseline-failed` (the tests are genuinely red) and `missing-required-tooling` (karma is not installed at all) |
| `no-tests-template-required` | `generate` was invoked on a no-tests project without an interactive TTY     |
| `unfixed-findings`           | At least one finding could not be auto-fixed in 3 retries                   |
| `budget-exhausted`           | The `--max-llm-calls` budget was hit mid-run; partial progress is preserved |
| `rate-limited`               | `claude` returned a rate-limit error mid-run; partial results are preserved and the audit log records the last error |
| `cancelled-by-user`          | The user cancelled at the interactive dynamic-call-limit menu (exit 0 — chose not to run) |
| `malformed-llm-output`       | Reserved; the binary-runner persists `llm-error-<callId>.txt` and surfaces a manual finding instead |
| `error`                      | Unhandled error, or a refused excluded-path scope (see below). The message is in the `message` field |

### V1.1 failure modes

V1.1 added typed errors for failure modes the real-project run exposed. They do
**not** introduce new `exitReason.kind` values — they surface through the
existing ones:

| Failure mode                 | Typed error                     | How it surfaces                                                                                  |
| ---------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------ |
| **Excluded-path scope**      | `ExcludedPathScopeError`        | You passed an explicit path that matches the built-in vendor/minified exclusion list. The run ends with `exitReason.kind: 'error'` and a message naming the path and the exclusion list. |
| **Claude process killed**    | `ClaudeProcessKilledError`      | The `claude` subprocess terminated before producing output (negative exit code / empty stdout — typically an oversized prompt). Surfaces as a per-file **finding** with `proposedFix: null`; if unfixed it drives `exitReason.kind: 'unfixed-findings'`. The raw capture is in `llm-error-<callId>.txt`. |
| **Claude API error**         | `ClaudeApiError`                | `claude` returned a well-formed JSON envelope reporting `is_error: true` or a non-`success` subtype (auth failure, rate limit, `error_max_turns`). Surfaces as a per-file **finding** with the envelope's diagnostic in `explanation` — distinct from `malformed-llm-output`, because the transport parsed fine. |
| **ui5lint path out of tree** | `Ui5LintFileOutsideProjectError`| A file resolved to a path outside the project root before reaching `ui5lint`. Raised internally; bubbles up as `exitReason.kind: 'error'`. |

---

## Known limitations

These are real edges in the current release, not bugs. Several were discovered
during real-project gate runs (see "Why every release is gated on a real
project" below).

- **Karma runs the full suite per invocation.** There is no `--files` scoping;
  every verify step that touches karma runs the project's whole QUnit/OPA5
  suite. On large suites this is slow.
- **Karma baseline attribution is project-wide.** When karma fails during the
  baseline pre-pass, the failure cannot be pinned to a single file (the whole
  suite ran at once) and the run exits `baseline-failed`. Per-test attribution
  is V2.
- **E2E fixture uses a simplified inline karma harness.** The
  `e2e-real-project` fixture stays on the `html`-mode `karma.conf.js` +
  `testsuite.qunit.html` setup rather than the karma-ui5 test-starter pattern.
  This is a fixture simplification, not a product limitation, but it means the
  E2E suite does not exercise the test-starter path.
- **Billing-mode visibility is still deferred.** The `claude` envelope carries
  a `total_cost_usd` field that is populated under both Max-subscription and
  direct-API billing. The CLI does not yet surface which mode you are on or sum
  the per-run cost. See the "Troubleshooting" gotcha below.
- **TypeScript `validate` and `generate` are static-only.** Both support
  TypeScript SAPUI5 but verify it **source-static** — `tsc --noEmit` (run only
  when the project ships its own `typescript`; otherwise the lane narrows to
  `ui5lint` and the run reports `verification: "lint-only"` instead of
  `"static-only"`, never claiming "type-checked") + `ui5lint` + config-gated
  `eslint`, and **never** karma — so a TypeScript run cannot prove a fix did not
  break a test at runtime (the never-build security rationale — see
  [TypeScript SAPUI5 support](#typescript-sapui5-support)). `generate` for
  TypeScript (since 1.1.0) is QUnit-only and emits `.qunit.ts`; install
  `typescript` in the project for the full `tsc`-backed `static-only` check.
- **The unpreloaded-library prevention check does not run for TypeScript.** The
  deterministic `baseline-unpreloaded-libs` check predicts a karma-ui5 preload
  hang, which the never-build firewall makes impossible for TypeScript (karma is
  never started), so it is gated off for `.ts` projects. The cost is that the
  minor "imported library not declared in `manifest.json`" preload-hygiene hint is
  not surfaced for TypeScript — harmless, because UI5 lazy-loads undeclared
  libraries at runtime. See
  [TypeScript SAPUI5 support](#typescript-sapui5-support).
- **Sources with no covering test roll up into one `missing-test-coverage`
  finding (JavaScript + TypeScript).** When no in-scope QUnit test imports a
  source file, every method is trivially uncovered, so `validate` emits a single
  rolled-up finding naming those files (with a "run `generate`" hint) rather than
  one finding per uncovered method — it does not spend an LLM call enumerating
  per-method gaps it cannot auto-fix. A source that a test *does* import still gets
  the full per-method coverage analysis.
- **`claude` auth is only probed via `claude --version`.** A binary that runs
  but is not authenticated passes the startup probe; the auth failure surfaces
  on the first real LLM call as a `ClaudeApiError` finding.
- **Generated tests are LLM-authored — review them before committing.** Every
  generated test is verified (it must pass `karma`/lint before it is kept), but
  verification proves it runs green, not that it asserts what you intended.
  Treat a generated test like any other LLM output: read the `git diff` before
  you commit it. The clean-tree requirement exists precisely so that diff is
  always available.

---

## Troubleshooting

### `claude --version` works but every check fails with an API error

Your `claude` binary runs but is not authenticated, or is authenticated against
the wrong account. Run `claude /login`. The startup probe only checks that the
binary executes — it does not exercise auth (see "Known limitations").

### The run ends with `envelope-contract-mismatch`

The `claude` CLI returned a response whose **envelope shape** does not match the
`claude -p --output-format json` contract this tool depends on. This is almost
always a **CLI version incompatibility**, not a problem with your project or a
model error — so the run does not spend a reformat retry on it, and the message
names the probed CLI version. Update or reinstall the CLI
(`npm i -g @anthropic-ai/claude-code`) to a version in the tested range
(claude `2.x`, ≥ `2.1.200`) and re-run. The raw response is saved under
`.sapui5-validator/last-run/` for inspection.

### Accidental API billing — the `ANTHROPIC_API_KEY` gotcha

If `ANTHROPIC_API_KEY` is set in your environment, the `claude` CLI uses
**direct API billing** even if you also have a Max subscription. A run that you
expected to be absorbed by your subscription is then billed per-call against the
API key, silently.

The validator invokes `claude` as a subprocess and inherits your environment, so
this affects every run. If you intend to be on a subscription:

```bash
# Check whether the key is set
echo $ANTHROPIC_API_KEY        # POSIX
echo $env:ANTHROPIC_API_KEY    # PowerShell

# Unset it for the session if you did not mean to be on API billing
unset ANTHROPIC_API_KEY        # POSIX
Remove-Item Env:ANTHROPIC_API_KEY   # PowerShell
```

The envelope's `total_cost_usd` field is populated in both modes, so a non-zero
cost in the audit log does **not** by itself mean you were billed. Explicit
billing-mode surfacing is on the backlog.

### A vendor or minified file I named explicitly was refused

`validate <path>` and `generate <path>` reject paths that match the built-in
exclusion list (`*.min.js`, `*.min.css`, `vendor/`, `thirdparty/`,
`third-party/`, `dist/`). This is intentional — see `ExcludedPathScopeError`
above. There is no `--force-include` flag.

### `generate` is slow, and karma re-downloads UI5 on every test

Most of a real `generate` run is the LLM generation latency, not karma — but
karma still cold-boots a server + headless Chrome per verification, and if your
`karma.conf.js` points karma-ui5 at a **remote** UI5 CDN
(`ui5.url: "https://sdk.openui5.org"`) it re-fetches the UI5 runtime over the
network every boot. That network round-trip is the largest fixed per-verify cost
and the source of intermittent 30 s `browserNoActivityTimeout` failures when the
CDN is slow. **Point karma-ui5 at a local UI5** (served from `node_modules` or a
vendored runtime) so each boot loads UI5 from disk: this removes the per-boot
download and the CDN-timeout tail. It also pairs well with `--concurrency`, since
the overlapped runs no longer contend on the same network fetch.

---

## Architecture overview

- **Hybrid deterministic + LLM.** A deterministic TypeScript core orchestrates
  the external SAPUI5 toolchain. `claude` is called only where understanding
  intent matters — proposing fixes, generating tests, running the semantic
  checks. Linters and karma are ground truth; no LLM artifact is accepted
  without passing them ([SPEC §1.1–1.2](SPEC.md)).
- **`ClaudeRunner` abstraction.** All code that invokes Claude depends on the
  `ClaudeRunner` interface, never on the concrete subprocess implementation.
  `BinaryRunner` is the only production implementation; it wraps
  `claude -p --output-format json`, unwraps the CLI's JSON envelope, and
  classifies process-kill / API-error / malformed-output failures into typed
  errors. Tests use an in-memory `FakeClaudeRunner` ([SPEC §1.5](SPEC.md)).
- **Audit log.** Every LLM call's prompt and response, and every verification
  transcript, is written under `.sapui5-validator/last-run/` (or
  `runs/<ISO>/` with `--keep-history`). Wiring: an `AuditingRunner` decorator
  records prompts/responses around `BinaryRunner`; the verify pipeline writes
  its stderr dumps directly. This is the observability layer that made the V1.1
  bug diagnosis possible.
- **E2E test infrastructure.** Three test tiers: fast fake-runner unit /
  integration tests (`npm test`, the default — offline, free); real-linter
  smoke tests gated behind `VALIDATOR_E2E=1`; and a full real-toolchain tier
  under `test/e2e-real/` gated behind `VALIDATOR_E2E_REAL=1`, which runs the
  real `claude`, `ui5lint`, `eslint`, and `karma` against
  `test/fixtures/e2e-real-project/`. The E2E real tier burns real LLM calls
  (~$0.10–$0.40/run) and is run by developers before any change touching LLM
  call paths — it is not in CI. See
  [test/e2e-real/README.md](https://github.com/Setforex7/sapui5_validator/blob/master/test/e2e-real/README.md).

---

## Why every release is gated on a real project

The development history repeatedly proved the same point: a mocked test suite
measures the layer it was written against, not the one the next release
exposes. Four milestones made that concrete:

- **0.1.0 → 0.2.0:** 258 green fake-runner tests; the first run against a real
  SAPUI5 project exposed six bugs the suite structurally could not catch
  (absolute-path handling, envelope unwrapping, killed-subprocess
  classification, vendor blobs burning LLM calls, an audit log never written
  to). *A fake good enough to make tests pass is not a fake good enough to
  prove the product works.*
- **0.4.1:** a real run surfaced a refinement prompt blowing past the Windows
  `CreateProcess` argv ceiling and generated tests written against the wrong
  sinon dialect. *A fake good enough to test the prompt is not a fake good
  enough to test the launch.*
- **0.4.2:** LLM prose-before-JSON on refinement, and karma module-load hangs
  misclassified as test failures. *Each release unmasks the next layer.*
- **0.5.0:** the karma-preload gap became a thing the validator *prevents*
  deterministically before any LLM call — and the first cut of that prevention
  layer itself shipped three defects only a real run surfaced. *Predicting a
  failure introduces new ways to predict it wrong.*

The structural counter-measure is baked into the workflow: no release ships
without the `VALIDATOR_E2E_REAL=1` real-toolchain tier plus a run against a
real SAPUI5 project. The fixes those runs surfaced are recorded in
[CHANGELOG.md](CHANGELOG.md), release by release.

---

## Contributing

```bash
npm install
npm run build         # tsc -> dist/
npm run lint          # eslint over src/
npm test              # vitest (unit + integration; LLM is faked — fast, offline, free)
npm run test:watch    # iterative
npm run test:e2e-real # real toolchain; burns real LLM calls (~$0.10–$0.40/run)
npm run dev -- <args> # run the CLI from source via tsx
```

CI runs build / lint / typecheck / unit tests — plus `npm audit --omit=dev`
and an `npm pack --dry-run` packaging check — on Node 20 and 22 against
`ubuntu-latest` and `windows-latest` on every push and PR. The `VALIDATOR_E2E=1` and
`VALIDATOR_E2E_REAL=1` tiers are **not** in CI — they need a locally
authenticated `claude` and would burn LLM calls on every PR. Run
`npm run test:e2e-real` locally before landing any change that touches LLM call
paths, verify-pipeline adapters, or `BinaryRunner`.
