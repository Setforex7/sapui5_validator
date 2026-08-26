---
description: Stage 1 — pre-cycle diagnosis (feature-feasibility OR bug-audit), produce a local untracked diagnosis/<cycle>-DIAGNOSIS.md
argument-hint: "<cycle-name> <feature to design | bug area> — e.g. V1.1 \"generate tests for TypeScript\""
---

Run the methodology **stage-1 diagnosis** for cycle `$ARGUMENTS` as a **Workflow**
(dev-time multi-agent fan-out is allowed — SPEC §1.3 forbids subagents only in the
RUNTIME path, not in development).

**First, pick the lens from the request** (state which you chose):

- **MODE A — feature / new capability** ("add …", "support …", "generate … for
  …"). The diagnosis is a **feasibility + design + security study**:
  1. Enumerate 2–3+ candidate **approaches**; for each, assess feasibility against
     the current architecture and a **threat-model pass** against the project's
     load-bearing invariants — the untrusted-repo model + the **never-build
     firewall** (no karma/`ui5 build`/transpile on untrusted code; SPEC §2.5/§2.10),
     the **lean-six runtime-dependency** posture (SPEC §5 — a new runtime dep is a
     red flag), and the **verify-then-accept** contract (SPEC §1.2).
  2. **Disqualify** any approach that breaches an invariant, explicitly and with
     the reason (V1.9 disqualified the build-based TS approaches this way *before*
     a line of code).
  3. Recommend ONE design; decompose it into **ordered phases** the plan will turn
     into `/charter` prompts; and for each new **failure surface** the feature
     opens, name the guard/test that must contain it (e.g. for any TS-execution
     work: the `karma-call-count == 0 on TS` structural guard, landed FIRST).

- **MODE B — bug / regression / hardening** ("why does …", "fix …", "audit …").
  The diagnosis is the **adversarial audit** of current behaviour — find the
  corner that was cut: defects with stable IDs, severity, and a
  `defect → fix → layer` table.

If the request genuinely spans both (a feature that also fixes a defect), apply
both lenses and say so.

**Shared mechanics (both modes):**

- **Fan out read-only Explore passes**, one per relevant subsystem: CLI/commands,
  claude transport, the 7 checks, verify pipeline, generation/retry, project
  detection/dep-graph, output/report, budget/audit/util.
- **Compose the built-in skills** — do NOT reinvent them: run `/security-review`
  over the trust-boundary surface (validate/generate, binary-runner, exec,
  cdn-probe, gitignore, test-layout); do real web research (WebSearch/WebFetch)
  when the cycle hinges on external SAPUI5 / karma-ui5 / sinon behaviour or an
  unfamiliar library — this is common for features.
- **Adversarial refutation** — one independent default-to-refute pass per
  non-trivial finding or design claim; drop the ones that don't survive.
- **Ground truth** — `npm run build` / `lint` / `test`, `npm audit --omit=dev`,
  `node scripts/release-check.mjs`.

**Output:** exactly one file, `diagnosis/<cycle>-DIAGNOSIS.md` (a local,
deliberately untracked directory — cycle docs never enter the tracked tree), in
the house format the plan will cite — for MODE A: the approach comparison, the disqualified
options, the recommended design, the phase breakdown, and the new-failure-surface
→ guard table; for MODE B: the stable-ID defect table. State which mode you ran.

**Hard rules:** every reviewer is **read-only** (Explore / the read-only skills) —
never a Bash-armed reviewer that can `git checkout` away uncommitted work; re-run
`git status` after. Write only the diagnosis file. Do not edit source. The human
ranks the result into `plans/<cycle>-PLAN.md` afterward.
