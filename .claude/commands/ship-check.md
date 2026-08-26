---
description: Stage 7 — release GO/NO-GO audit before tagging or publishing
---

Invoke the **`release-readiness-auditor`** subagent (read-only). It runs the
non-mutating publish gates (build/lint/test green, `npm pack --dry-run` tarball
hygiene, `npm audit --omit=dev` == 0, the lean-six dependency freeze,
version/CHANGELOG/tag alignment, and the inert-`release.yml` publish-safety
invariant — most of which `node scripts/release-check.mjs` mechanizes).

Relay its **GO / NO-GO** table. On **GO**, relay the exact remaining MANUAL steps
(make repo public if first publish; add `NPM_TOKEN`; `git tag -a`; cut a GitHub
Release — which is the only thing that fires the publish). Do NOT bump the
version, tag, push, or publish yourself — the human does that.
