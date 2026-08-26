/**
 * Vitest globalSetup for the VALIDATOR_E2E_REAL=1 test scope.
 *
 * Gated on VALIDATOR_E2E_REAL=1 so the default `npm test` invocation stays fast
 * and offline. It prepares and runs the real validator against sandbox copies
 * of TWO fixtures:
 *
 *   - the JS fixture `test/fixtures/e2e-real-project/` — the original
 *     real-toolchain witness (real `claude` + `ui5lint` + `eslint` + `karma`);
 *   - the TS fixture `test/fixtures/e2e-real-ts-project/` (V1.9 Phase 4) — the
 *     TypeScript-SAPUI5 witness, exercising the static-only verify lane (real
 *     `tsc --noEmit` + `ui5lint`, NEVER karma — the TS-V1 never-build firewall).
 *
 * V1.9.5 (INF-1): the validate runs happen inside DETERMINISTIC tmpdir
 * sandboxes (`SHARED_JS_SANDBOX` / `SHARED_TS_SANDBOX`), not the tracked
 * in-repo fixtures. LLM-applied fixes land in the sandbox, so the old
 * post-run `git checkout -- test/fixtures/` discipline is gone; `teardown()`
 * asserts the fixtures stayed byte-clean as the fail-on-revert guard.
 *
 * Steps, all idempotent:
 *
 *   1. Lazy `npm install` inside each IN-REPO fixture (node_modules is then
 *      junctioned/symlinked into the sandboxes). A `.npm-install-done` marker
 *      carries a sha256 of that fixture's `package.json`; the install is
 *      skipped when it matches.
 *
 *   2. Materialize each sandbox fresh (copy fixture minus `node_modules`,
 *      link `node_modules`), then (JS sandbox only) seed two inputs that
 *      several Session-V1.1-3 E2E tests depend on:
 *      `webapp/util/dummy-vendor.min.js` (Bug 4 — scope exclusion) and
 *      `webapp/util/oversized-input.js` (Bug 2 — argv-guard refusal on
 *      oversize prompt). Both are recreated on every enabled run.
 *
 *   3. Run `sapui5-validate validate --all --force` with cwd at each sandbox
 *      exactly ONCE per enabled invocation, persisting
 *      `.sapui5-validator/last-run/` + `report.json` there. The witness tests
 *      under `test/e2e-real/*.e2e.test.ts` read those artifacts via the
 *      `PATHS` / `TS_PATHS` constants in `_shared.ts` (which point at the
 *      sandboxes). Sharing one run per fixture keeps the session cost at the
 *      README-advertised $0.10–$0.40 instead of multiplying it.
 *
 * The CLI is invoked via `tsx src/cli.ts` so no `npm run build` step is needed.
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import {
  FIXTURE_ROOT,
  FIXTURE_TS_ROOT,
  JS_SANDBOX_COPY_ENTRIES,
  SHARED_JS_SANDBOX,
  SHARED_TS_SANDBOX,
  TS_SANDBOX_COPY_ENTRIES,
  materializeSandboxInto,
} from './_shared.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const CLI_ENTRY = join(REPO_ROOT, 'src', 'cli.ts');

const DUMMY_VENDOR = join(SHARED_JS_SANDBOX, 'webapp', 'util', 'dummy-vendor.min.js');
const OVERSIZED_INPUT = join(SHARED_JS_SANDBOX, 'webapp', 'util', 'oversized-input.js');

function packageHash(fixtureDir: string): string {
  return createHash('sha256').update(readFileSync(join(fixtureDir, 'package.json'))).digest('hex');
}

function installMarkerMatches(fixtureDir: string, currentHash: string): boolean {
  const nodeModules = join(fixtureDir, 'node_modules');
  const marker = join(fixtureDir, '.npm-install-done');
  if (!existsSync(nodeModules) || !existsSync(marker)) return false;
  return readFileSync(marker, 'utf8').trim() === currentHash;
}

async function npmInstallOnce(fixtureDir: string): Promise<void> {
  const currentHash = packageHash(fixtureDir);
  if (installMarkerMatches(fixtureDir, currentHash)) return;

  console.log(`[e2e-real/setup] Installing fixture deps in ${fixtureDir} …`);
  await execa('npm', ['install', '--no-audit', '--no-fund'], {
    cwd: fixtureDir,
    stdio: 'inherit',
    // npm on Windows is a .cmd shim; execa needs the shell to resolve it
    // without depending on PATHEXT propagation through child_process.
    shell: process.platform === 'win32',
  });
  writeFileSync(join(fixtureDir, '.npm-install-done'), currentHash, 'utf8');
}

function seedSandboxInputs(): void {
  mkdirSync(dirname(DUMMY_VENDOR), { recursive: true });

  // Bug 4 — small placeholder that *looks* like a minified third-party blob.
  // The validator's scope filter is expected (after V1.1-6) to skip it on the
  // `*.min.js` extension alone. Size is intentionally tiny so it does not
  // accidentally also trigger Bug 2's oversized-input path.
  writeFileSync(
    DUMMY_VENDOR,
    '// dummy minified vendor blob seeded by test/e2e-real/setup.ts (Bug 4)\n' +
      '!function(e){"use strict";var t=e.exports={};t.noop=function(){return!1}}({exports:{}});\n',
    'utf8',
  );

  // Bug 2 / B1 / R4.3 — deliberately oversized first-party file (~1 MB of
  // ASCII). Pre-B1 this risked a real exit-code -1 OS kill of the `claude`
  // subprocess; since B1 (V1.5) the pre-spawn argv guard intercepts it
  // deterministically with the synthetic exitCode -2 before any spawn.
  // Either way the contract pinned by process-kill.e2e.test.ts holds: the
  // result is classified as a process-kill, never a malformed-output
  // finding, and the reformat retry is not burned on it. The real-kill -1
  // path is pinned separately by process-kill-real.e2e.test.ts (R4.3).
  const filler = 'x'.repeat(1024);
  const lines: string[] = [
    '// oversized-input seed for Bug 2 — generated by test/e2e-real/setup.ts',
    'sap.ui.define([], function () {',
    '  "use strict";',
    '  // Each comment line below is ~1KB; the file totals ~1 MB so the',
    '  // assembled per-check prompt exceeds the Claude subprocess pipe budget.',
  ];
  for (let i = 0; i < 1000; i += 1) lines.push(`  // ${filler}`);
  lines.push('  return {};');
  lines.push('});');
  writeFileSync(OVERSIZED_INPUT, lines.join('\n') + '\n', 'utf8');
}

async function runValidateOnce(sandboxDir: string, label: string): Promise<void> {
  console.log(
    `[e2e-real/setup] Running sapui5-validate validate --all against the ${label} sandbox ` +
      `(${sandboxDir}) …`,
  );
  // `--force` bypasses the SPEC §2.6 clean-tree guard (the sandbox is not a
  // git repository, and the historical in-repo run needed it too). `--json`
  // is omitted so the human-readable output streams to the parent stdio for
  // visibility during a long-running E2E session.
  const result = await execa('npx', ['tsx', CLI_ENTRY, 'validate', '--all', '--force'], {
    cwd: sandboxDir,
    // Don't throw on non-zero exit — the whole point of this session is that
    // the validator EXITS non-zero when it finds (and reverts) things. The
    // on-disk report.json / audit-log artifacts are what the tests assert
    // against.
    reject: false,
    timeout: 10 * 60 * 1000,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      // Force a deterministic locale + UTF-8 so claude / ui5lint captures
      // don't differ between CI and local Windows shells.
      LANG: 'en_US.UTF-8',
    },
  });
  console.log(
    `[e2e-real/setup] ${label} validate finished with exitCode=${result.exitCode}; ` +
      `tests will assert against ${sandboxDir}/.sapui5-validator/last-run/ artifacts.`,
  );
}

export async function setup(): Promise<void> {
  if (process.env['VALIDATOR_E2E_REAL'] !== '1') return;

  // JS fixture — the original real-toolchain witness. Install stays in-repo
  // (the sandbox links its node_modules); the run happens in the sandbox.
  await npmInstallOnce(FIXTURE_ROOT);
  materializeSandboxInto({
    fixtureRoot: FIXTURE_ROOT,
    sandboxRoot: SHARED_JS_SANDBOX,
    copyEntries: JS_SANDBOX_COPY_ENTRIES,
  });
  seedSandboxInputs();
  await runValidateOnce(SHARED_JS_SANDBOX, 'JS');

  // TS fixture (V1.9 Phase 4) — the static-only-lane witness. The TS run boots
  // no browser and hits no CDN (karma is firewalled for TS), so it adds little
  // to the wall-clock / cost of the JS run above.
  await npmInstallOnce(FIXTURE_TS_ROOT);
  materializeSandboxInto({
    fixtureRoot: FIXTURE_TS_ROOT,
    sandboxRoot: SHARED_TS_SANDBOX,
    copyEntries: TS_SANDBOX_COPY_ENTRIES,
  });
  await runValidateOnce(SHARED_TS_SANDBOX, 'TS');
}

/**
 * V1.9.5 (INF-1) — the fail-on-revert regression guard for the sandbox
 * migration: a full e2e-real session must leave the tracked in-repo fixtures
 * byte-clean. Any `git status --porcelain` output under `test/fixtures/`
 * (tracked modification OR unignored stray file) means something wrote
 * in-repo again — fail the run loudly rather than let the old silent-pollution
 * failure mode return. The sandboxes, node_modules, and install markers are
 * all either outside the repo or fixture-gitignored, so a healthy run
 * produces zero output here.
 */
export function teardown(): void {
  if (process.env['VALIDATOR_E2E_REAL'] !== '1') return;

  const r = spawnSync('git', ['status', '--porcelain', '--', 'test/fixtures/'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    shell: false,
  });
  // git itself failing is not a fixture-pollution signal — don't mask the
  // suite's real result behind an environmental git error.
  if (r.status !== 0 || typeof r.stdout !== 'string') {
    console.warn('[e2e-real/teardown] git status failed; skipping fixture-clean assertion.');
    return;
  }
  const dirty = r.stdout.split(/\r?\n/).filter((l) => l.length > 0);
  if (dirty.length > 0) {
    throw new Error(
      '[e2e-real/teardown] test/fixtures/ is dirty after the e2e-real run — the sandbox ' +
        'isolation regressed (something wrote to the tracked in-repo fixtures):\n' +
        dirty.join('\n'),
    );
  }
  console.log('[e2e-real/teardown] test/fixtures/ is byte-clean — sandbox isolation held.');
}
