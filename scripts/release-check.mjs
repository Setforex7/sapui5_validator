#!/usr/bin/env node
/**
 * release-check.mjs — the supply-chain + packaging-invariant gate for the
 * MANUAL npm publish (methodology stage 7). Mechanizes the parts of the
 * publish-readiness audit that were hand-rolled (and slipped) every cycle, so
 * `release-readiness-auditor` and a human can trust one command.
 *
 * Zero dependencies (Node built-ins only). Run standalone (`npm run
 * release:check`) or as the `prepublishOnly` re-gate. Exits non-zero on any
 * HARD failure; WARN-only items (e.g. npm audit could not reach the network)
 * do not fail the gate but are surfaced.
 *
 * Checks:
 *   1. dist/ is built and dist/cli.js carries the node shebang.
 *   2. `npm pack --dry-run --json` ships ONLY dist/ (minus *.map) + the four
 *      root docs + package.json — no src/, test/, fixtures, coverage,
 *      .sapui5-validator, *.map, or stray *.tgz.
 *   3. `npm audit --omit=dev` reports 0 production vulnerabilities.
 *   4. Runtime `dependencies` are EXACTLY the lean six (SPEC §5). Any addition
 *      fails the gate until a CLAUDE.md / PR justification is added here.
 *   5. package.json version == the top `## [x.y.z]` CHANGELOG heading.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

// The frozen runtime-dependency set (SPEC §5). Changing this list is a
// deliberate act that must be paired with a justification in CLAUDE.md / the PR
// description explaining why nothing already here works — that is the whole
// point of the freeze (e.g. the generate-for-TS cycle must NOT add `typescript`
// as a runtime dep; tsc stays the project's own subprocess).
const LEAN_SIX = ['commander', 'execa', 'fast-glob', 'picocolors', 'simple-git', 'zod'];

let hardFailures = 0;
let warnings = 0;

function pass(msg) {
  process.stdout.write(`[PASS] ${msg}\n`);
}
function fail(msg) {
  process.stdout.write(`[FAIL] ${msg}\n`);
  hardFailures += 1;
}
function warn(msg) {
  process.stdout.write(`[WARN] ${msg}\n`);
  warnings += 1;
}

function run(cmd, args) {
  // shell:true so `npm` resolves to npm.cmd on Windows without PATHEXT games.
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', shell: true });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
}

function parseJsonLoose(text) {
  try {
    return JSON.parse(text);
  } catch {
    // npm sometimes prepends notices; recover the first balanced JSON value.
    const start = text.search(/[[{]/);
    if (start < 0) return null;
    const open = text[start];
    const close = open === '[' ? ']' : '}';
    const end = text.lastIndexOf(close);
    if (end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// --- 1. dist + shebang ------------------------------------------------------
function checkDist() {
  const cliPath = join(ROOT, 'dist', 'cli.js');
  if (!existsSync(cliPath)) {
    process.stdout.write('[..]  dist/cli.js missing — running `npm run build` …\n');
    const b = run('npm', ['run', 'build']);
    if (b.status !== 0) {
      fail('`npm run build` failed; cannot verify the tarball.');
      return;
    }
  }
  if (!existsSync(cliPath)) {
    fail('dist/cli.js still missing after build.');
    return;
  }
  const shebang = readFileSync(cliPath, 'utf8').startsWith('#!/usr/bin/env node');
  if (shebang) pass('dist/cli.js carries the node shebang (PKG-5).');
  else fail('dist/cli.js is missing the `#!/usr/bin/env node` shebang.');
}

// --- 2. tarball hygiene -----------------------------------------------------
function checkPack() {
  const r = run('npm', ['pack', '--dry-run', '--json']);
  const parsed = parseJsonLoose(r.stdout);
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  const files = entry && Array.isArray(entry.files) ? entry.files.map((f) => String(f.path).replace(/\\/g, '/')) : null;
  if (!files) {
    warn('could not parse `npm pack --dry-run --json` output; tarball not verified.');
    return;
  }
  const allowedRoot = new Set(['package.json', 'README.md', 'SPEC.md', 'CHANGELOG.md', 'LICENSE']);
  const leaks = files.filter((p) => {
    if (p.startsWith('dist/') && !p.endsWith('.map')) return false;
    if (allowedRoot.has(p)) return false;
    return true; // anything else is a leak (src/test/fixtures/coverage/.map/.tgz/…)
  });
  if (leaks.length === 0) pass(`tarball ships ${files.length} files, all within the dist/+docs allowlist (PKG-6).`);
  else fail(`tarball would leak ${leaks.length} disallowed file(s): ${leaks.slice(0, 12).join(', ')}${leaks.length > 12 ? ' …' : ''}`);

  if (!files.includes('dist/cli.js')) fail('tarball does not include dist/cli.js (the bin entry).');
}

// --- 3. supply chain --------------------------------------------------------
function checkAudit() {
  const r = run('npm', ['audit', '--omit=dev', '--json']);
  const parsed = parseJsonLoose(r.stdout);
  const vulns = parsed && parsed.metadata && parsed.metadata.vulnerabilities;
  if (!vulns) {
    // npm audit needs the network; a transport failure is a WARN, not a gate fail.
    warn('`npm audit --omit=dev` could not be parsed (offline / registry error?); production advisories NOT verified.');
    return;
  }
  if ((vulns.total ?? 0) === 0) pass('npm audit --omit=dev: 0 production vulnerabilities.');
  else fail(`npm audit --omit=dev: ${vulns.total} production vulnerabilities (critical ${vulns.critical ?? 0}, high ${vulns.high ?? 0}).`);
}

// --- 4. dependency freeze ---------------------------------------------------
function checkDepFreeze() {
  const pkg = readJson(join(ROOT, 'package.json'));
  const got = Object.keys(pkg.dependencies ?? {}).sort();
  const want = [...LEAN_SIX].sort();
  const extra = got.filter((d) => !want.includes(d));
  const missing = want.filter((d) => !got.includes(d));
  if (extra.length === 0 && missing.length === 0) {
    pass(`runtime dependencies are exactly the lean six (SPEC §5): ${want.join(', ')}.`);
  } else {
    if (extra.length) fail(`runtime dependency set breached — unexpected dep(s): ${extra.join(', ')}. Add a CLAUDE.md/PR justification AND update LEAN_SIX in this script before releasing.`);
    if (missing.length) fail(`runtime dependency set breached — missing expected dep(s): ${missing.join(', ')}.`);
  }
}

// --- 5. version alignment ---------------------------------------------------
function checkVersion() {
  const pkg = readJson(join(ROOT, 'package.json'));
  const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
  const m = changelog.match(/^##\s*\[(\d+\.\d+\.\d+)\]/m);
  const top = m ? m[1] : null;
  if (!top) {
    warn('could not find a `## [x.y.z]` heading in CHANGELOG.md.');
    return;
  }
  if (top === pkg.version) pass(`version aligned: package.json ${pkg.version} == top CHANGELOG [${top}].`);
  else fail(`version mismatch: package.json ${pkg.version} != top CHANGELOG [${top}]. Align before tagging.`);
}

process.stdout.write('release-check: verifying publish readiness …\n\n');
checkDist();
checkPack();
checkAudit();
checkDepFreeze();
checkVersion();

process.stdout.write('\n');
if (hardFailures === 0) {
  process.stdout.write(`release-check: GO — 0 hard failures${warnings ? `, ${warnings} warning(s) to review` : ''}.\n`);
  process.exit(0);
} else {
  process.stdout.write(`release-check: NO-GO — ${hardFailures} hard failure(s)${warnings ? `, ${warnings} warning(s)` : ''}. Fix before tagging/publishing.\n`);
  process.exit(1);
}
