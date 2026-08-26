/**
 * V1.9.5 (INF-1) — offline guard for the e2e-real sandbox materializer.
 *
 * `materializeSandboxInto` is the isolation core the whole
 * VALIDATOR_E2E_REAL lane stands on since INF-1: every real `validate` /
 * `generate` run executes inside a sandbox it built, and the suite's
 * teardown asserts the tracked fixtures stayed byte-clean. That lane is
 * paid + human-triggered and only ever runs where a developer sits (Windows
 * today), so THIS test is deliberately in the cheap offline suite: it is the
 * only place the POSIX `symlinkSync(..., 'dir')` branch executes in CI (the
 * ubuntu leg), and the only $0 witness of the Windows junction branch.
 *
 * It drives the real function over a tiny synthetic fixture — no network,
 * no LLM, no real fixture install needed.
 */

import { afterEach, describe, expect, test } from 'vitest';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializeSandboxInto } from '../e2e-real/_shared.js';

const COPY_ENTRIES = ['webapp', 'package.json'] as const;

function makeFakeFixture(base: string): string {
  const fixture = join(base, 'fixture');
  mkdirSync(join(fixture, 'webapp', 'controller'), { recursive: true });
  writeFileSync(
    join(fixture, 'webapp', 'controller', 'App.controller.js'),
    'sap.ui.define([], function () { "use strict"; return {}; });\n',
    'utf8',
  );
  writeFileSync(join(fixture, 'package.json'), '{"name":"fake-fixture"}\n', 'utf8');
  // An installed dep the sandbox must reach THROUGH the node_modules link.
  mkdirSync(join(fixture, 'node_modules', 'fake-pkg'), { recursive: true });
  writeFileSync(join(fixture, 'node_modules', 'fake-pkg', 'index.js'), 'module.exports = 42;\n', 'utf8');
  // Present in the fixture but NOT in the copy-entry list — must not be copied
  // (the shared validate sandboxes need a virgin output directory).
  mkdirSync(join(fixture, '.sapui5-validator'), { recursive: true });
  writeFileSync(join(fixture, '.sapui5-validator', 'report.json'), '{}', 'utf8');
  return fixture;
}

describe('materializeSandboxInto (e2e-real sandbox isolation core)', () => {
  const bases: string[] = [];

  function freshBase(): string {
    const base = mkdtempSync(join(tmpdir(), 'sandbox-materialize-test-'));
    bases.push(base);
    return base;
  }

  afterEach(() => {
    for (const base of bases.splice(0)) {
      try {
        rmSync(base, { recursive: true, force: true });
      } catch {
        // Best-effort — leave stragglers to the OS tmp reaper.
      }
    }
  });

  test('copies the listed entries, links node_modules, and skips everything else', () => {
    const base = freshBase();
    const fixture = makeFakeFixture(base);
    const sandbox = join(base, 'sandbox');

    materializeSandboxInto({ fixtureRoot: fixture, sandboxRoot: sandbox, copyEntries: COPY_ENTRIES });

    // Listed entries arrived as real copies.
    expect(readFileSync(join(sandbox, 'package.json'), 'utf8')).toContain('fake-fixture');
    expect(existsSync(join(sandbox, 'webapp', 'controller', 'App.controller.js'))).toBe(true);
    expect(lstatSync(join(sandbox, 'webapp')).isSymbolicLink()).toBe(false);

    // node_modules is a LINK (junction on Windows, dir symlink on POSIX —
    // lstat reports both as a symbolic link) and resolves through to the
    // fixture's installed dep.
    expect(lstatSync(join(sandbox, 'node_modules')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(sandbox, 'node_modules', 'fake-pkg', 'index.js'), 'utf8')).toContain('42');

    // Unlisted entries stayed behind — the sandbox gets a virgin output dir.
    expect(existsSync(join(sandbox, '.sapui5-validator'))).toBe(false);
  });

  test('sandbox mutations never reach the fixture (the isolation property)', () => {
    const base = freshBase();
    const fixture = makeFakeFixture(base);
    const sandbox = join(base, 'sandbox');
    materializeSandboxInto({ fixtureRoot: fixture, sandboxRoot: sandbox, copyEntries: COPY_ENTRIES });

    const rel = join('webapp', 'controller', 'App.controller.js');
    writeFileSync(join(sandbox, rel), '// LLM-applied fix lands here\n', 'utf8');

    expect(readFileSync(join(fixture, rel), 'utf8')).toContain('sap.ui.define');
    expect(readFileSync(join(fixture, rel), 'utf8')).not.toContain('LLM-applied');
  });

  test('re-materializing over a previous sandbox resets it without touching the linked install', () => {
    const base = freshBase();
    const fixture = makeFakeFixture(base);
    const sandbox = join(base, 'sandbox');
    materializeSandboxInto({ fixtureRoot: fixture, sandboxRoot: sandbox, copyEntries: COPY_ENTRIES });

    // Simulate a previous run's residue: a mutated copy + run artifacts.
    writeFileSync(join(sandbox, 'webapp', 'controller', 'App.controller.js'), '// stale\n', 'utf8');
    mkdirSync(join(sandbox, '.sapui5-validator'), { recursive: true });
    writeFileSync(join(sandbox, '.sapui5-validator', 'report.json'), '{"stale":true}', 'utf8');

    // The second materialize must remove the old sandbox INCLUDING its
    // node_modules link as a link (rmSync must not follow the junction /
    // symlink and delete the fixture's real install), then rebuild fresh.
    materializeSandboxInto({ fixtureRoot: fixture, sandboxRoot: sandbox, copyEntries: COPY_ENTRIES });

    expect(
      readFileSync(join(sandbox, 'webapp', 'controller', 'App.controller.js'), 'utf8'),
    ).toContain('sap.ui.define');
    expect(existsSync(join(sandbox, '.sapui5-validator'))).toBe(false);
    // The real install survived the removal of the linked previous sandbox.
    expect(existsSync(join(fixture, 'node_modules', 'fake-pkg', 'index.js'))).toBe(true);
    expect(lstatSync(join(sandbox, 'node_modules')).isSymbolicLink()).toBe(true);
  });
});
