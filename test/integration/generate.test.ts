/**
 * SPEC §2.1, §2.3, §2.4, §2.10 end-to-end coverage for the `generate`
 * orchestrator.
 *
 * Three scenarios:
 *   (a) Happy path — the LLM returns a passing QUnit test and the orchestrator
 *       records it as `passed` in `report.generatedTests`, exits 0.
 *   (b) `_failing/` quarantine — the LLM returns broken content 3×, the
 *       orchestrator moves the file under `webapp/test/_failing/` with a
 *       `.failing.qunit.js` suffix, records `quarantined`, exits 1 because
 *       the failing test was the user's explicitly requested path.
 *   (c) No-tests project with `--json` (non-interactive) — orchestrator
 *       refuses to scaffold and exits with `no-tests-template-required`.
 */

import { Buffer } from 'node:buffer';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { runGenerate } from '../../src/commands/generate.js';
import { program } from '../../src/cli.js';
import { detectDiscoveryMode } from '../../src/generation/registration.js';
import { FakeClaudeRunner } from '../../src/claude/fake-runner.js';
import type {
  ClaudeRunArgs,
  ClaudeRunResult,
  ClaudeRunner,
} from '../../src/claude/runner.js';
import {
  BinaryRunner,
  ClaudeProcessKilledError,
  MalformedLlmOutputError,
  RateLimitExhaustedError,
} from '../../src/claude/binary-runner.js';
import type { Sleeper } from '../../src/claude/budget.js';
import type { MenuIo } from '../../src/budget/menu.js';
import type { ProbeAdapter } from '../../src/project/tooling.js';
import type { VerifyAdapters } from '../../src/verify/pipeline.js';
import type { ExecImpl, ExecResult } from '../../src/util/exec.js';
import type { ReportGeneratedTest, RunReport } from '../../src/types.js';
import {
  MAX_PROMPT_FEEDBACK_BYTES,
} from '../../src/util/prompt-feedback.js';
import { buildQunitRefinementPrompt } from '../../src/generation/qunit.js';

const MINIMAL_FIXTURE = join(process.cwd(), 'test', 'fixtures', 'minimal-project');
const NO_TESTS_FIXTURE = join(process.cwd(), 'test', 'fixtures', 'no-tests-project');

/**
 * V1.9.7 (THR-1) — the effective `--concurrency` default commander applies for a
 * command, read off the registered CLI option (mirrors cli-concurrency.test.ts).
 * The equivalence witnesses pass THIS to the orchestrator so they track the real
 * CLI default; the `> 1` guard in each witness fails loudly if it is ever reset
 * to 1 (which would silently turn the witness into a vacuous K=1-vs-K=1 compare).
 */
function cliConcurrencyDefault(command: 'validate' | 'generate'): number {
  const cmd = program.commands.find((c: Command) => c.name() === command);
  const opt = cmd?.options.find((o) => o.long === '--concurrency');
  if (opt === undefined) throw new Error(`--concurrency not registered on ${command}`);
  return opt.defaultValue as number;
}

const ALL_TOOLS_OK: ProbeAdapter = {
  probe: () => ({ present: true, version: '1.0.0', source: 'node_modules' }),
};

function adaptersOk(): VerifyAdapters {
  return {
    ui5lint: async () => ({ ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1 }),
    eslint: async () => ({ ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1 }),
    karma: async () => ({
      ok: true,
      stdout: '',
      stderr: '',
      exitCode: 0,
      durationMs: 1,
      testFiles: [],
    }),
  };
}

interface Project {
  readonly root: string;
  cleanup(): void;
}

function setupFrom(fixture: string): Project {
  const root = mkdtempSync(join(tmpdir(), 'sapui5-generate-'));
  cpSync(fixture, root, { recursive: true });
  return {
    root,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** An in-memory writable, mirroring `validate.test.ts`'s `memWritable`. */
function memWritable(sink: string[]): NodeJS.WritableStream {
  return new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      sink.push(chunk.toString());
      cb();
    },
  });
}

describe('runGenerate — happy path (QUnit only)', () => {
  let project: Project;

  beforeEach(() => {
    project = setupFrom(MINIMAL_FIXTURE);
    // Add a second controller without test coverage so generate has work to do.
    writeFileSync(
      join(project.root, 'webapp', 'controller', 'Other.controller.js'),
      [
        'sap.ui.define(["sap/ui/core/mvc/Controller"], function (Controller) {',
        '  "use strict";',
        '  return Controller.extend("minimal.project.controller.Other", {',
        '    onInit: function () {}',
        '  });',
        '});',
        '',
      ].join('\n'),
      'utf8',
    );
  });

  afterEach(() => {
    project.cleanup();
  });

  test('LLM produces a passing QUnit test → status=passed, exit 0', async () => {
    const targetControllerAbs = join(
      project.root,
      'webapp',
      'controller',
      'Other.controller.js',
    );
    const expectedTestRel = 'webapp/test/unit/controller/Other.controller.qunit.js';
    const expectedTestAbs = join(project.root, expectedTestRel);
    const passingTest = [
      'sap.ui.define([',
      '  "minimal/project/controller/Other.controller"',
      '], function (Other) {',
      '  "use strict";',
      '  QUnit.module("controller.Other");',
      '  QUnit.test("module loads", function (assert) {',
      '    assert.ok(Other, "Other controller module loads");',
      '  });',
      '});',
      '',
    ].join('\n');

    const runner = new FakeClaudeRunner([
      {
        match: /Task: generate a QUnit unit test file/,
        response: { raw: JSON.stringify({ newFileContent: passingTest }) },
      },
    ]);

    const result = await runGenerate({
      projectRoot: project.root,
      path: targetControllerAbs,
      force: true,
      qunitOnly: true,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adaptersOk(),
    });

    expect(result.exitCode).toBe(0);
    expect(result.report.exitReason).toEqual({ kind: 'success' });
    expect(result.report.command).toBe('generate');
    expect(result.report.schemaVersion).toBe(2);
    expect(result.report.generatedTests).toHaveLength(1);
    const entry = result.report.generatedTests[0]!;
    expect(entry.sourceFile).toBe('webapp/controller/Other.controller.js');
    expect(entry.testFile).toBe(expectedTestRel);
    expect(entry.status).toBe('passed');
    expect(result.report.llmCallCount).toBe(1);
    expect(readFileSync(expectedTestAbs, 'utf8')).toBe(passingTest);
  });
});

describe('runGenerate — quarantine path', () => {
  let project: Project;

  beforeEach(() => {
    project = setupFrom(MINIMAL_FIXTURE);
    writeFileSync(
      join(project.root, 'webapp', 'controller', 'Other.controller.js'),
      '// Other\n',
      'utf8',
    );
  });

  afterEach(() => {
    project.cleanup();
  });

  test('3× broken outputs → moved to webapp/test/_failing/, exit 1, report quarantined', async () => {
    const targetControllerAbs = join(
      project.root,
      'webapp',
      'controller',
      'Other.controller.js',
    );
    let initial = 0;
    let refine = 0;
    const runner = new FakeClaudeRunner([
      {
        match: (a) => a.prompt.includes('did not pass verification'),
        response: () => {
          refine += 1;
          return { raw: JSON.stringify({ newFileContent: `// BROKEN refine ${refine}\n` }) };
        },
      },
      {
        match: /Task: generate a QUnit unit test file/,
        response: () => {
          initial += 1;
          return { raw: JSON.stringify({ newFileContent: '// BROKEN initial\n' }) };
        },
      },
    ]);

    // Baseline must succeed, but verify during the retry loop must fail. We
    // toggle on disk presence: the test file written by the generator turns
    // verify red; while it doesn't exist (baseline), we return green.
    const expectedTestRel = 'webapp/test/unit/controller/Other.controller.qunit.js';
    const expectedTestAbs = join(project.root, expectedTestRel);
    const verifyAdapters: VerifyAdapters = {
      ui5lint: async () => ({ ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1 }),
      eslint: async () => ({ ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1 }),
      karma: async ({ testFiles }) => {
        const targeting = testFiles?.includes(expectedTestAbs) === true;
        if (targeting && existsSync(expectedTestAbs)) {
          return {
            ok: false,
            stdout: '',
            stderr: 'karma: test failed — assertion mismatch',
            exitCode: 1,
            durationMs: 1,
            testFiles: testFiles ?? [],
          };
        }
        return {
          ok: true,
          stdout: '',
          stderr: '',
          exitCode: 0,
          durationMs: 1,
          testFiles: testFiles ?? [],
        };
      },
    };

    const result = await runGenerate({
      projectRoot: project.root,
      path: targetControllerAbs,
      force: true,
      qunitOnly: true,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters,
    });

    expect(result.exitCode).toBe(1);
    expect(result.report.generatedTests).toHaveLength(1);
    const entry = result.report.generatedTests[0]!;
    expect(entry.status).toBe('quarantined');
    expect(entry.sourceFile).toBe('webapp/controller/Other.controller.js');
    expect(entry.testFile).toBe(
      'webapp/test/_failing/Other.controller.failing.qunit.js',
    );
    // The intended test path is gone; the quarantined copy exists.
    expect(existsSync(expectedTestAbs)).toBe(false);
    expect(
      existsSync(
        join(project.root, 'webapp', 'test', '_failing', 'Other.controller.failing.qunit.js'),
      ),
    ).toBe(true);
    // 1 initial + 2 refinements = 3 LLM calls.
    expect(initial).toBe(1);
    expect(refine).toBe(2);
    expect(result.report.llmCallCount).toBe(3);
  });
});

describe('runGenerate — no-tests project with --json (non-interactive)', () => {
  let project: Project;

  beforeEach(() => {
    project = setupFrom(NO_TESTS_FIXTURE);
  });

  afterEach(() => {
    project.cleanup();
  });

  test('--json mode hard-fails with no-tests-template-required, does not scaffold', async () => {
    const runner = new FakeClaudeRunner([]);
    const result = await runGenerate({
      projectRoot: project.root,
      force: true,
      json: true,
      interactive: false,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adaptersOk(),
    });

    expect(result.exitCode).toBe(1);
    expect(result.report.exitReason).toEqual({ kind: 'no-tests-template-required' });
    expect(result.report.llmCallCount).toBe(0);
    // Nothing scaffolded.
    expect(existsSync(join(project.root, 'webapp', 'test'))).toBe(false);
  });

  test('non-TTY (interactive: false) hard-fails the same way, regardless of --json', async () => {
    const runner = new FakeClaudeRunner([]);
    const result = await runGenerate({
      projectRoot: project.root,
      force: true,
      json: false,
      interactive: false,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adaptersOk(),
    });
    expect(result.exitCode).toBe(1);
    expect(result.report.exitReason).toEqual({ kind: 'no-tests-template-required' });
  });

  test('interactive + templatePicker scaffolds and then runs generators', async () => {
    const runner = new FakeClaudeRunner([
      // No QUnit candidates exist after scaffolding (App.controller.js has no
      // test yet — generator must produce one).
      {
        match: /Task: generate a QUnit unit test file/,
        response: { raw: JSON.stringify({ newFileContent: '// passing\n' }) },
      },
      {
        match: /Task: generate an OPA5 journey/,
        response: { raw: JSON.stringify({ newFileContent: '// opa\n' }) },
      },
    ]);
    const result = await runGenerate({
      projectRoot: project.root,
      force: true,
      interactive: true,
      templatePicker: async () => 'sap.m',
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adaptersOk(),
    });
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(project.root, 'webapp', 'test', 'testsuite.qunit.html'))).toBe(true);
    expect(result.report.generatedTests.length).toBeGreaterThan(0);
  });
});

describe('runGenerate — baseline-clean guard', () => {
  let project: Project;

  beforeEach(() => {
    project = setupFrom(MINIMAL_FIXTURE);
  });

  afterEach(() => {
    project.cleanup();
  });

  test('any baseline finding → exit baseline-failed without invoking generators', async () => {
    const controllerAbs = join(
      project.root,
      'webapp',
      'controller',
      'Main.controller.js',
    );
    const runner = new FakeClaudeRunner([]);
    const verifyAdapters: VerifyAdapters = {
      ui5lint: async () => ({
        ok: false,
        stdout: '',
        stderr: 'ui5lint: hypothetical lint failure',
        exitCode: 1,
        durationMs: 1,
      }),
      eslint: async () => ({ ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1 }),
      karma: async () => ({
        ok: true,
        stdout: '',
        stderr: '',
        exitCode: 0,
        durationMs: 1,
        testFiles: [],
      }),
    };
    const result = await runGenerate({
      projectRoot: project.root,
      path: controllerAbs,
      force: true,
      qunitOnly: true,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters,
    });
    expect(result.exitCode).toBe(1);
    expect(result.report.exitReason).toEqual({ kind: 'baseline-failed' });
    expect(result.report.llmCallCount).toBe(0);
  });
});

describe('runGenerate — V1.3-3 typed error handling', () => {
  let project: Project;

  beforeEach(() => {
    project = setupFrom(MINIMAL_FIXTURE);
    writeFileSync(
      join(project.root, 'webapp', 'controller', 'Other.controller.js'),
      '// Other\n',
      'utf8',
    );
  });

  afterEach(() => {
    project.cleanup();
  });

  test('rate-limit exhausted on the QUnit generate call → exitReason rate-limited, exit 1, report.json + audit log written', async () => {
    const targetControllerAbs = join(
      project.root,
      'webapp',
      'controller',
      'Other.controller.js',
    );
    const runner = new FakeClaudeRunner([
      {
        match: /Task: generate a QUnit unit test file/,
        response: () => {
          throw new RateLimitExhaustedError(
            'cid-gen-rate',
            4,
            'API Error: 429 Too Many Requests',
          );
        },
      },
    ]);

    const result = await runGenerate({
      projectRoot: project.root,
      path: targetControllerAbs,
      force: true,
      qunitOnly: true,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adaptersOk(),
    });

    expect(result.exitCode).toBe(1);
    expect(result.report.exitReason.kind).toBe('rate-limited');
    if (result.report.exitReason.kind === 'rate-limited') {
      // requestContent's `budget.consume()` runs before the throw.
      expect(result.report.exitReason.callsCompleted).toBe(1);
      expect(result.report.exitReason.lastError).toMatch(/rate limit/i);
      expect(result.report.exitReason.lastError).toMatch(/cid-gen-rate/);
    }
    expect(result.report.llmCallCount).toBe(1);

    // No data loss: report.json was written and the audit-log skeleton was
    // still initialised before the run exited.
    const reportPath = join(project.root, '.sapui5-validator', 'report.json');
    expect(existsSync(reportPath)).toBe(true);
    const reportFromDisk = JSON.parse(readFileSync(reportPath, 'utf8')) as RunReport;
    expect(reportFromDisk.exitReason.kind).toBe('rate-limited');
    expect(reportFromDisk.command).toBe('generate');
    const lastRun = join(project.root, '.sapui5-validator', 'last-run');
    expect(statSync(lastRun).isDirectory()).toBe(true);
    for (const sub of ['prompts', 'responses', 'verify']) {
      expect(statSync(join(lastRun, sub)).isDirectory()).toBe(true);
    }
  });

  test('R1.2 (§5.6a): terminal signal on the INITIAL call reports no-output, never a fabricated quarantine', async () => {
    // The rate-limit kills the first content call, so NO file was ever
    // written. Before R1.2 the pool fabricated `status: 'quarantined'` with
    // `testFile` pointing at a path that does not exist on disk.
    const targetControllerAbs = join(
      project.root,
      'webapp',
      'controller',
      'Other.controller.js',
    );
    const runner = new FakeClaudeRunner([
      {
        match: /Task: generate a QUnit unit test file/,
        response: () => {
          throw new RateLimitExhaustedError('cid-init-rate', 4, '429 Too Many Requests');
        },
      },
    ]);

    const result = await runGenerate({
      projectRoot: project.root,
      path: targetControllerAbs,
      force: true,
      qunitOnly: true,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adaptersOk(),
    });

    expect(result.report.exitReason.kind).toBe('rate-limited');
    expect(result.report.generatedTests).toHaveLength(1);
    const entry = result.report.generatedTests[0]!;
    expect(entry.status).toBe('no-output');
    expect(entry.quarantineReason?.phase).toBe('initial');
    // The entry names the intended target only; nothing reached disk and
    // nothing was quarantined.
    expect(entry.testFile).toBe('webapp/test/unit/controller/Other.controller.qunit.js');
    expect(existsSync(join(project.root, entry.testFile))).toBe(false);
    expect(existsSync(join(project.root, 'webapp', 'test', '_failing'))).toBe(false);
  });

  test('R1.2 (§5.6a): terminal signal mid-refinement still reports the real quarantined file (typed channel)', async () => {
    // Attempt-1 content IS on disk when the refinement call rate-limits, so
    // the quarantine is real — the typed side channel must carry the
    // `_failing/` path to the report exactly as the old Object.assign did.
    const targetControllerAbs = join(
      project.root,
      'webapp',
      'controller',
      'Other.controller.js',
    );
    const expectedTestAbs = join(
      project.root,
      'webapp',
      'test',
      'unit',
      'controller',
      'Other.controller.qunit.js',
    );
    const runner = new FakeClaudeRunner([
      {
        match: (a) => a.prompt.includes('did not pass verification'),
        response: () => {
          throw new RateLimitExhaustedError('cid-refine-rate', 4, '429 Too Many Requests');
        },
      },
      {
        match: /Task: generate a QUnit unit test file/,
        response: { raw: JSON.stringify({ newFileContent: '// BROKEN initial\n' }) },
      },
    ]);
    const verifyAdapters: VerifyAdapters = {
      ui5lint: async () => ({ ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1 }),
      eslint: async () => ({ ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1 }),
      karma: async ({ testFiles }) => {
        const targeting = testFiles?.includes(expectedTestAbs) === true;
        if (targeting && existsSync(expectedTestAbs)) {
          return {
            ok: false,
            stdout: '',
            stderr: 'karma: test failed',
            exitCode: 1,
            durationMs: 1,
            testFiles: testFiles ?? [],
          };
        }
        return { ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1, testFiles: testFiles ?? [] };
      },
    };

    const result = await runGenerate({
      projectRoot: project.root,
      path: targetControllerAbs,
      force: true,
      qunitOnly: true,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters,
    });

    expect(result.report.exitReason.kind).toBe('rate-limited');
    expect(result.report.generatedTests).toHaveLength(1);
    const entry = result.report.generatedTests[0]!;
    expect(entry.status).toBe('quarantined');
    expect(entry.testFile).toBe('webapp/test/_failing/Other.controller.failing.qunit.js');
    expect(existsSync(join(project.root, entry.testFile))).toBe(true);
  });

  test('LLM returns unparseable output → generatedTests status=no-output, exit non-zero', async () => {
    const targetControllerAbs = join(
      project.root,
      'webapp',
      'controller',
      'Other.controller.js',
    );
    const runner = new FakeClaudeRunner([
      {
        match: /Task: generate a QUnit unit test file/,
        response: { raw: 'not json at all' },
      },
    ]);

    const result = await runGenerate({
      projectRoot: project.root,
      path: targetControllerAbs,
      force: true,
      qunitOnly: true,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adaptersOk(),
    });

    expect(result.report.generatedTests).toHaveLength(1);
    expect(result.report.generatedTests[0]!.status).toBe('no-output');
    // Coupled exit-logic fix: a no-output-only run must still exit non-zero.
    // With the pre-V1.3-3 `quarantined`-only filter this run exited 0.
    expect(result.exitCode).not.toBe(0);
  });
});

describe('runGenerate — V1.3-4 QUnit test registration', () => {
  let project: Project;

  // A sap.ui.require([...]) testsuite.qunit.html so detectDiscoveryMode
  // classifies the project as `testsuite-require` — minimal-project ships an
  // <a href> index page (→ glob-auto via its karma files: glob), which
  // registration treats as a no-op. Overwriting it here mirrors the karma-ui5
  // html-mode shape the e2e witness exercises, making register/unregister
  // observable through the orchestrator.
  const MAIN_MODULE = 'minimal/project/test/unit/controller/Main.controller.qunit';
  const OTHER_MODULE = 'minimal/project/test/unit/controller/Other.controller.qunit';
  const REQUIRE_TESTSUITE = [
    '<!DOCTYPE html>',
    '<html>',
    '<head>',
    '  <title>QUnit test suite for minimal.project</title>',
    '  <meta charset="utf-8">',
    '  <script>',
    '    QUnit.config.autostart = false;',
    '    sap.ui.require([',
    `      "${MAIN_MODULE}"`,
    '    ], function () {',
    '      QUnit.start();',
    '    });',
    '  </script>',
    '</head>',
    '<body></body>',
    '</html>',
    '',
  ].join('\n');

  beforeEach(() => {
    project = setupFrom(MINIMAL_FIXTURE);
    writeFileSync(
      join(project.root, 'webapp', 'test', 'testsuite.qunit.html'),
      REQUIRE_TESTSUITE,
      'utf8',
    );
    writeFileSync(
      join(project.root, 'webapp', 'controller', 'Other.controller.js'),
      '// Other\n',
      'utf8',
    );
  });

  afterEach(() => {
    project.cleanup();
  });

  test('a passing generated test is registered in testsuite.qunit.html', async () => {
    const targetControllerAbs = join(
      project.root,
      'webapp',
      'controller',
      'Other.controller.js',
    );
    const runner = new FakeClaudeRunner([
      {
        match: /Task: generate a QUnit unit test file/,
        response: { raw: JSON.stringify({ newFileContent: '// passing\n' }) },
      },
    ]);

    const result = await runGenerate({
      projectRoot: project.root,
      path: targetControllerAbs,
      force: true,
      qunitOnly: true,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adaptersOk(),
    });

    expect(result.exitCode).toBe(0);
    expect(result.report.generatedTests[0]!.status).toBe('passed');
    const testsuite = readFileSync(
      join(project.root, 'webapp', 'test', 'testsuite.qunit.html'),
      'utf8',
    );
    // The generated module is registered; the pre-existing entry survives the
    // parse-mutate-write round-trip.
    expect(testsuite).toContain(OTHER_MODULE);
    expect(testsuite).toContain(MAIN_MODULE);
  });

  test('a quarantined test (3× failure) is unregistered from testsuite.qunit.html', async () => {
    const targetControllerAbs = join(
      project.root,
      'webapp',
      'controller',
      'Other.controller.js',
    );
    const expectedTestAbs = join(
      project.root,
      'webapp',
      'test',
      'unit',
      'controller',
      'Other.controller.qunit.js',
    );
    let refine = 0;
    const runner = new FakeClaudeRunner([
      {
        match: (a) => a.prompt.includes('did not pass verification'),
        response: () => {
          refine += 1;
          return { raw: JSON.stringify({ newFileContent: `// BROKEN refine ${refine}\n` }) };
        },
      },
      {
        match: /Task: generate a QUnit unit test file/,
        response: { raw: JSON.stringify({ newFileContent: '// BROKEN initial\n' }) },
      },
    ]);
    const verifyAdapters: VerifyAdapters = {
      ui5lint: async () => ({ ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1 }),
      eslint: async () => ({ ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1 }),
      karma: async ({ testFiles }) => {
        const targeting = testFiles?.includes(expectedTestAbs) === true;
        if (targeting && existsSync(expectedTestAbs)) {
          return {
            ok: false,
            stdout: '',
            stderr: 'karma: test failed',
            exitCode: 1,
            durationMs: 1,
            testFiles: testFiles ?? [],
          };
        }
        return {
          ok: true,
          stdout: '',
          stderr: '',
          exitCode: 0,
          durationMs: 1,
          testFiles: testFiles ?? [],
        };
      },
    };

    const result = await runGenerate({
      projectRoot: project.root,
      path: targetControllerAbs,
      force: true,
      qunitOnly: true,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters,
    });

    expect(result.exitCode).toBe(1);
    expect(result.report.generatedTests[0]!.status).toBe('quarantined');
    expect(
      existsSync(
        join(project.root, 'webapp', 'test', '_failing', 'Other.controller.failing.qunit.js'),
      ),
    ).toBe(true);
    const testsuite = readFileSync(
      join(project.root, 'webapp', 'test', 'testsuite.qunit.html'),
      'utf8',
    );
    // Registered on attempt 1, then unregistered by quarantine — net absent.
    // The pre-existing entry is untouched.
    expect(testsuite).not.toContain(OTHER_MODULE);
    expect(testsuite).toContain(MAIN_MODULE);
  });
});

describe('runGenerate — V1.3-5 karma-unavailable classification', () => {
  let project: Project;

  beforeEach(() => {
    project = setupFrom(MINIMAL_FIXTURE);
    writeFileSync(
      join(project.root, 'webapp', 'controller', 'Other.controller.js'),
      '// Other\n',
      'utf8',
    );
  });

  afterEach(() => {
    project.cleanup();
  });

  test('an unrunnable karma runner aborts with karma-unavailable, exit 1, no LLM refinement', async () => {
    const targetControllerAbs = join(
      project.root,
      'webapp',
      'controller',
      'Other.controller.js',
    );
    const expectedTestAbs = join(
      project.root,
      'webapp',
      'test',
      'unit',
      'controller',
      'Other.controller.qunit.js',
    );
    let initial = 0;
    let refine = 0;
    const runner = new FakeClaudeRunner([
      {
        match: (a) => a.prompt.includes('did not pass verification'),
        response: () => {
          refine += 1;
          return { raw: JSON.stringify({ newFileContent: `// refine ${refine}\n` }) };
        },
      },
      {
        match: /Task: generate a QUnit unit test file/,
        response: () => {
          initial += 1;
          return { raw: JSON.stringify({ newFileContent: '// initial\n' }) };
        },
      },
    ]);
    // Karma is green for the baseline per-file pass (no testFiles → karma is
    // skipped there), then reports an unrunnable runner once the generated
    // test is verified. The stdout is the real "Bogus" browser-launcher
    // output captured in V1.3-5 — `classifyKarmaFailure` must mark this
    // `runner-unavailable`, not a test failure.
    const verifyAdapters: VerifyAdapters = {
      ui5lint: async () => ({ ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1 }),
      eslint: async () => ({ ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1 }),
      karma: async ({ testFiles }) => {
        const targeting = testFiles?.includes(expectedTestAbs) === true;
        if (targeting) {
          return {
            ok: false,
            stdout:
              'ERROR [launcher]: Cannot load browser "Bogus": it is not ' +
              'registered! Perhaps you are missing some plugin?\n' +
              'ERROR [karma-server]: Error: Found 1 load error\n',
            stderr: '',
            exitCode: 1,
            durationMs: 1,
            testFiles: testFiles ?? [],
          };
        }
        return {
          ok: true,
          stdout: '',
          stderr: '',
          exitCode: 0,
          durationMs: 1,
          testFiles: testFiles ?? [],
        };
      },
    };

    const result = await runGenerate({
      projectRoot: project.root,
      // Single-controller path scope: scope.qunitTest is empty, so the V1.3-6
      // unconditional baseline karma probe calls karma with no targeted test
      // file — the adapter returns ok for that call, so the probe passes. The
      // dead runner then surfaces at retry-loop verify time (the generated
      // test IS targeted) — exactly the V1.3-5 mid-run failure mode, distinct
      // from V1.3-6's pre-flight gate.
      path: targetControllerAbs,
      force: true,
      qunitOnly: true,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters,
    });

    expect(result.exitCode).toBe(1);
    expect(result.report.exitReason).toEqual({ kind: 'karma-unavailable' });
    // Exactly one LLM call — the initial generate. No refinement was attempted
    // against the dead runner (this is the V1.3-5 exit criterion).
    expect(initial).toBe(1);
    expect(refine).toBe(0);
    expect(result.report.llmCallCount).toBe(1);
    // The aborting candidate produces no report entry (no file quarantined).
    expect(result.report.generatedTests).toHaveLength(0);
    // The unverified test file is left on disk but NOT quarantined — it must
    // not get the `_failing/` move or the `.failing` suffix (it is sound).
    expect(existsSync(expectedTestAbs)).toBe(true);
    expect(
      existsSync(
        join(project.root, 'webapp', 'test', '_failing', 'Other.controller.failing.qunit.js'),
      ),
    ).toBe(false);
  });

  test('COR-13a: a baseline karma probe that THROWS finishes with a report, not an escaped throw', async () => {
    // Pre-COR-13a an adapter THROW from the unconditional baseline karma probe
    // escaped past finish(), so runGenerate rejected and the report was lost.
    // It must now be caught and routed to the karma-unavailable exit reason —
    // `await runGenerate(...)` resolving (not rejecting) is itself the fix.
    const runner = new FakeClaudeRunner([
      { match: /./, response: { raw: JSON.stringify({ newFileContent: '// x\n' }) } },
    ]);
    const verifyAdapters: VerifyAdapters = {
      ui5lint: async () => ({ ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1 }),
      eslint: async () => ({ ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1 }),
      karma: async () => {
        throw new Error('karma binary failed to spawn (ENOENT)');
      },
    };
    const result = await runGenerate({
      projectRoot: project.root,
      all: true,
      force: true,
      qunitOnly: true,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters,
    });
    expect(result.report.exitReason).toEqual({ kind: 'karma-unavailable' });
    expect(result.exitCode).toBe(1);
    // The run aborted at the baseline gate — before any generate LLM call — and
    // still produced a real report.
    expect(result.report.llmCallCount).toBe(0);
  });

  // ===================================================================
  // R2.1(c) witnesses (AUDIT-v0.7.0 §5.3c + live §3.1) — the transcript
  // below is synthesized from the §3.1 cap_try formatter verify whose
  // transient DNS blip became a permanent quarantine pre-R2.1.
  // ===================================================================
  const ENOTFOUND_STDOUT =
    '10 06 2026 01:58:12.345:WARN [proxy]: Failed to proxy /resources/sap-ui-core.js ' +
    '(ENOTFOUND: getaddrinfo ENOTFOUND sdk.openui5.org)\n' +
    'WARN [Chrome Headless 131.0.0.0 (Windows 10)]: Disconnected, ' +
    'because no message in 30000 ms.\n';

  function transientAdapters(failures: number): {
    verifyAdapters: VerifyAdapters;
    counters: { targeted: number };
    expectedTestAbs: string;
  } {
    const expectedTestAbs = join(
      project.root,
      'webapp',
      'test',
      'unit',
      'controller',
      'Other.controller.qunit.js',
    );
    const counters = { targeted: 0 };
    const verifyAdapters: VerifyAdapters = {
      ui5lint: async () => ({ ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1 }),
      eslint: async () => ({ ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1 }),
      karma: async ({ testFiles }) => {
        const targeting = testFiles?.includes(expectedTestAbs) === true;
        if (targeting) {
          counters.targeted += 1;
          if (counters.targeted <= failures) {
            return {
              ok: false,
              stdout: ENOTFOUND_STDOUT,
              stderr: '',
              exitCode: 1,
              durationMs: 1,
              testFiles: testFiles ?? [],
            };
          }
        }
        return {
          ok: true,
          stdout: '',
          stderr: '',
          exitCode: 0,
          durationMs: 1,
          testFiles: testFiles ?? [],
        };
      },
    };
    return { verifyAdapters, counters, expectedTestAbs };
  }

  function transientRunner(): { runner: FakeClaudeRunner; counts: { initial: number; refine: number } } {
    const counts = { initial: 0, refine: 0 };
    const runner = new FakeClaudeRunner([
      {
        match: (a) => a.prompt.includes('did not pass verification'),
        response: () => {
          counts.refine += 1;
          return { raw: JSON.stringify({ newFileContent: `// refine ${counts.refine}\n` }) };
        },
      },
      {
        match: /Task: generate a QUnit unit test file/,
        response: () => {
          counts.initial += 1;
          return { raw: JSON.stringify({ newFileContent: '// initial\n' }) };
        },
      },
    ]);
    return { runner, counts };
  }

  test('(R2.1c) ENOTFOUND on first verify, success on the single karma re-run → candidate verified, zero extra LLM calls', async () => {
    const targetControllerAbs = join(
      project.root,
      'webapp',
      'controller',
      'Other.controller.js',
    );
    const { verifyAdapters, counters } = transientAdapters(1);
    const { runner, counts } = transientRunner();

    const result = await runGenerate({
      projectRoot: project.root,
      path: targetControllerAbs,
      force: true,
      qunitOnly: true,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters,
      outputStream: memWritable([]),
    });

    expect(result.exitCode).toBe(0);
    const entry = result.report.generatedTests[0];
    expect(entry?.status).toBe('passed');
    // Exactly one re-run: the targeted karma ran twice (fail, then pass).
    expect(counters.targeted).toBe(2);
    // The retry is a karma re-run, NOT an LLM call: the budget counter
    // saw only the initial generation call.
    expect(result.report.llmCallCount).toBe(1);
    expect(counts.initial).toBe(1);
    expect(counts.refine).toBe(0);
  });

  test('(R2.1c) ENOTFOUND on both runs → runner-unavailable abort; candidate NEVER quarantined, NOT marked passed, zero budget burned on the env blip', async () => {
    const targetControllerAbs = join(
      project.root,
      'webapp',
      'controller',
      'Other.controller.js',
    );
    // Every targeted karma run fails with the transient transcript — a
    // persistent outage. Pre-R2.1 this quarantined the candidate on the
    // FIRST verify as module-load (the §3.1 loss); now the run aborts
    // honestly at run level.
    const { verifyAdapters, counters, expectedTestAbs } = transientAdapters(
      Number.MAX_SAFE_INTEGER,
    );
    const { runner, counts } = transientRunner();

    const result = await runGenerate({
      projectRoot: project.root,
      path: targetControllerAbs,
      force: true,
      qunitOnly: true,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters,
      outputStream: memWritable([]),
    });

    expect(result.exitCode).toBe(1);
    expect(result.report.exitReason).toEqual({ kind: 'karma-unavailable' });
    // Bounded to exactly one re-run — two targeted karma invocations.
    expect(counters.targeted).toBe(2);
    // Zero budget burned past the initial generation: no refinement was
    // attempted against the dead network.
    expect(result.report.llmCallCount).toBe(1);
    expect(counts.refine).toBe(0);
    // NEVER quarantined: no report entry, no `_failing/` move, the (sound)
    // candidate is left on disk un-suffixed; and NOT marked passed either.
    expect(result.report.generatedTests).toHaveLength(0);
    expect(existsSync(expectedTestAbs)).toBe(true);
    expect(
      existsSync(
        join(project.root, 'webapp', 'test', '_failing', 'Other.controller.failing.qunit.js'),
      ),
    ).toBe(false);
  });
});

describe('runGenerate — V1.3-6 unconditional baseline karma probe', () => {
  let project: Project;

  beforeEach(() => {
    project = setupFrom(MINIMAL_FIXTURE);
  });

  afterEach(() => {
    project.cleanup();
  });

  test('a dead karma runner aborts fail-fast with karma-unavailable, exit 1, zero LLM calls', async () => {
    const controllerAbs = join(
      project.root,
      'webapp',
      'controller',
      'Main.controller.js',
    );
    const runner = new FakeClaudeRunner([]);
    // ui5lint + eslint clean; karma cannot start — the real "Bogus" browser
    // launcher output, which classifyKarmaFailure marks `runner-unavailable`.
    const verifyAdapters: VerifyAdapters = {
      ui5lint: async () => ({ ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1 }),
      eslint: async () => ({ ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1 }),
      karma: async ({ testFiles }) => ({
        ok: false,
        stdout:
          'ERROR [launcher]: Cannot load browser "Bogus": it is not ' +
          'registered! Perhaps you are missing some plugin?\n',
        stderr: '',
        exitCode: 1,
        durationMs: 1,
        testFiles: testFiles ?? [],
      }),
    };

    const result = await runGenerate({
      // Single-controller path scope: scope.qunitTest is empty. On master the
      // baseline karma probe is skipped here (V1.3-DIAGNOSIS Area 5); V1.3-6
      // makes it unconditional, so the dead runner is caught before any LLM
      // call — distinct from the V1.3-5 retry-loop test (llmCallCount === 1).
      projectRoot: project.root,
      path: controllerAbs,
      force: true,
      qunitOnly: true,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters,
    });

    expect(result.exitCode).toBe(1);
    expect(result.report.exitReason).toEqual({ kind: 'karma-unavailable' });
    // The fail-fast gate: the probe runs at step 6, before candidate
    // discovery — no LLM call is ever made.
    expect(result.report.llmCallCount).toBe(0);
    expect(runner.calls).toHaveLength(0);
    expect(result.report.generatedTests).toHaveLength(0);
  });

  test('V1.3.1-3: the unconditional baseline karma probe is bounded by a numeric timeout', async () => {
    const controllerAbs = join(
      project.root,
      'webapp',
      'controller',
      'Main.controller.js',
    );
    let karmaTimeoutMs: unknown;
    const verifyAdapters: VerifyAdapters = {
      ui5lint: async () => ({ ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1 }),
      eslint: async () => ({ ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1 }),
      karma: async ({ timeoutMs, testFiles }) => {
        karmaTimeoutMs = timeoutMs;
        return {
          ok: true,
          stdout: '',
          stderr: '',
          exitCode: 0,
          durationMs: 1,
          testFiles: testFiles ?? [],
        };
      },
    };
    await runGenerate({
      projectRoot: project.root,
      path: controllerAbs,
      force: true,
      qunitOnly: true,
      runner: new FakeClaudeRunner([]),
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters,
    });
    // Problem 3: the V1.3-6 baseline karma probe must pass a timeout so a hung
    // runner fails fast instead of freezing the run.
    expect(typeof karmaTimeoutMs).toBe('number');
  });

  test('a red existing suite is refused with baseline-failed for a single-controller scope, zero LLM calls', async () => {
    const controllerAbs = join(
      project.root,
      'webapp',
      'controller',
      'Main.controller.js',
    );
    const runner = new FakeClaudeRunner([]);
    // ui5lint + eslint clean; karma RAN and a test failed — non-zero exit, no
    // bootstrap marker, so classifyKarmaFailure reads it as `test-failure`.
    // On master this single-controller scope skips the probe entirely, so
    // this proves the unconditional-probe fix (V1.3-DIAGNOSIS Area 5).
    const verifyAdapters: VerifyAdapters = {
      ui5lint: async () => ({ ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1 }),
      eslint: async () => ({ ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1 }),
      karma: async ({ testFiles }) => ({
        ok: false,
        stdout: '',
        stderr: 'karma: 1 test failed — assertion mismatch in the existing suite',
        exitCode: 1,
        durationMs: 1,
        testFiles: testFiles ?? [],
      }),
    };

    const result = await runGenerate({
      projectRoot: project.root,
      path: controllerAbs,
      force: true,
      qunitOnly: true,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters,
    });

    expect(result.exitCode).toBe(1);
    expect(result.report.exitReason).toEqual({ kind: 'baseline-failed' });
    expect(result.report.llmCallCount).toBe(0);
    expect(runner.calls).toHaveLength(0);
  });
});

describe('runGenerate — V1.3.1-2 Problem 2 witness — baseline-lint O(N) fan-out', () => {
  let project: Project;

  // 11 extra in-scope files on top of minimal-project's own 4 → N = 15
  // baseline files for an `all: true` glob: 6 controllers (webapp/**/*.js),
  // 3 views (webapp/**/*.view.xml), 2 QUnit tests (webapp/test/**/*.qunit.js).
  // V1.3.1-PLAN Problem 2: the baseline guard's per-file verifyArtifact loop
  // runs one full-project lint subprocess per in-scope file.
  beforeEach(() => {
    project = setupFrom(MINIMAL_FIXTURE);
    for (let i = 1; i <= 6; i += 1) {
      writeFileSync(
        join(project.root, 'webapp', 'controller', `Extra${i}.controller.js`),
        `// Extra controller ${i}\n`,
        'utf8',
      );
    }
    for (let i = 1; i <= 3; i += 1) {
      writeFileSync(
        join(project.root, 'webapp', 'view', `Extra${i}.view.xml`),
        '<mvc:View xmlns:mvc="sap.ui.core.mvc"/>\n',
        'utf8',
      );
    }
    for (let i = 1; i <= 2; i += 1) {
      writeFileSync(
        join(project.root, 'webapp', 'test', 'unit', `Extra${i}.qunit.js`),
        `// Extra QUnit test ${i}\n`,
        'utf8',
      );
    }
  });

  afterEach(() => {
    project.cleanup();
  });

  // V1.3.1-WITNESS: un-skipped + re-pointed in V1.3.1-3 (§4.4). The counter
  // now sits on the batched baseline-lint exec seam (`runBaselineLint`'s
  // injected execImpl), not the per-file verifyArtifact loop — which no longer
  // drives the baseline guard. It counts actual lint subprocess invocations:
  // 15 in-scope files collapse to one ui5lint chunk + one eslint chunk.
  test('baseline guard lints in O(1) subprocesses, not O(files-in-scope)', async () => {
    let lintCalls = 0;
    // The batched baseline-lint exec: every passed file carries one error, so
    // the run still exits baseline-failed before candidate discovery.
    const baselineLintExecImpl: ExecImpl = async (_binary, args = []) => {
      lintCalls += 1;
      const filePaths = args.filter((a) => a !== '-f' && a !== 'json');
      const report = filePaths.map((filePath) => ({
        filePath,
        messages: [
          {
            ruleId: 'hypothetical-rule',
            severity: 2,
            line: 1,
            column: 1,
            message: 'hypothetical baseline lint failure',
          },
        ],
        errorCount: 1,
        warningCount: 0,
        fatalErrorCount: 0,
      }));
      return {
        ok: false,
        stdout: JSON.stringify(report),
        stderr: '',
        exitCode: 1,
        durationMs: 1,
      };
    };
    // The unconditional V1.3-6 karma probe still needs a stub; the baseline
    // must fail on LINT, so karma is green here.
    const verifyAdapters: VerifyAdapters = {
      karma: async () => ({
        ok: true,
        stdout: '',
        stderr: '',
        exitCode: 0,
        durationMs: 1,
        testFiles: [],
      }),
    };

    const result = await runGenerate({
      projectRoot: project.root,
      all: true,
      force: true,
      qunitOnly: true,
      runner: new FakeClaudeRunner([]),
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters,
      baselineLintExecImpl,
    });

    // The injected execImpl fails every file, so the run exits baseline-failed
    // right after the batched lint — before candidate discovery and before any
    // LLM call. These three guard the witness against a setup-shape regression.
    expect(result.exitCode).toBe(1);
    expect(result.report.exitReason).toEqual({ kind: 'baseline-failed' });
    expect(result.report.llmCallCount).toBe(0);

    // The genuine O(1)-lint-subprocesses gate: 15 in-scope files → one ui5lint
    // chunk + one eslint chunk = 2, independent of file count. Fails on master
    // (pre-V1.3.1-3) with `expected 15 to be less than or equal to 3`.
    expect(lintCalls).toBeLessThanOrEqual(3);
  });
});

describe('runGenerate — V1.3.1-4 Problem 4 — verbose / progress output', () => {
  let project: Project;

  beforeEach(() => {
    project = setupFrom(MINIMAL_FIXTURE);
    // A second controller without coverage so the baseline runs over a real
    // scope and the generator has work to do.
    writeFileSync(
      join(project.root, 'webapp', 'controller', 'Other.controller.js'),
      [
        'sap.ui.define(["sap/ui/core/mvc/Controller"], function (Controller) {',
        '  "use strict";',
        '  return Controller.extend("minimal.project.controller.Other", {',
        '    onInit: function () {}',
        '  });',
        '});',
        '',
      ].join('\n'),
      'utf8',
    );
  });

  afterEach(() => {
    project.cleanup();
  });

  function passingRunner(): FakeClaudeRunner {
    return new FakeClaudeRunner([
      {
        match: /Task: generate a QUnit unit test file/,
        response: { raw: JSON.stringify({ newFileContent: '// passing\n' }) },
      },
    ]);
  }

  const targetController = (root: string): string =>
    join(root, 'webapp', 'controller', 'Other.controller.js');

  test('quiet mode: baseline + karma status lines reach the injected outputStream', async () => {
    const sink: string[] = [];
    const result = await runGenerate({
      projectRoot: project.root,
      path: targetController(project.root),
      force: true,
      qunitOnly: true,
      runner: passingRunner(),
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adaptersOk(),
      outputStream: memWritable(sink),
    });

    expect(result.exitCode).toBe(0);
    const out = sink.join('');
    // The default (quiet-mode) baseline status lines are visible — a slow
    // baseline phase is no longer a silent black box.
    expect(out).toContain('Checking project baseline');
    expect(out).toContain('Running existing test suite (karma)');
    // ...but quiet mode does not leak the --verbose per-phase detail.
    expect(out).not.toContain('baseline lint');
    expect(out).not.toContain('baseline karma');
  });

  test('--verbose: per-phase baseline lines reach the stream, additively', async () => {
    const sink: string[] = [];
    const result = await runGenerate({
      projectRoot: project.root,
      path: targetController(project.root),
      force: true,
      qunitOnly: true,
      verbose: true,
      runner: passingRunner(),
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adaptersOk(),
      outputStream: memWritable(sink),
    });

    expect(result.exitCode).toBe(0);
    const out = sink.join('');
    // The quiet-mode lines are still present — --verbose is purely additive...
    expect(out).toContain('Checking project baseline');
    expect(out).toContain('Running existing test suite (karma)');
    // ...plus per-phase lint + karma lines, the karma one timed.
    expect(out).toMatch(/baseline lint\s+linting/);
    expect(out).toMatch(/baseline lint\s+done\s+\(\d+ms\)/);
    expect(out).toMatch(/baseline karma\s+done\s+\(\d+ms\)/);
  });

  test('--json: no progress reaches the stream and stdout stays clean', async () => {
    const sink: string[] = [];
    // --json must silence progress even with --verbose also set: the json gate
    // beats verbose.
    const stdoutSpy = vi.spyOn(process.stdout, 'write');
    try {
      const result = await runGenerate({
        projectRoot: project.root,
        path: targetController(project.root),
        force: true,
        qunitOnly: true,
        json: true,
        verbose: true,
        runner: passingRunner(),
        probeAdapter: ALL_TOOLS_OK,
        verifyAdapters: adaptersOk(),
        outputStream: memWritable(sink),
      });

      // The report contract is intact — the run still succeeded...
      expect(result.exitCode).toBe(0);
      expect(result.report.exitReason).toEqual({ kind: 'success' });
      // ...and not one progress byte reached either sink. `runGenerate` writes
      // the report to a file; stdout belongs to the CLI's renderResult (which
      // emits the report JSON there) — the orchestrator must never touch it.
      expect(sink.join('')).toBe('');
      expect(stdoutSpy).not.toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
    }
  });
});

describe('runGenerate — V1.3.1-5 Problem 1 — LLM-call estimate + call-limit menu', () => {
  let project: Project;

  // minimal-project ships one covered controller (Main, which already has a
  // test). Two extra uncovered controllers → exactly 2 QUnit candidates under
  // `all: true`. Estimator math: minimum = 2 (one call per candidate),
  // recommended = ceil(2 × GENERATE_RECOMMENDED_SAFETY_FACTOR) = 4 (PERF-14;
  // was 2 × MAX_GENERATE_ATTEMPTS = 6 before the median-factor re-pin).
  beforeEach(() => {
    project = setupFrom(MINIMAL_FIXTURE);
    for (const name of ['Other', 'Another']) {
      writeFileSync(
        join(project.root, 'webapp', 'controller', `${name}.controller.js`),
        `// ${name}\n`,
        'utf8',
      );
    }
  });

  afterEach(() => {
    project.cleanup();
  });

  function passingRunner(): FakeClaudeRunner {
    return new FakeClaudeRunner([
      {
        match: /Task: generate a QUnit unit test file/,
        response: { raw: JSON.stringify({ newFileContent: '// passing\n' }) },
      },
    ]);
  }

  /** Clone of validate.test.ts's `ttyIo` — paired Readable + memory Writables. */
  function ttyIo(lines: readonly string[]): {
    readonly menuIo: MenuIo;
    readonly stdout: string[];
    readonly stderr: string[];
  } {
    const stdin = new PassThrough();
    const stdout: string[] = [];
    const stderr: string[] = [];
    for (const line of lines) stdin.write(`${line}\n`);
    stdin.end();
    return {
      menuIo: {
        stdin,
        stdout: memWritable(stdout),
        stderr: memWritable(stderr),
        isTty: true,
      },
      stdout,
      stderr,
    };
  }

  test('menu fires when recommended > budget; option 2 (accept) raises the budget to recommended', async () => {
    const io = ttyIo(['2']);
    const banner: string[] = [];
    const result = await runGenerate({
      projectRoot: project.root,
      all: true,
      force: true,
      qunitOnly: true,
      maxLlmCalls: 1,
      runner: passingRunner(),
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adaptersOk(),
      menuIo: io.menuIo,
      outputStream: memWritable(banner),
    });
    // The menu rendered with the generate-flavoured candidate header (not the
    // validate file/check-category line).
    expect(io.stdout.join('')).toContain(
      'Detected 2 controllers/views needing tests.',
    );
    expect(io.stdout.join('')).toMatch(/Estimated 2-4 LLM calls/);
    // The estimate banner reached the resolved outputStream (stderr-side).
    expect(banner.join('')).toMatch(
      /Estimated 2-4 LLM calls to generate 2 tests/,
    );
    // Accept → budget raised to recommended (4); both candidates generate.
    expect(result.report.llmCallBudget).toBe(4);
    expect(result.report.exitReason).toEqual({ kind: 'success' });
    expect(result.exitCode).toBe(0);
    expect(result.report.llmCallCount).toBe(2);
  });

  test('COR-13b: interactive:false suppresses the menu even with menuIo + a TTY', async () => {
    // The documented contract is "interactive: false ⇒ never prompt". Pre-COR-13b
    // the menu gate ignored it, so a non-interactive caller on a TTY still got
    // the menu. `ttyIo(['2'])` WOULD accept-and-raise the budget if the menu
    // fired — it must not.
    const io = ttyIo(['2']);
    const result = await runGenerate({
      projectRoot: project.root,
      all: true,
      force: true,
      qunitOnly: true,
      maxLlmCalls: 1,
      interactive: false,
      runner: passingRunner(),
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adaptersOk(),
      menuIo: io.menuIo,
      outputStream: memWritable([]),
    });
    // Menu suppressed: the banner never rendered, the budget stayed at 1, so the
    // run exhausts it (identical outcome to the explicit "continue" choice).
    expect(io.stdout.join('')).not.toContain('Detected 2 controllers/views needing tests.');
    expect(result.report.llmCallBudget).toBe(1);
    expect(result.report.exitReason.kind).toBe('budget-exhausted');
  });

  test('option 1 (continue) keeps the original budget; the run then exhausts it', async () => {
    const io = ttyIo(['1']);
    const result = await runGenerate({
      projectRoot: project.root,
      all: true,
      force: true,
      qunitOnly: true,
      maxLlmCalls: 1,
      runner: passingRunner(),
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adaptersOk(),
      menuIo: io.menuIo,
      outputStream: memWritable([]),
    });
    // Budget unchanged at 1 → the second candidate exhausts it.
    expect(result.report.llmCallBudget).toBe(1);
    expect(result.report.exitReason.kind).toBe('budget-exhausted');
    expect(result.exitCode).toBe(1);
  });

  test('option 3 (custom) — entering the minimum sets the budget to it', async () => {
    const io = ttyIo(['3', '2']);
    const result = await runGenerate({
      projectRoot: project.root,
      all: true,
      force: true,
      qunitOnly: true,
      maxLlmCalls: 1,
      runner: passingRunner(),
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adaptersOk(),
      menuIo: io.menuIo,
      outputStream: memWritable([]),
    });
    // Custom 2 → budget becomes exactly the minimum; both candidates fit.
    expect(result.report.llmCallBudget).toBe(2);
    expect(result.report.exitReason).toEqual({ kind: 'success' });
  });

  test('option 3 (custom) — an arbitrary value resizes the budget to it', async () => {
    const io = ttyIo(['3', '4']);
    const result = await runGenerate({
      projectRoot: project.root,
      all: true,
      force: true,
      qunitOnly: true,
      maxLlmCalls: 1,
      runner: passingRunner(),
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adaptersOk(),
      menuIo: io.menuIo,
      outputStream: memWritable([]),
    });
    expect(result.report.llmCallBudget).toBe(4);
    expect(result.report.exitReason).toEqual({ kind: 'success' });
  });

  test('option 4 (cancel) exits with cancelled-by-user, exit 0, zero LLM calls', async () => {
    const io = ttyIo(['4']);
    const result = await runGenerate({
      projectRoot: project.root,
      all: true,
      force: true,
      qunitOnly: true,
      maxLlmCalls: 1,
      runner: passingRunner(),
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adaptersOk(),
      menuIo: io.menuIo,
      outputStream: memWritable([]),
    });
    expect(result.exitCode).toBe(0);
    expect(result.report.exitReason).toEqual({ kind: 'cancelled-by-user' });
    expect(result.report.llmCallCount).toBe(0);
    expect(result.report.generatedTests).toHaveLength(0);
  });

  test('--no-prompt (noPrompt:true) skips the menu even when recommended > budget', async () => {
    // No menuIo / stdin supplied — if the menu fired, the run would hang or
    // fall back to cancel. The test passes only if the menu is bypassed.
    const result = await runGenerate({
      projectRoot: project.root,
      all: true,
      force: true,
      qunitOnly: true,
      maxLlmCalls: 1,
      noPrompt: true,
      runner: passingRunner(),
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adaptersOk(),
      outputStream: memWritable([]),
    });
    expect(result.report.llmCallBudget).toBe(1);
    expect(result.report.exitReason.kind).toBe('budget-exhausted');
  });

  test('--json skips the menu and runGenerate writes nothing to stdout', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write');
    try {
      const result = await runGenerate({
        projectRoot: project.root,
        all: true,
        force: true,
        qunitOnly: true,
        json: true,
        maxLlmCalls: 1,
        runner: passingRunner(),
        probeAdapter: ALL_TOOLS_OK,
        verifyAdapters: adaptersOk(),
        outputStream: memWritable([]),
      });
      // The json gate suppressed the menu → budget stays 1 → exhausted. If the
      // menu had fired on a --json run it would have hung (no stdin supplied).
      expect(result.report.llmCallBudget).toBe(1);
      expect(result.report.exitReason.kind).toBe('budget-exhausted');
      // The JSON contract is intact — runGenerate touched no stdout byte.
      expect(stdoutSpy).not.toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  test('menu is suppressed when recommended <= the current budget', async () => {
    // Default budget is 50; recommended 4 ≤ 50 → no menu. No stdin supplied;
    // the run would hang if the menu fired.
    const result = await runGenerate({
      projectRoot: project.root,
      all: true,
      force: true,
      qunitOnly: true,
      runner: passingRunner(),
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adaptersOk(),
      outputStream: memWritable([]),
    });
    expect(result.report.llmCallBudget).toBe(50);
    expect(result.report.exitReason).toEqual({ kind: 'success' });
  });
});

// =====================================================================
// V1.3.2-2 witnesses — Bug A (refinement-prompt overflow) and Bug B
// (sinon dialect). Identity stubs in src/util/prompt-feedback.ts and
// src/project/sinon-dialect.ts make these tests fail with specific
// assertion mismatches (AH5) rather than unresolved-import setup
// crashes. V1.3.2-3 (Bug A fix) and V1.3.2-4 (Bug B fix) turn them
// green.
// =====================================================================

/**
 * 80 KB of ANSI-decorated synthetic karma stdout. Exceeds
 * `MAX_PROMPT_FEEDBACK_BYTES` (16 KiB) by ~5×, so V1.3.2-3's sanitiser
 * must truncate when this is the feedback substitution; the raw audit
 * dump under `last-run/verify/<callId>-karma.txt` must keep every byte
 * (AM4).
 */
function syntheticOversizedKarmaOutput(): string {
  const lines: string[] = [];
  // 200-line ANSI-decorated bootstrap-and-progress preamble.
  for (let i = 0; i < 200; i += 1) {
    lines.push(
      `\x1b[32m[${String(i).padStart(4, '0')}]\x1b[0m HeadlessChrome 120: ` +
        `Executed ${i + 1} of 800 SUCCESS (0 secs / 0 secs)`,
    );
  }
  lines.push('\x1b[31mFAILED:\x1b[0m AssertionError — expected 1 to be 0');
  lines.push('    at Foo.controller.onInit (webapp/controller/Foo.controller.js:42:9)');
  // Pad the body until well over 80 KB.
  while (lines.join('\n').length < 82_000) {
    lines.push(
      'HeadlessChrome 120: \x1b[33mTRACE\x1b[0m: large random log message ' +
        'lorem ipsum dolor sit amet consectetur adipiscing elit sed do ' +
        'eiusmod tempor incididunt ut labore et dolore magna aliqua.',
    );
  }
  return `${lines.join('\n')}\n`;
}

describe('runGenerate — V1.3.2-2 Bug A: refinement-prompt feedback truncation', () => {
  let project: Project;
  const stderrCapture: string[] = [];
  const realStderrWrite = process.stderr.write.bind(process.stderr);

  beforeEach(() => {
    project = setupFrom(MINIMAL_FIXTURE);
    writeFileSync(
      join(project.root, 'webapp', 'controller', 'Other.controller.js'),
      '// Other\n',
      'utf8',
    );
    stderrCapture.length = 0;
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderrCapture.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = realStderrWrite;
    project.cleanup();
  });

  test('refinement prompt is capped and tagged with the elision marker; WARN fires; report carries refinementTruncations', async () => {
    const targetControllerAbs = join(
      project.root,
      'webapp',
      'controller',
      'Other.controller.js',
    );
    const expectedTestAbs = join(
      project.root,
      'webapp',
      'test',
      'unit',
      'controller',
      'Other.controller.qunit.js',
    );
    const oversizedKarma = syntheticOversizedKarmaOutput();

    const runner = new FakeClaudeRunner([
      {
        match: (a) => a.prompt.includes('did not pass verification'),
        response: { raw: JSON.stringify({ newFileContent: '// REFINED still broken\n' }) },
      },
      {
        match: /Task: generate a QUnit unit test file/,
        response: { raw: JSON.stringify({ newFileContent: '// INITIAL broken\n' }) },
      },
    ]);

    const verifyAdapters: VerifyAdapters = {
      ui5lint: async () => ({ ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1 }),
      eslint: async () => ({ ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1 }),
      karma: async ({ testFiles }) => {
        const targeting = testFiles?.includes(expectedTestAbs) === true;
        if (targeting && existsSync(expectedTestAbs)) {
          return {
            ok: false,
            stdout: oversizedKarma,
            stderr: '',
            exitCode: 1,
            durationMs: 1,
            testFiles: testFiles ?? [],
          };
        }
        return {
          ok: true,
          stdout: '',
          stderr: '',
          exitCode: 0,
          durationMs: 1,
          testFiles: testFiles ?? [],
        };
      },
    };

    const sink: string[] = [];
    await runGenerate({
      projectRoot: project.root,
      path: targetControllerAbs,
      force: true,
      qunitOnly: true,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters,
      outputStream: memWritable(sink),
    });

    // The refinement call carries the truncated feedback (V1.3.2-3's marker).
    const refinementCall = runner.calls.find((c) =>
      c.prompt.includes('did not pass verification'),
    );
    expect(refinementCall).toBeDefined();
    if (refinementCall === undefined) return;

    // (1) Elision marker present.
    expect(refinementCall.prompt).toContain('… [truncated');

    // (2) Prompt byte size stays under the cap + measured scaffolding + a
    //     small slack for the refinement-prompt previousContent (here ~30 B)
    //     and any other static text.
    // V1.3.2-4 AP2 carve-out: `buildQunitRefinementPrompt` now requires
    // `sinonDialect`. MINIMAL_FIXTURE has karma-ui5 in devDependencies and a
    // karma.conf.js — `detectSinonDialect` resolves to `'sap-bundled'`, so
    // the actual refinement prompt under runGenerate carries the clause.
    // Pinning the scaffolding measurement to `'sap-bundled'` keeps the size
    // assertion accurate (the 512-byte slack would otherwise be exceeded by
    // the ~760-byte clause). Purely a type-compliance change; the witness's
    // intent (cap-bound prompt under the Bug-A truncation contract) is
    // preserved.
    // R1.7a: the refinement prompt now carries the module-id pin, fed by the
    // project namespace — match MINIMAL_FIXTURE's manifest id so the
    // measured scaffolding tracks the real prompt byte-for-byte.
    const scaffolding = buildQunitRefinementPrompt({
      controllerRel: 'webapp/controller/Other.controller.js',
      expectedTestRel: 'webapp/test/unit/controller/Other.controller.qunit.js',
      namespace: 'minimal.project',
      previousContent: '',
      verifyFeedback: '',
      sinonDialect: 'sap-bundled',
    });
    const measuredScaffolding = Buffer.byteLength(scaffolding, 'utf8');
    const promptBytes = Buffer.byteLength(refinementCall.prompt, 'utf8');
    expect(promptBytes).toBeLessThanOrEqual(
      MAX_PROMPT_FEEDBACK_BYTES + measuredScaffolding + 512,
    );

    // (3) WARN visible on stderr / outputStream sink (V1.3.2-3 AM1).
    const stderrText = stderrCapture.join('');
    const combinedStreams = sink.join('') + stderrText;
    expect(combinedStreams).toContain('[WARN] refinement feedback truncated');

    // (4) report.json carries the additive refinementTruncations counter
    //     (V1.3.2-3 — additive, schemaVersion stays 2).
    const reportPath = join(project.root, '.sapui5-validator', 'report.json');
    expect(existsSync(reportPath)).toBe(true);
    const reportFromDisk = JSON.parse(readFileSync(reportPath, 'utf8')) as RunReport;
    const entryFromDisk = reportFromDisk.generatedTests[0] as
      | (ReportGeneratedTest & { refinementTruncations?: number })
      | undefined;
    expect(entryFromDisk).toBeDefined();
    expect(entryFromDisk?.refinementTruncations ?? 0).toBeGreaterThanOrEqual(1);
  });

  test('AM4 — the on-disk verify dump preserves the raw 80 KB karma output byte-for-byte', async () => {
    const targetControllerAbs = join(
      project.root,
      'webapp',
      'controller',
      'Other.controller.js',
    );
    const expectedTestAbs = join(
      project.root,
      'webapp',
      'test',
      'unit',
      'controller',
      'Other.controller.qunit.js',
    );
    const oversizedKarma = syntheticOversizedKarmaOutput();

    const runner = new FakeClaudeRunner([
      {
        match: (a) => a.prompt.includes('did not pass verification'),
        response: { raw: JSON.stringify({ newFileContent: '// REFINED still broken\n' }) },
      },
      {
        match: /Task: generate a QUnit unit test file/,
        response: { raw: JSON.stringify({ newFileContent: '// INITIAL broken\n' }) },
      },
    ]);

    const verifyAdapters: VerifyAdapters = {
      ui5lint: async () => ({ ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1 }),
      eslint: async () => ({ ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1 }),
      karma: async ({ testFiles }) => {
        const targeting = testFiles?.includes(expectedTestAbs) === true;
        if (targeting && existsSync(expectedTestAbs)) {
          return {
            ok: false,
            stdout: oversizedKarma,
            stderr: '',
            exitCode: 1,
            durationMs: 1,
            testFiles: testFiles ?? [],
          };
        }
        return {
          ok: true,
          stdout: '',
          stderr: '',
          exitCode: 0,
          durationMs: 1,
          testFiles: testFiles ?? [],
        };
      },
    };

    await runGenerate({
      projectRoot: project.root,
      path: targetControllerAbs,
      force: true,
      qunitOnly: true,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters,
      outputStream: memWritable([]),
    });

    // The audit-write path (`wrapVerifyFnWithAudit` →
    // `last-run/verify/<callId>-karma.txt`) must contain the raw karma
    // output unchanged — sanitisation is at the prompt site, not in the
    // pipeline (load-bearing invariant from V1.3.2-PLAN.md scope §2).
    const verifyDir = join(project.root, '.sapui5-validator', 'last-run', 'verify');
    const karmaDumps = readdirSync(verifyDir).filter((f) => f.endsWith('-karma.txt'));
    expect(karmaDumps.length).toBeGreaterThan(0);

    // At least one dump carries the full raw karma stdout byte-for-byte.
    const dumpsContainingRaw = karmaDumps.filter((f) => {
      const content = readFileSync(join(verifyDir, f), 'utf8');
      return content.includes(oversizedKarma);
    });
    expect(dumpsContainingRaw.length).toBeGreaterThan(0);

    // And that dump is >= 80 KB (the raw input alone is ~82 KB; the
    // formatVerifyStep preamble adds a few hundred bytes).
    const largest = karmaDumps
      .map((f) => readFileSync(join(verifyDir, f), 'utf8'))
      .reduce<string>((max, cur) => (cur.length > max.length ? cur : max), '');
    expect(Buffer.byteLength(largest, 'utf8')).toBeGreaterThanOrEqual(80_000);
  });
});

describe('runGenerate — V1.3.2-2 Bug A: structured-phase quarantine + WARN logging (AM2/AM3)', () => {
  let project: Project;
  const stderrCapture: string[] = [];
  const realStderrWrite = process.stderr.write.bind(process.stderr);

  beforeEach(() => {
    project = setupFrom(MINIMAL_FIXTURE);
    writeFileSync(
      join(project.root, 'webapp', 'controller', 'Other.controller.js'),
      '// Other\n',
      'utf8',
    );
    stderrCapture.length = 0;
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderrCapture.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = realStderrWrite;
    project.cleanup();
  });

  test('refinement-time ClaudeProcessKilledError → quarantine with phase: refinement; WARN visible', async () => {
    const targetControllerAbs = join(
      project.root,
      'webapp',
      'controller',
      'Other.controller.js',
    );
    const expectedTestAbs = join(
      project.root,
      'webapp',
      'test',
      'unit',
      'controller',
      'Other.controller.qunit.js',
    );

    const runner = new FakeClaudeRunner([
      {
        match: (a) => a.prompt.includes('did not pass verification'),
        response: () => {
          throw new ClaudeProcessKilledError(
            'cid-ref-kill',
            -1,
            'argv too long',
            '/tmp/err.txt',
          );
        },
      },
      {
        match: /Task: generate a QUnit unit test file/,
        response: { raw: JSON.stringify({ newFileContent: '// INITIAL broken\n' }) },
      },
    ]);
    const verifyAdapters: VerifyAdapters = {
      ui5lint: async () => ({ ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1 }),
      eslint: async () => ({ ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1 }),
      karma: async ({ testFiles }) => {
        const targeting = testFiles?.includes(expectedTestAbs) === true;
        if (targeting && existsSync(expectedTestAbs)) {
          return {
            ok: false,
            stdout: 'karma: assertion mismatch',
            stderr: '',
            exitCode: 1,
            durationMs: 1,
            testFiles: testFiles ?? [],
          };
        }
        return {
          ok: true,
          stdout: '',
          stderr: '',
          exitCode: 0,
          durationMs: 1,
          testFiles: testFiles ?? [],
        };
      },
    };

    const sink: string[] = [];
    const result = await runGenerate({
      projectRoot: project.root,
      path: targetControllerAbs,
      force: true,
      qunitOnly: true,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters,
      outputStream: memWritable(sink),
    });

    expect(result.report.generatedTests).toHaveLength(1);
    const entry = result.report.generatedTests[0] as
      | (ReportGeneratedTest & { quarantineReason?: { phase?: string; message?: string } })
      | undefined;
    expect(entry).toBeDefined();
    expect(entry?.status).toBe('quarantined');
    // V1.3.2-3 attaches structured phase to the quarantine reason (AM2).
    expect(entry?.quarantineReason?.phase).toBe('refinement');

    // V1.3.2-3 emits a loud WARN on the refinement kill arm (AM3).
    const stderrText = stderrCapture.join('');
    const combinedStreams = sink.join('') + stderrText;
    expect(combinedStreams).toContain('[WARN] refinement subprocess killed');
  });

  test('initial-call ClaudeProcessKilledError → reason carries phase: initial; WARN visible', async () => {
    const targetControllerAbs = join(
      project.root,
      'webapp',
      'controller',
      'Other.controller.js',
    );

    const runner = new FakeClaudeRunner([
      {
        match: /Task: generate a QUnit unit test file/,
        response: () => {
          throw new ClaudeProcessKilledError(
            'cid-init-kill',
            -1,
            'argv too long',
            '/tmp/err.txt',
          );
        },
      },
    ]);

    const sink: string[] = [];
    const result = await runGenerate({
      projectRoot: project.root,
      path: targetControllerAbs,
      force: true,
      qunitOnly: true,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adaptersOk(),
      outputStream: memWritable(sink),
    });

    expect(result.report.generatedTests).toHaveLength(1);
    const entry = result.report.generatedTests[0] as
      | (ReportGeneratedTest & { quarantineReason?: { phase?: string; message?: string } })
      | undefined;
    expect(entry).toBeDefined();
    // V1.3.2-3 attaches the structured phase regardless of whether the
    // initial-kill arm continues to surface as `no-output` or migrates to
    // `quarantined` — what matters is the `phase` is correctly classified.
    expect(entry?.quarantineReason?.phase).toBe('initial');

    // V1.3.2-3 emits a loud WARN on the initial kill arm too (AM3).
    const stderrText = stderrCapture.join('');
    const combinedStreams = sink.join('') + stderrText;
    expect(combinedStreams).toContain('[WARN] initial subprocess killed');
  });
});

describe('runGenerate — V1.3.2-2 Bug B: sinon-dialect-aware prompt content (AH4)', () => {
  let project: Project;

  beforeEach(() => {
    project = setupFrom(MINIMAL_FIXTURE);
    writeFileSync(
      join(project.root, 'webapp', 'controller', 'Other.controller.js'),
      '// Other\n',
      'utf8',
    );
  });

  afterEach(() => {
    project.cleanup();
  });

  test('cap_try-shape (existing .qunit.js references bundled sinon): initial AND refinement prompts carry the sinon clause', async () => {
    // Cap_try shape: no `sinon` in package.json; an existing .qunit.js in
    // the QUnit test root references `sap/ui/thirdparty/sinon` from a
    // sap.ui.define([...]) array; testsuite.qunit.html has no bundled-sinon
    // reference. V1.3.2-4's AC1 signal 2 fires → 'sap-bundled'.
    writeFileSync(
      join(project.root, 'webapp', 'test', 'unit', 'controller', 'Main.controller.qunit.js'),
      [
        'sap.ui.define([',
        '  "sap/ui/thirdparty/sinon",',
        '  "sap/ui/thirdparty/sinon-qunit",',
        '  "minimal/project/controller/Main.controller"',
        '], function () {',
        '  "use strict";',
        '  QUnit.module("Main");',
        '});',
        '',
      ].join('\n'),
      'utf8',
    );

    const targetControllerAbs = join(
      project.root,
      'webapp',
      'controller',
      'Other.controller.js',
    );
    const expectedTestAbs = join(
      project.root,
      'webapp',
      'test',
      'unit',
      'controller',
      'Other.controller.qunit.js',
    );

    const runner = new FakeClaudeRunner([
      {
        match: (a) => a.prompt.includes('did not pass verification'),
        response: { raw: JSON.stringify({ newFileContent: '// refined\n' }) },
      },
      {
        match: /Task: generate a QUnit unit test file/,
        response: { raw: JSON.stringify({ newFileContent: '// initial\n' }) },
      },
    ]);

    const verifyAdapters: VerifyAdapters = {
      ui5lint: async () => ({ ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1 }),
      eslint: async () => ({ ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1 }),
      karma: async ({ testFiles }) => {
        const targeting = testFiles?.includes(expectedTestAbs) === true;
        if (targeting && existsSync(expectedTestAbs)) {
          return {
            ok: false,
            stdout: 'karma: assertion mismatch',
            stderr: '',
            exitCode: 1,
            durationMs: 1,
            testFiles: testFiles ?? [],
          };
        }
        return {
          ok: true,
          stdout: '',
          stderr: '',
          exitCode: 0,
          durationMs: 1,
          testFiles: testFiles ?? [],
        };
      },
    };

    await runGenerate({
      projectRoot: project.root,
      path: targetControllerAbs,
      force: true,
      qunitOnly: true,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters,
      outputStream: memWritable([]),
    });

    const initialCall = runner.calls.find((c) =>
      /Task: generate a QUnit unit test file/.test(c.prompt),
    );
    const refinementCall = runner.calls.find((c) =>
      c.prompt.includes('did not pass verification'),
    );
    expect(initialCall).toBeDefined();
    expect(refinementCall).toBeDefined();
    if (initialCall === undefined || refinementCall === undefined) return;

    // V1.3.2-4 appends SAP_BUNDLED_SINON_CLAUSE to both prompts on
    // sap-bundled. Pin the load-bearing tokens (the API names that
    // burned cap_try) so a typo in the clause is caught here too.
    expect(initialCall.prompt).toContain('sap/ui/thirdparty/sinon');
    expect(initialCall.prompt).toContain('callsFake');
    expect(refinementCall.prompt).toContain('sap/ui/thirdparty/sinon');
    expect(refinementCall.prompt).toContain('callsFake');
  });

  test('testsuite.qunit.html references bundled sinon → initial prompt carries the clause', async () => {
    writeFileSync(
      join(project.root, 'webapp', 'test', 'testsuite.qunit.html'),
      [
        '<!DOCTYPE html>',
        '<html><head>',
        '  <title>QUnit test suite for minimal.project</title>',
        '  <script src="../../resources/sap/ui/thirdparty/sinon.js"></script>',
        '  <script src="../../resources/sap/ui/thirdparty/sinon-qunit.js"></script>',
        '</head><body></body></html>',
        '',
      ].join('\n'),
      'utf8',
    );

    const targetControllerAbs = join(
      project.root,
      'webapp',
      'controller',
      'Other.controller.js',
    );
    const runner = new FakeClaudeRunner([
      {
        match: /Task: generate a QUnit unit test file/,
        response: { raw: JSON.stringify({ newFileContent: '// passing\n' }) },
      },
    ]);

    await runGenerate({
      projectRoot: project.root,
      path: targetControllerAbs,
      force: true,
      qunitOnly: true,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adaptersOk(),
      outputStream: memWritable([]),
    });

    const initialCall = runner.calls.find((c) =>
      /Task: generate a QUnit unit test file/.test(c.prompt),
    );
    expect(initialCall).toBeDefined();
    if (initialCall === undefined) return;

    expect(initialCall.prompt).toContain('sap/ui/thirdparty/sinon');
    expect(initialCall.prompt).toContain('callsFake');
  });

  test('no sinon signals → initial prompt has no sinon-clause content', async () => {
    // Strip karma.conf.js + karma-ui5 from package.json so the V1.3.2-4
    // AC1 signal 4 (karma-ui5 default) does not fire either. No qunit
    // file references bundled sinon; no testsuite.html reference;
    // dialect resolves to 'unknown' → no clause appended.
    rmSync(join(project.root, 'karma.conf.js'), { force: true });
    const pkgPath = join(project.root, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      devDependencies?: Record<string, string>;
    };
    if (pkg.devDependencies !== undefined) {
      delete pkg.devDependencies['karma-ui5'];
    }
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), 'utf8');

    const targetControllerAbs = join(
      project.root,
      'webapp',
      'controller',
      'Other.controller.js',
    );
    const runner = new FakeClaudeRunner([
      {
        match: /Task: generate a QUnit unit test file/,
        response: { raw: JSON.stringify({ newFileContent: '// passing\n' }) },
      },
    ]);

    await runGenerate({
      projectRoot: project.root,
      path: targetControllerAbs,
      force: true,
      qunitOnly: true,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adaptersOk(),
      outputStream: memWritable([]),
    });

    const initialCall = runner.calls.find((c) =>
      /Task: generate a QUnit unit test file/.test(c.prompt),
    );
    expect(initialCall).toBeDefined();
    if (initialCall === undefined) return;

    // No sinon clause appended — positive negative-content check (per the
    // plan's "rather than a brittle byte-for-byte pin" guidance).
    expect(initialCall.prompt).not.toContain('callsFake');
    expect(initialCall.prompt).not.toContain('sinon.sandbox.create');
  });
});

// =====================================================================
// V1.3.3-3 witnesses — Bug A (prose-preamble JSON recovery) and Bug B
// (karma module-load classification). Bug A wires a real BinaryRunner
// with a stubbed exec so the envelope-recovery path is exercised at the
// integration layer (FakeClaudeRunner short-circuits interpretEnvelope
// and is not a faithful witness for this bug). Bug B drives the verify
// adapter with a Reports-shape karma stdout; the witness asserts the
// V1.3.3-5 per-test short-circuit shape (phase: 'module-load', message
// containing the module ID + suggested lib + karma-config hint).
// =====================================================================

function makeFakeExec(responses: readonly Partial<ExecResult>[]): {
  exec: (file: string, args?: readonly string[], opts?: { cwd?: string }) => Promise<ExecResult>;
} {
  let i = 0;
  const exec = async (): Promise<ExecResult> => {
    const r = responses[i] ?? {};
    i += 1;
    return {
      ok: r.ok ?? true,
      stdout: r.stdout ?? '',
      stderr: r.stderr ?? '',
      exitCode: r.exitCode ?? 0,
      durationMs: r.durationMs ?? 1,
    };
  };
  return { exec };
}

function successEnvelope(innerResult: string): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    api_error_status: null,
    result: innerResult,
    session_id: 'sess-test',
    total_cost_usd: 0,
    uuid: 'uuid-test',
  });
}

describe('runGenerate — V1.3.3-3 Bug A: prose-preamble recovery via real BinaryRunner', () => {
  let project: Project;
  const stderrCapture: string[] = [];
  const realStderrWrite = process.stderr.write.bind(process.stderr);

  beforeEach(() => {
    project = setupFrom(MINIMAL_FIXTURE);
    writeFileSync(
      join(project.root, 'webapp', 'controller', 'Other.controller.js'),
      '// Other\n',
      'utf8',
    );
    stderrCapture.length = 0;
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderrCapture.push(
        typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'),
      );
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = realStderrWrite;
    project.cleanup();
  });

  test('(Bug A) cap_try-Shop-shape envelope on first call → candidate succeeds, no quarantine, WARN line', async () => {
    // The load-bearing case: envelope outer is well-formed, but
    // envelope.result wraps the JSON body in prose. V1.3.3-4 recovers
    // on the first attempt; today the V1.3.3-3 stub returns the
    // parse-failure sentinel, the retry fires, and the second attempt
    // gets the same shape → MalformedLlmOutputError → status='no-output'.
    const targetControllerAbs = join(
      project.root,
      'webapp',
      'controller',
      'Other.controller.js',
    );
    const passingTest =
      'sap.ui.define([],function(){"use strict";QUnit.module("ok");});\n';
    const proseShape =
      'The issue: controller module id mismatch (Other vs Other.controller).\n\n' +
      JSON.stringify({ newFileContent: passingTest });
    const errorDir = mkdtempSync(join(tmpdir(), 'v1331-buga-err-'));
    const { exec } = makeFakeExec([
      // Single exec call expected; if recovery doesn't fire we see a
      // second identical attempt (still the prose shape).
      { ok: true, exitCode: 0, stdout: successEnvelope(proseShape) },
      { ok: true, exitCode: 0, stdout: successEnvelope(proseShape) },
    ]);
    const runner = new BinaryRunner({
      errorOutputDir: errorDir,
      execImpl: exec,
      callIdFactory: () => 'preamble-int',
    });

    const result = await runGenerate({
      projectRoot: project.root,
      path: targetControllerAbs,
      force: true,
      qunitOnly: true,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adaptersOk(),
      outputStream: memWritable([]),
    });

    rmSync(errorDir, { recursive: true, force: true });

    // V1.3.3-4: recovery succeeds → candidate passes verification.
    expect(result.report.generatedTests).toHaveLength(1);
    const entry = result.report.generatedTests[0]!;
    expect(entry.status).toBe('passed');
    // Recovery is observable: the WARN line is on stderr.
    expect(stderrCapture.join('')).toContain(
      '[WARN] LLM emitted prose preamble',
    );
    // No quarantineReason on a passing entry.
    expect(
      (entry as ReportGeneratedTest & { quarantineReason?: unknown }).quarantineReason,
    ).toBeUndefined();
  });

  test('(Bug A) audit-invariant: an unrecoverable preamble preserves the raw stdout byte-for-byte in llm-error-*.txt', async () => {
    // When recovery genuinely cannot fire (pure prose, no JSON shape
    // at all), the existing one-shot reformat retry path is unchanged
    // and the audit dump under .sapui5-validator/last-run/ keeps the
    // raw second-attempt stdout. This positive witness pins the
    // load-bearing invariant from V1.3.3-PLAN.md scope §3.
    const targetControllerAbs = join(
      project.root,
      'webapp',
      'controller',
      'Other.controller.js',
    );
    const irrecoverableProse =
      'I am sorry; I could not produce a JSON value for this controller.';
    const errorDir = mkdtempSync(join(tmpdir(), 'v1331-buga-audit-'));
    const { exec } = makeFakeExec([
      { ok: true, exitCode: 0, stdout: successEnvelope(irrecoverableProse) },
      { ok: true, exitCode: 0, stdout: successEnvelope(irrecoverableProse) },
    ]);
    const runner = new BinaryRunner({
      errorOutputDir: errorDir,
      execImpl: exec,
      callIdFactory: () => 'audit-bugA',
    });

    await runGenerate({
      projectRoot: project.root,
      path: targetControllerAbs,
      force: true,
      qunitOnly: true,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adaptersOk(),
      outputStream: memWritable([]),
    });

    // The MalformedLlmOutputError write path persists the raw stdout
    // byte-for-byte. The dump's location is the runner's errorOutputDir
    // (here the tmpdir we created), independent of any preamble
    // recovery work.
    const dumpPath = join(errorDir, 'llm-error-audit-bugA.txt');
    const dumpContent = readFileSync(dumpPath, 'utf8');
    // Byte-for-byte preservation: both raw stdouts present verbatim.
    expect(dumpContent).toContain(successEnvelope(irrecoverableProse));
    // Sanity: this is the malformed-output (not killed / api-error) dump.
    expect(dumpContent).toContain('--- Attempt 2 (reformat retry) ---');

    rmSync(errorDir, { recursive: true, force: true });

    // Sanity: MalformedLlmOutputError is the contract this path throws.
    // (Asserted via the dump's presence; this expression keeps the import
    // referenced after the V1.3.3-3 commit and signals intent.)
    expect(MalformedLlmOutputError.name).toBe('MalformedLlmOutputError');
  });
});

describe('runGenerate — V1.4-6 karma module-load four-case quarantine (Bug B carry-forward)', () => {
  let project: Project;
  const stderrCapture: string[] = [];
  const realStderrWrite = process.stderr.write.bind(process.stderr);

  beforeEach(() => {
    project = setupFrom(MINIMAL_FIXTURE);
    writeFileSync(
      join(project.root, 'webapp', 'controller', 'Other.controller.js'),
      '// Other\n',
      'utf8',
    );
    stderrCapture.length = 0;
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderrCapture.push(
        typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'),
      );
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = realStderrWrite;
    project.cleanup();
  });

  function buildReportsShapeAdapters(stdout: string): {
    readonly adapters: VerifyAdapters;
    readonly expectedTestAbs: string;
  } {
    const expectedTestAbs = join(
      project.root,
      'webapp',
      'test',
      'unit',
      'controller',
      'Other.controller.qunit.js',
    );
    const adapters: VerifyAdapters = {
      ui5lint: async () => ({ ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1 }),
      eslint: async () => ({ ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1 }),
      karma: async ({ testFiles }) => {
        const targeting = testFiles?.includes(expectedTestAbs) === true;
        if (targeting && existsSync(expectedTestAbs)) {
          return {
            ok: false,
            stdout,
            stderr: '',
            exitCode: 1,
            durationMs: 1,
            testFiles: testFiles ?? [],
          };
        }
        return {
          ok: true,
          stdout: '',
          stderr: '',
          exitCode: 0,
          durationMs: 1,
          testFiles: testFiles ?? [],
        };
      },
    };
    return { adapters, expectedTestAbs };
  }

  test('(V1.4-6 Case A) Reports-shape karma stdout, lib NOT in manifest, no client.libs → quarantine on FIRST attempt, message recommends --auto-apply-baseline-fixes + names manifest entry', async () => {
    const targetControllerAbs = join(
      project.root,
      'webapp',
      'controller',
      'Other.controller.js',
    );
    const reportsStdout =
      'failed to load JavaScript resource: sap/ui/export/Spreadsheet.js -  ' +
      'sap.ui.ModuleSystem\n' +
      'WARN [Chrome Headless 131.0.0.0 (Windows 10)]: Disconnected, ' +
      'because no message in 30000 ms.\n';
    const { adapters } = buildReportsShapeAdapters(reportsStdout);
    let initial = 0;
    let refine = 0;
    const runner = new FakeClaudeRunner([
      {
        match: (a) => a.prompt.includes('did not pass verification'),
        response: () => {
          refine += 1;
          return { raw: JSON.stringify({ newFileContent: `// refined ${refine}\n` }) };
        },
      },
      {
        match: /Task: generate a QUnit unit test file/,
        response: () => {
          initial += 1;
          return { raw: JSON.stringify({ newFileContent: '// initial\n' }) };
        },
      },
    ]);

    const result = await runGenerate({
      projectRoot: project.root,
      path: targetControllerAbs,
      force: true,
      qunitOnly: true,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adapters,
      outputStream: memWritable([]),
    });

    expect(result.report.generatedTests).toHaveLength(1);
    const entry = result.report.generatedTests[0] as
      | (ReportGeneratedTest & {
          quarantineReason?: { phase?: string; message?: string };
        })
      | undefined;
    expect(entry).toBeDefined();
    expect(entry?.status).toBe('quarantined');
    // V1.3.3-5: per-test short-circuit on the FIRST occurrence — no
    // refinement is attempted because the LLM cannot fix a project
    // karma-config gap from the test-file side.
    expect(entry?.quarantineReason?.phase).toBe('module-load');
    expect(initial).toBe(1);
    expect(refine).toBe(0);
    // V1.4-6 Case A: the minimal-project fixture's manifest declares
    // only sap.m + sap.ui.core; sap.ui.export is NOT in manifestLibs
    // AND NOT in karmaClientLibs, so the message points at the
    // manifest (not the karma config) and recommends the
    // baseline-auto-fix flag.
    const msg = entry?.quarantineReason?.message ?? '';
    expect(msg).toContain('sap/ui/export/Spreadsheet');
    expect(msg).toContain('sap.ui.export');
    expect(msg).toContain('webapp/manifest.json');
    expect(msg).toContain('--auto-apply-baseline-fixes');
    expect(msg).toContain('sap.ui5.dependencies.libs');
  });

  test('(V1.4-6 Case A lib-null) Reports-shape with module but underivable lib (1-segment) → message names module + manifest-recommend wording, no suggested-lib clause', async () => {
    // libNameFor returns null for a 1-segment module ID (V1.3.3-5
    // AH4). V1.4-6's Case A lib-null branch keeps the manifest-fix
    // recommendation but acknowledges the parent library cannot be
    // derived from the module ID alone.
    const targetControllerAbs = join(
      project.root,
      'webapp',
      'controller',
      'Other.controller.js',
    );
    const reportsStdout =
      'failed to load JavaScript resource: Foo.js - sap.ui.ModuleSystem\n' +
      'WARN [Chrome]: Disconnected, because no message in 30000 ms.\n';
    const { adapters } = buildReportsShapeAdapters(reportsStdout);
    const runner = new FakeClaudeRunner([
      {
        match: /Task: generate a QUnit unit test file/,
        response: { raw: JSON.stringify({ newFileContent: '// initial\n' }) },
      },
    ]);
    const result = await runGenerate({
      projectRoot: project.root,
      path: targetControllerAbs,
      force: true,
      qunitOnly: true,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adapters,
      outputStream: memWritable([]),
    });
    const entry = result.report.generatedTests[0] as
      | (ReportGeneratedTest & {
          quarantineReason?: { phase?: string; message?: string };
        })
      | undefined;
    expect(entry?.quarantineReason?.phase).toBe('module-load');
    const msg = entry?.quarantineReason?.message ?? '';
    expect(msg).toContain('Foo');
    // V1.4-6 Case A lib-null wording: parent library underivable;
    // recommends adding to manifest + re-running with the flag.
    expect(msg).toContain('parent library');
    expect(msg).toContain('webapp/manifest.json');
    expect(msg).toContain('--auto-apply-baseline-fixes');
  });

  test('(R2.1a) disconnect-only karma output (no ModuleSystem line) → NOT a module-load quarantine; the candidate gets its refinement chance', async () => {
    // Pre-R2.1(a) this exact transcript short-circuited to a `module-load`
    // quarantine on the FIRST verify (the V1.4-6 Case D path) with a
    // message asserting refinement was futile — the live AUDIT §3.1
    // failure mode. A disconnect alone is ambiguous (hung test OR env
    // blip), so the candidate must now classify `test-failure` and burn
    // its refinements before quarantining via the ordinary path.
    const targetControllerAbs = join(
      project.root,
      'webapp',
      'controller',
      'Other.controller.js',
    );
    const reportsStdout =
      'WARN [Chrome Headless]: Disconnected, because no message in 30000 ms.\n';
    const { adapters } = buildReportsShapeAdapters(reportsStdout);
    let refine = 0;
    const runner = new FakeClaudeRunner([
      {
        match: (a) => a.prompt.includes('did not pass verification'),
        response: () => {
          refine += 1;
          return { raw: JSON.stringify({ newFileContent: `// refined ${refine}\n` }) };
        },
      },
      {
        match: /Task: generate a QUnit unit test file/,
        response: { raw: JSON.stringify({ newFileContent: '// initial\n' }) },
      },
    ]);
    const result = await runGenerate({
      projectRoot: project.root,
      path: targetControllerAbs,
      force: true,
      qunitOnly: true,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adapters,
      outputStream: memWritable([]),
    });
    const entry = result.report.generatedTests[0] as
      | (ReportGeneratedTest & {
          quarantineReason?: { phase?: string; message?: string };
        })
      | undefined;
    // Karma keeps failing, so the candidate still ends quarantined — but
    // through the refinement path after using its attempts, NOT the
    // module-load short-circuit.
    expect(entry?.status).toBe('quarantined');
    expect(entry?.quarantineReason?.phase).toBe('refinement');
    // The refinement chance R2.1(a) restores: at least one refinement call
    // happened (pre-fix: zero — quarantined on first occurrence).
    expect(refine).toBeGreaterThan(0);
  });

  test('(V1.4-6 Case B) Reports-shape karma stdout, lib IS in manifest, no client.libs → CDN-coverage hint + pre-registered stub fallback wording', async () => {
    // V1.4-6 Case B fires when the manifest already declares the
    // failing library but karma-ui5 still could not preload it (most
    // commonly a CDN coverage gap). Patch the minimal-project manifest
    // in-place to declare `sap.ui.export` so the graph reports the lib
    // as in `manifestLibs`; the message then routes through Case B.
    const manifestAbs = join(project.root, 'webapp', 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestAbs, 'utf8'));
    manifest['sap.ui5'].dependencies.libs['sap.ui.export'] = {};
    writeFileSync(manifestAbs, JSON.stringify(manifest, null, 2), 'utf8');

    const targetControllerAbs = join(
      project.root,
      'webapp',
      'controller',
      'Other.controller.js',
    );
    const reportsStdout =
      'failed to load JavaScript resource: sap/ui/export/Spreadsheet.js -  ' +
      'sap.ui.ModuleSystem\n' +
      'WARN [Chrome Headless 131.0.0.0 (Windows 10)]: Disconnected, ' +
      'because no message in 30000 ms.\n';
    const { adapters } = buildReportsShapeAdapters(reportsStdout);
    const runner = new FakeClaudeRunner([
      {
        match: /Task: generate a QUnit unit test file/,
        response: { raw: JSON.stringify({ newFileContent: '// initial\n' }) },
      },
    ]);
    const result = await runGenerate({
      projectRoot: project.root,
      path: targetControllerAbs,
      force: true,
      qunitOnly: true,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adapters,
      outputStream: memWritable([]),
    });
    const entry = result.report.generatedTests[0] as
      | (ReportGeneratedTest & {
          quarantineReason?: { phase?: string; message?: string };
        })
      | undefined;
    expect(entry?.quarantineReason?.phase).toBe('module-load');
    const msg = entry?.quarantineReason?.message ?? '';
    // Case B-specific wording: acknowledges the manifest declaration
    // and routes the user to the CDN URL + pre-registered stub
    // strategy, NOT the --auto-apply-baseline-fixes flag.
    expect(msg).toContain('sap/ui/export/Spreadsheet');
    expect(msg).toContain('sap.ui.export');
    expect(msg).toContain('IS declared in webapp/manifest.json');
    expect(msg).toContain('CDN');
    expect(msg).toContain('ui5.url');
    expect(msg).toContain('sap.ui.define');
    expect(msg).not.toContain('--auto-apply-baseline-fixes');
  });

  test('(V1.4-6 audit-invariant) raw karma stdout preserved byte-for-byte under last-run/verify/', async () => {
    // V1.3.3-5's actionable-hint construction must NOT leak into the
    // audit-write path: the on-disk dump at
    // `.sapui5-validator/last-run/verify/<callId>-karma.txt` carries
    // the synthetic karma stdout/stderr exactly as the karma adapter
    // returned them. Mirrors the V1.3.2-3 AM4 prompt-vs-audit
    // asymmetry — green today, MUST stay green through V1.3.3-5.
    const targetControllerAbs = join(
      project.root,
      'webapp',
      'controller',
      'Other.controller.js',
    );
    const reportsStdout =
      'failed to load JavaScript resource: sap/ui/export/Spreadsheet.js -  ' +
      'sap.ui.ModuleSystem\n' +
      'WARN [Chrome Headless 131.0.0.0]: Disconnected, ' +
      'because no message in 30000 ms.\n';
    const { adapters } = buildReportsShapeAdapters(reportsStdout);
    const runner = new FakeClaudeRunner([
      {
        match: (a) => a.prompt.includes('did not pass verification'),
        response: { raw: JSON.stringify({ newFileContent: '// refined\n' }) },
      },
      {
        match: /Task: generate a QUnit unit test file/,
        response: { raw: JSON.stringify({ newFileContent: '// initial\n' }) },
      },
    ]);
    await runGenerate({
      projectRoot: project.root,
      path: targetControllerAbs,
      force: true,
      qunitOnly: true,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adapters,
      outputStream: memWritable([]),
    });

    const verifyDir = join(project.root, '.sapui5-validator', 'last-run', 'verify');
    const karmaDumps = readdirSync(verifyDir).filter((f) => f.endsWith('-karma.txt'));
    expect(karmaDumps.length).toBeGreaterThan(0);
    // At least one dump carries the synthetic karma stdout verbatim.
    const dumpsContainingRaw = karmaDumps.filter((f) => {
      const content = readFileSync(join(verifyDir, f), 'utf8');
      return content.includes(reportsStdout);
    });
    expect(dumpsContainingRaw.length).toBeGreaterThan(0);
  });
});

describe('runGenerate — V1.4-5: prompt-context block + post-patch graph rebuild', () => {
  let project: Project;

  beforeEach(() => {
    project = setupFrom(MINIMAL_FIXTURE);
    // Seed a controller that imports an unpreloaded library
    // (`sap.ui.export`, the cap_try-shape gap). The minimal fixture's
    // manifest declares only `sap.m` + `sap.ui.core`, so V1.4-4's
    // baseline check fires on this controller.
    writeFileSync(
      join(project.root, 'webapp', 'controller', 'Other.controller.js'),
      [
        'sap.ui.define([',
        '  "sap/ui/core/mvc/Controller",',
        '  "sap/ui/export/Spreadsheet"',
        '], function (Controller) {',
        '  "use strict";',
        '  return Controller.extend("minimal.project.controller.Other", {',
        '    onInit: function () {}',
        '  });',
        '});',
        '',
      ].join('\n'),
      'utf8',
    );
  });

  afterEach(() => {
    project.cleanup();
  });

  test('(V1.4-7 criterion c) --auto-apply-baseline-fixes patches manifest; graph is rebuilt so the QUnit prompt has NO stale context block', async () => {
    const targetControllerAbs = join(
      project.root,
      'webapp',
      'controller',
      'Other.controller.js',
    );
    const runner = new FakeClaudeRunner([
      {
        match: /Task: generate a QUnit unit test file/,
        response: { raw: JSON.stringify({ newFileContent: '// passing test\n' }) },
      },
    ]);

    const result = await runGenerate({
      projectRoot: project.root,
      path: targetControllerAbs,
      force: true,
      qunitOnly: true,
      autoApplyBaselineFixes: true,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      // V1.4-10 — pin the CDN probe to "served" so this stays the
      // manifest-fixable path (offline + deterministic).
      probeLib: async () => true,
      verifyAdapters: adaptersOk(),
      outputStream: memWritable([]),
    });

    // The manifest was patched: `sap.ui.export` now appears in the
    // declared libs.
    const patchedManifest = JSON.parse(
      readFileSync(join(project.root, 'webapp', 'manifest.json'), 'utf8'),
    );
    expect(
      Object.keys(patchedManifest['sap.ui5'].dependencies.libs),
    ).toContain('sap.ui.export');

    // The baseline finding was recorded as applied.
    const manifestEntry = result.report.files.find(
      (f) => f.file === 'webapp/manifest.json',
    );
    expect(manifestEntry?.appliedFixes.some(
      (a) => a.checkId === 'baseline-unpreloaded-libs',
    )).toBe(true);

    // The QUnit generation prompt was issued AFTER the graph rebuild,
    // so the project-context block is ABSENT — the gap is now empty.
    // This is the load-bearing V1.4-7(c) check.
    const initialCall = runner.calls.find((c) =>
      /Task: generate a QUnit unit test file/.test(c.prompt),
    );
    expect(initialCall).toBeDefined();
    expect(initialCall?.prompt).not.toContain('Project library context');
    expect(initialCall?.prompt).not.toContain('Pre-registered stub strategy');

    // The generated test was accepted as passing.
    const entry = result.report.generatedTests.find(
      (g) => g.sourceFile === 'webapp/controller/Other.controller.js',
    );
    expect(entry?.status).toBe('passed');
  });

  test('without --auto-apply-baseline-fixes: affected controller is pre-flight-skipped (no LLM call burned)', async () => {
    // V1.4-4 contract: when the user declines the auto-fix, the
    // affected controller is skipped rather than going through
    // generation. The V1.4-5 prompt-context block is therefore inert
    // in this default V1.4 path — it exists as forward-looking
    // infrastructure for V1.5+ when the skip behaviour may relax.
    const targetControllerAbs = join(
      project.root,
      'webapp',
      'controller',
      'Other.controller.js',
    );
    const runner = new FakeClaudeRunner([
      {
        match: /Task: generate a QUnit unit test file/,
        response: { raw: JSON.stringify({ newFileContent: '// should not be called\n' }) },
      },
    ]);

    const result = await runGenerate({
      projectRoot: project.root,
      path: targetControllerAbs,
      force: true,
      qunitOnly: true,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      // V1.4-10 — CDN serves the lib, so this is the manifest-fixable
      // (skip-when-declined) path.
      probeLib: async () => true,
      verifyAdapters: adaptersOk(),
      outputStream: memWritable([]),
    });

    // No LLM call for the affected controller.
    const initialCall = runner.calls.find((c) =>
      /Task: generate a QUnit unit test file/.test(c.prompt),
    );
    expect(initialCall).toBeUndefined();

    // Affected controller surfaces as skipped-baseline.
    const entry = result.report.generatedTests.find(
      (g) => g.sourceFile === 'webapp/controller/Other.controller.js',
    );
    expect(entry?.status).toBe('skipped-baseline');
  });
});

describe('runGenerate — V1.4-10: stub-only gap (lib 404s on the karma CDN)', () => {
  let project: Project;

  beforeEach(() => {
    project = setupFrom(MINIMAL_FIXTURE);
    // Same cap_try-shape seed as the V1.4-5 block, but the probe will
    // report the lib as NOT served by the karma CDN — the SAPUI5-only
    // sap.ui.export on an OpenUI5 ui5.url.
    writeFileSync(
      join(project.root, 'webapp', 'controller', 'Other.controller.js'),
      [
        'sap.ui.define([',
        '  "sap/ui/core/mvc/Controller",',
        '  "sap/ui/export/Spreadsheet"',
        '], function (Controller) {',
        '  "use strict";',
        '  return Controller.extend("minimal.project.controller.Other", {',
        '    onInit: function () {}',
        '  });',
        '});',
        '',
      ].join('\n'),
      'utf8',
    );
  });

  afterEach(() => {
    project.cleanup();
  });

  test('--auto-apply-baseline-fixes does NOT add a CDN-absent lib to the manifest; the controller still generates with a prompt-context stub block', async () => {
    const targetControllerAbs = join(
      project.root,
      'webapp',
      'controller',
      'Other.controller.js',
    );
    const runner = new FakeClaudeRunner([
      {
        match: /Task: generate a QUnit unit test file/,
        response: { raw: JSON.stringify({ newFileContent: '// passing test\n' }) },
      },
    ]);

    const result = await runGenerate({
      projectRoot: project.root,
      path: targetControllerAbs,
      force: true,
      qunitOnly: true,
      autoApplyBaselineFixes: true,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      // The lib 404s on the configured karma CDN → stub-only gap.
      probeLib: async () => false,
      verifyAdapters: adaptersOk(),
      outputStream: memWritable([]),
    });

    // The manifest was NOT patched: declaring a CDN-absent lib would not
    // help (karma would hang preloading it).
    const manifest = JSON.parse(
      readFileSync(join(project.root, 'webapp', 'manifest.json'), 'utf8'),
    );
    expect(
      Object.keys(manifest['sap.ui5'].dependencies.libs),
    ).not.toContain('sap.ui.export');

    // The finding is surfaced as manual-only (no auto-fix applied) and
    // explains the CDN gap.
    const manifestEntry = result.report.files.find(
      (f) => f.file === 'webapp/manifest.json',
    );
    expect(manifestEntry?.appliedFixes).toEqual([]);
    const finding = manifestEntry?.findings.find(
      (f) => f.checkId === 'baseline-unpreloaded-libs',
    );
    expect(finding?.proposedFix).toBeNull();
    const explanation = finding && finding.proposedFix === null ? finding.explanation : '';
    expect(explanation).toContain('not served by the karma test CDN');

    // The controller was NOT skipped — it generated with the
    // pre-registered-stub prompt-context block.
    const initialCall = runner.calls.find((c) =>
      /Task: generate a QUnit unit test file/.test(c.prompt),
    );
    expect(initialCall).toBeDefined();
    expect(initialCall?.prompt).toContain('Pre-registered stub strategy');

    const entry = result.report.generatedTests.find(
      (g) => g.sourceFile === 'webapp/controller/Other.controller.js',
    );
    expect(entry?.status).toBe('passed');
  });

  test('without the flag, a stub-only gap does NOT pre-flight-skip the controller (manifest fix would not help)', async () => {
    const targetControllerAbs = join(
      project.root,
      'webapp',
      'controller',
      'Other.controller.js',
    );
    const runner = new FakeClaudeRunner([
      {
        match: /Task: generate a QUnit unit test file/,
        response: { raw: JSON.stringify({ newFileContent: '// passing test\n' }) },
      },
    ]);

    const result = await runGenerate({
      projectRoot: project.root,
      path: targetControllerAbs,
      force: true,
      qunitOnly: true,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      probeLib: async () => false,
      verifyAdapters: adaptersOk(),
      outputStream: memWritable([]),
    });

    const entry = result.report.generatedTests.find(
      (g) => g.sourceFile === 'webapp/controller/Other.controller.js',
    );
    // NOT skipped-baseline — the stub path lets generation proceed.
    expect(entry?.status).toBe('passed');
  });
});

// =====================================================================
// V1.6 — opt-in parallel candidate processing (`--concurrency N`).
//
// These exercise the real `runGenerate` orchestrator at concurrency 2 with a
// `testsuite-require` (lane-safe) project, proving the two load-bearing
// properties together: the worker pool OVERLAPS the slow LLM generation
// (llmPeak === 2) while the verify lane SERIALISES verification (karmaPeak ===
// 1), with deterministic candidate-order report entries and no lost test
// registration. A `glob-auto` project must fall back to serial.
// =====================================================================

/**
 * A `ClaudeRunner` that delays each call (so concurrent calls overlap in time)
 * and records the peak number of in-flight `run()`s. The pool's generation
 * calls run OUTSIDE the verify lane, so a degree-2 pool drives `llmPeak` to 2.
 */
class TrackingRunner implements ClaudeRunner {
  llmActive = 0;
  llmPeak = 0;
  private n = 0;
  constructor(private readonly delayMs = 40) {}
  async run(_args: ClaudeRunArgs): Promise<ClaudeRunResult> {
    this.llmActive += 1;
    this.llmPeak = Math.max(this.llmPeak, this.llmActive);
    await new Promise<void>((r) => setTimeout(r, this.delayMs));
    this.llmActive -= 1;
    this.n += 1;
    return {
      ok: true,
      json: {},
      raw: JSON.stringify({ newFileContent: `// generated ${this.n}\n` }),
      stderr: '',
      exitCode: 0,
      durationMs: 0,
      callId: `trk-${this.n}`,
    };
  }
}

/**
 * Verify adapters whose karma step delays and records its peak in-flight count.
 * Because the verify lane wraps the whole register→verify section, two
 * candidates' karma steps can never overlap → `karmaPeak` stays 1 even at
 * concurrency 2. (ui5lint/eslint are instant green stubs.)
 */
function trackingKarmaAdapters(): {
  readonly adapters: VerifyAdapters;
  readonly state: { karmaActive: number; karmaPeak: number };
} {
  const state = { karmaActive: 0, karmaPeak: 0 };
  return {
    state,
    adapters: {
      ui5lint: async () => ({ ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1 }),
      eslint: async () => ({ ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1 }),
      karma: async ({ testFiles }) => {
        state.karmaActive += 1;
        state.karmaPeak = Math.max(state.karmaPeak, state.karmaActive);
        await new Promise<void>((r) => setTimeout(r, 40));
        state.karmaActive -= 1;
        return { ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1, testFiles: testFiles ?? [] };
      },
    },
  };
}

describe('runGenerate — V1.6 parallel candidate processing', () => {
  const MAIN_MODULE = 'minimal/project/test/unit/controller/Main.controller.qunit';
  const OTHER_MODULE = 'minimal/project/test/unit/controller/Other.controller.qunit';
  const ANOTHER_MODULE = 'minimal/project/test/unit/controller/Another.controller.qunit';
  const REQUIRE_TESTSUITE = [
    '<!DOCTYPE html>',
    '<html>',
    '<head>',
    '  <meta charset="utf-8">',
    '  <script>',
    '    QUnit.config.autostart = false;',
    '    sap.ui.require([',
    `      "${MAIN_MODULE}"`,
    '    ], function () {',
    '      QUnit.start();',
    '    });',
    '  </script>',
    '</head>',
    '<body></body>',
    '</html>',
    '',
  ].join('\n');

  /** Seed two uncovered controllers; optionally install the testsuite-require html. */
  function seed(root: string, opts: { readonly testsuiteRequire: boolean }): void {
    if (opts.testsuiteRequire) {
      writeFileSync(join(root, 'webapp', 'test', 'testsuite.qunit.html'), REQUIRE_TESTSUITE, 'utf8');
    }
    for (const name of ['Other', 'Another']) {
      writeFileSync(
        join(root, 'webapp', 'controller', `${name}.controller.js`),
        [
          'sap.ui.define(["sap/ui/core/mvc/Controller"], function (Controller) {',
          '  "use strict";',
          `  return Controller.extend("minimal.project.controller.${name}", {`,
          '    onInit: function () {}',
          '  });',
          '});',
          '',
        ].join('\n'),
        'utf8',
      );
    }
  }

  let project: Project;
  beforeEach(() => {
    project = setupFrom(MINIMAL_FIXTURE);
  });
  afterEach(() => {
    project.cleanup();
  });

  test('concurrency=2: LLM generation overlaps (peak 2), verify serialises (peak 1), both pass, registrations survive', async () => {
    seed(project.root, { testsuiteRequire: true });
    const runner = new TrackingRunner();
    const { adapters, state } = trackingKarmaAdapters();

    const result = await runGenerate({
      projectRoot: project.root,
      all: true,
      force: true,
      qunitOnly: true,
      concurrency: 2,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adapters,
      outputStream: memWritable([]),
    });

    expect(result.exitCode).toBe(0);
    expect(result.report.exitReason).toEqual({ kind: 'success' });
    // The pool overlapped the two generation calls...
    expect(runner.llmPeak).toBe(2);
    // ...but the verify lane kept their karma runs strictly apart.
    expect(state.karmaPeak).toBe(1);

    const passed = result.report.generatedTests.filter((g) => g.status === 'passed');
    expect(passed).toHaveLength(2);
    expect(passed.map((g) => g.sourceFile).sort()).toEqual([
      'webapp/controller/Another.controller.js',
      'webapp/controller/Other.controller.js',
    ]);

    // No lost update: both new modules AND the pre-existing one are registered.
    const testsuite = readFileSync(
      join(project.root, 'webapp', 'test', 'testsuite.qunit.html'),
      'utf8',
    );
    expect(testsuite).toContain(OTHER_MODULE);
    expect(testsuite).toContain(ANOTHER_MODULE);
    expect(testsuite).toContain(MAIN_MODULE);
  });

  test('report order is deterministic — concurrency 2 matches the sequential candidate order', async () => {
    // Two independent projects so each run starts from the same clean state.
    const serialProject = setupFrom(MINIMAL_FIXTURE);
    const parallelProject = setupFrom(MINIMAL_FIXTURE);
    try {
      seed(serialProject.root, { testsuiteRequire: true });
      seed(parallelProject.root, { testsuiteRequire: true });

      const serial = await runGenerate({
        projectRoot: serialProject.root,
        all: true,
        force: true,
        qunitOnly: true,
        concurrency: 1,
        runner: new TrackingRunner(0),
        probeAdapter: ALL_TOOLS_OK,
        verifyAdapters: adaptersOk(),
        outputStream: memWritable([]),
      });
      // Make the SECOND candidate finish generation first under concurrency, to
      // prove completion order does not leak into the report order.
      const parallelRunner = new (class extends TrackingRunner {
        override async run(args: ClaudeRunArgs): Promise<ClaudeRunResult> {
          const slow = args.prompt.includes('Another');
          await new Promise<void>((r) => setTimeout(r, slow ? 60 : 5));
          return super.run({ ...args });
        }
      })();
      const parallel = await runGenerate({
        projectRoot: parallelProject.root,
        all: true,
        force: true,
        qunitOnly: true,
        concurrency: 2,
        runner: parallelRunner,
        probeAdapter: ALL_TOOLS_OK,
        verifyAdapters: adaptersOk(),
        outputStream: memWritable([]),
      });

      const serialOrder = serial.report.generatedTests.map((g) => g.sourceFile);
      const parallelOrder = parallel.report.generatedTests.map((g) => g.sourceFile);
      expect(serialOrder).toHaveLength(2);
      expect(parallelOrder).toEqual(serialOrder);
    } finally {
      serialProject.cleanup();
      parallelProject.cleanup();
    }
  });

  // V1.9.7 (THR-1) — the Phase-3 exit-criteria witness: running at the CLI's
  // DEFAULT `--concurrency` (K>1 after the flip) produces results identical to an
  // explicit `--concurrency 1` run on the same fixture. The lane-safe
  // (testsuite-require) seed means the default K is NOT downgraded, so this
  // genuinely exercises the parallel pool (proven by `report.concurrency`).
  test('the CLI default --concurrency (K>1) yields results identical to --concurrency 1', async () => {
    const defaultK = cliConcurrencyDefault('generate');
    // Non-vacuous guard: if the default is ever reset to 1 this compare would
    // silently become K=1-vs-K=1 — fail loudly instead.
    expect(defaultK).toBeGreaterThan(1);

    const serialProject = setupFrom(MINIMAL_FIXTURE);
    const defaultProject = setupFrom(MINIMAL_FIXTURE);
    try {
      seed(serialProject.root, { testsuiteRequire: true });
      seed(defaultProject.root, { testsuiteRequire: true });

      const serial = await runGenerate({
        projectRoot: serialProject.root,
        all: true,
        force: true,
        qunitOnly: true,
        concurrency: 1,
        runner: new TrackingRunner(0),
        probeAdapter: ALL_TOOLS_OK,
        verifyAdapters: adaptersOk(),
        outputStream: memWritable([]),
      });
      const atDefault = await runGenerate({
        projectRoot: defaultProject.root,
        all: true,
        force: true,
        qunitOnly: true,
        concurrency: defaultK,
        runner: new TrackingRunner(0),
        probeAdapter: ALL_TOOLS_OK,
        verifyAdapters: adaptersOk(),
        outputStream: memWritable([]),
      });

      // The effective width is recorded and actually differs (the lane-safe
      // fixture is NOT downgraded, so the default run truly ran parallel).
      expect(serial.report.concurrency).toBe(1);
      expect(atDefault.report.concurrency).toBe(defaultK);

      // Identical RESULTS regardless of dispatch width: same exit code and a
      // byte-identical generatedTests array (order + content).
      expect(atDefault.exitCode).toBe(serial.exitCode);
      expect(atDefault.report.generatedTests).toEqual(serial.report.generatedTests);
      // Non-vacuous: two candidates were actually generated on each run.
      expect(serial.report.generatedTests).toHaveLength(2);
    } finally {
      serialProject.cleanup();
      defaultProject.cleanup();
    }
  });

  test('a terminal budget signal still stops the run under concurrency', async () => {
    seed(project.root, { testsuiteRequire: true });
    const runner = new FakeClaudeRunner([
      {
        match: /Task: generate a QUnit unit test file/,
        response: { raw: JSON.stringify({ newFileContent: '// passing\n' }) },
      },
    ]);
    const result = await runGenerate({
      projectRoot: project.root,
      all: true,
      force: true,
      qunitOnly: true,
      concurrency: 2,
      maxLlmCalls: 1, // only one of the two candidates can consume a call
      noPrompt: true,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adaptersOk(),
      outputStream: memWritable([]),
    });
    expect(result.exitCode).toBe(1);
    expect(result.report.exitReason.kind).toBe('budget-exhausted');
    // The budget is honoured atomically across workers: exactly one call ran.
    expect(result.report.llmCallCount).toBe(1);
  });

  test('a glob-auto project falls back to serial and notes why', async () => {
    // No testsuite-require override → minimal-project discovers tests via its
    // karma files glob (glob-auto), where the lane cannot keep a parallel
    // worker's in-progress file out of another worker's karma run. Seed TWO
    // uncovered controllers (not one) so the `llmPeak === 1` assertion is
    // load-bearing: with the gate working, glob-auto forces serial and the two
    // generations never overlap (peak 1); if the gate regressed and ran at
    // concurrency 2, the pool degree would be min(2, 2) = 2 and llmPeak would
    // reach 2. (With a single candidate, degree = min(2, 1) = 1 regardless of
    // the gate, which would make the assertion vacuous.)
    seed(project.root, { testsuiteRequire: false });
    const runner = new TrackingRunner();
    const sink: string[] = [];
    const result = await runGenerate({
      projectRoot: project.root,
      all: true,
      force: true,
      qunitOnly: true,
      concurrency: 2,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adaptersOk(),
      outputStream: memWritable(sink),
    });
    expect(result.exitCode).toBe(0);
    // The run was forced serial — the note explains the fallback.
    const out = sink.join('');
    expect(out).toContain('auto-discovers QUnit tests via a karma glob');
    expect(out).toContain('Running serially to preserve verify-then-accept');
    // The gate suppressed concurrency: the two generations never overlapped.
    expect(runner.llmPeak).toBe(1);
  });
});

// =====================================================================
// V1.9.7 THR-4 — the pool-wide rate-limit backoff signal. When one worker hits
// a 429 and backs off, the pool DRAINS new dispatches (no peer piles onto the
// hot quota window, each burning its own backoff schedule + budget) and RESTORES
// K once the window clears. A PERSISTENT limit is unchanged — still a terminal
// `rate-limited` exit. Both run through the real `runGenerate` orchestrator at
// K=3 on a lane-safe (testsuite-require) project.
// =====================================================================
describe('runGenerate — V1.9.7 THR-4 pool-wide rate-limit backoff', () => {
  let project: Project;
  beforeEach(() => {
    project = setupFrom(MINIMAL_FIXTURE);
  });
  afterEach(() => {
    project.cleanup();
  });

  /**
   * Wait until `getLen()` has been UNCHANGED across `stableHops` consecutive
   * macrotask hops — i.e. every worker that CAN dispatch has, and the rest are
   * parked/idle. `stableHops` is set well above the peer completion chain
   * (writeFile → verify-lane → register → accept → loop → claim → readFile), so
   * a REGRESSED gate that lets a freed peer claim the held-back candidate grows
   * the count (resetting the stability counter) and is deterministically caught.
   * A single `setTimeout(0)` hop would resolve before that I/O-bound chain and
   * miss it — this is the reliable fail-on-revert form.
   */
  async function settleCalls(
    getLen: () => number,
    stableHops = 20,
    maxHops = 500,
  ): Promise<void> {
    let last = -1;
    let stable = 0;
    for (let i = 0; i < maxHops; i += 1) {
      await new Promise<void>((r) => setTimeout(r, 0));
      const n = getLen();
      if (n === last) {
        stable += 1;
        if (stable >= stableHops) return;
      } else {
        stable = 0;
        last = n;
      }
    }
  }

  /** The four controller basenames the scripted runners route on. */
  const NAMES = ['Alpha', 'Bravo', 'Charlie', 'Delta'] as const;

  /**
   * Seed N uncovered controllers plus a require-mode testsuite.qunit.html so
   * discovery is `testsuite-require` (lane-safe) and `--concurrency 3` is
   * honoured. Mirrors the V1.6 block's `seed`, generalised to N controllers.
   */
  function seedControllers(root: string, names: readonly string[]): void {
    writeFileSync(
      join(root, 'webapp', 'test', 'testsuite.qunit.html'),
      [
        '<!DOCTYPE html>',
        '<html><head><meta charset="utf-8"><script>',
        'QUnit.config.autostart = false;',
        'sap.ui.require([',
        '  "minimal/project/test/unit/controller/Main.controller.qunit"',
        '], function () { QUnit.start(); });',
        '</script></head><body></body></html>',
        '',
      ].join('\n'),
      'utf8',
    );
    for (const name of names) {
      writeFileSync(
        join(root, 'webapp', 'controller', `${name}.controller.js`),
        [
          'sap.ui.define(["sap/ui/core/mvc/Controller"], function (Controller) {',
          '  "use strict";',
          `  return Controller.extend("minimal.project.controller.${name}", {`,
          '    onInit: function () {}',
          '  });',
          '});',
          '',
        ].join('\n'),
        'utf8',
      );
    }
  }

  /** Which controller a generate prompt targets — throws on an unexpected call
   * so a stray (e.g. baseline) LLM call cannot silently corrupt `backerTag`. */
  function tagOf(prompt: string): string {
    for (const n of NAMES) {
      if (prompt.includes(`${n}.controller`)) return n;
    }
    throw new Error(`unexpected generate prompt (no known controller): ${prompt.slice(0, 80)}`);
  }

  function okResult(content: string, callId: string): ClaudeRunResult {
    return {
      ok: true,
      json: {},
      raw: JSON.stringify({ newFileContent: content }),
      stderr: '',
      exitCode: 0,
      durationMs: 0,
      callId,
    };
  }

  /** A result-shaped 429 — classified by `isRateLimitedResult`, so it routes
   * onto the SPEC §2.12 backoff schedule exactly like a real transient limit. */
  function rateLimited(callId: string): ClaudeRunResult {
    return { ok: false, json: {}, raw: '', stderr: '429 too many requests', exitCode: 1, durationMs: 0, callId };
  }

  test('a transient 429 drains new dispatch during the backoff window, then restores K (K=3)', async () => {
    seedControllers(project.root, NAMES); // 4 uncovered controllers

    let markEntered: (() => void) | undefined;
    const enteredBackoff = new Promise<void>((r) => {
      markEntered = r;
    });
    let releaseWindow: (() => void) | undefined;
    const windowHeld = new Promise<void>((r) => {
      releaseWindow = r;
    });
    let markThree: (() => void) | undefined;
    const threeDispatched = new Promise<void>((r) => {
      markThree = r;
    });

    // The single backoff sleep marks the backer in-backoff (gate now closed) and
    // holds the window open until the test releases it — deterministic, no clock.
    const barrierSleeper: Sleeper = async () => {
      markEntered?.();
      await windowHeld;
    };

    const calls: string[] = [];
    let backerTag: string | null = null;
    let backerCalls = 0;
    const runner: ClaudeRunner = {
      async run(args: ClaudeRunArgs): Promise<ClaudeRunResult> {
        const tag = tagOf(args.prompt);
        calls.push(tag);
        if (calls.length === 3) markThree?.();
        // The FIRST candidate to reach the runner becomes the backer (robust to
        // discovery/claim ordering); it transiently 429s then recovers.
        if (backerTag === null) backerTag = tag;
        if (tag === backerTag) {
          backerCalls += 1;
          return backerCalls === 1 ? rateLimited('backer-429') : okResult('// backer recovered\n', 'backer-ok');
        }
        // Peers must not complete-and-loop until the gate is closed, else they
        // could race a new claim ahead of the drain. Once the backer has entered
        // backoff they return normally and park at the (closed) gate.
        await enteredBackoff;
        return okResult(`// ${tag}\n`, `${tag}-ok`);
      },
    };

    const runPromise = runGenerate({
      projectRoot: project.root,
      all: true,
      force: true,
      qunitOnly: true,
      concurrency: 3,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adaptersOk(),
      backoffSleeper: barrierSleeper,
      outputStream: memWritable([]),
    });

    // Window is open: the backer is backing off and all 3 initially-claimed
    // candidates have dispatched. Then let the pool QUIESCE while the window is
    // still held — the peers finish their candidates (real writeFile/verify) and
    // park at the gate; no 4th dispatch can occur until the window clears.
    await enteredBackoff;
    await threeDispatched;
    await settleCalls(() => calls.length);

    // The load-bearing drain: the pool quiesced with exactly the 3 initially-
    // claimed candidates in flight; the 4th was NOT dispatched. Remove the pool
    // gate and a freed peer loops onto the 4th during this window → a 4th
    // distinct call, and this assertion fails — the fail-on-revert witness.
    expect(new Set(calls).size).toBe(3);
    expect(backerCalls).toBe(1); // the backer has NOT retried yet (window held)

    // Release → the backer recovers → K restored → the 4th candidate dispatches.
    releaseWindow?.();
    const result = await runPromise;

    expect(result.exitCode).toBe(0);
    const passed = result.report.generatedTests.filter((g) => g.status === 'passed');
    expect(passed.map((g) => g.sourceFile).sort()).toEqual([
      'webapp/controller/Alpha.controller.js',
      'webapp/controller/Bravo.controller.js',
      'webapp/controller/Charlie.controller.js',
      'webapp/controller/Delta.controller.js',
    ]);
    // Budget is charged once per candidate — the backer's retry is a 5th runner
    // call that does NOT re-consume: 4 candidates → llmCallCount 4, 5 runner calls.
    expect(result.report.llmCallCount).toBe(4);
    expect(calls.length).toBe(5);
    expect(new Set(calls).size).toBe(4);
    expect(calls.filter((t) => t === backerTag)).toHaveLength(2);
  });

  test('a persistent 429 under concurrency still ends in the honest rate-limited exit (no deadlock)', async () => {
    seedControllers(project.root, NAMES);

    const calls: string[] = [];
    let backerTag: string | null = null;
    const runner: ClaudeRunner = {
      async run(args: ClaudeRunArgs): Promise<ClaudeRunResult> {
        const tag = tagOf(args.prompt);
        calls.push(tag);
        if (backerTag === null) backerTag = tag;
        // The backer is rate-limited on EVERY attempt → the schedule exhausts.
        if (tag === backerTag) return rateLimited('persist-429');
        return okResult(`// ${tag}\n`, `${tag}-${calls.length}`);
      },
    };

    const result = await runGenerate({
      projectRoot: project.root,
      all: true,
      force: true,
      qunitOnly: true,
      concurrency: 3,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adaptersOk(),
      // Instant sleeper — the schedule exhausts without real waits. The window
      // opens/closes fast; the finally-exit must still release any peer parked at
      // the gate, or this test would hang instead of completing.
      backoffSleeper: async () => {},
      outputStream: memWritable([]),
    });

    // A persistent limit is a terminal signal — THR-4 does not soften it. The run
    // COMPLETED (a gate deadlock would time this test out) with the honest exit.
    expect(result.exitCode).toBe(1);
    expect(result.report.exitReason.kind).toBe('rate-limited');
  });
});

/**
 * R2.5 witnesses (AUDIT §5.7e) — the `verification: 'lint-only'` marker.
 *
 * OPA5 journeys are generated and verified but never auto-registered
 * (SPEC §2.1), so outside glob-auto discovery the whole-suite karma run
 * cannot execute them: a bare `passed` would overstate what was verified.
 * The orchestrator stamps `verification: 'lint-only'` on such entries —
 * and ONLY on such entries (QUnit passes and glob-auto journey passes are
 * karma-executed and carry no marker). Reverting the stamping in
 * `generate.ts` turns the first test red.
 */
describe('runGenerate — R2.5 OPA5 lint-only verification marker', () => {
  let project: Project;

  const PASSING_JOURNEY = [
    'sap.ui.define(["sap/ui/test/Opa5", "sap/ui/test/opaQunit"], function (Opa5, opaTest) {',
    '  "use strict";',
    '  opaTest("Should see the page", function (Given, When, Then) {',
    '    Then.iTeardownMyApp();',
    '  });',
    '});',
    '',
  ].join('\n');

  /** testsuite.qunit.html in the sap.ui.require([...]) html-mode format —
   * flips the copied fixture from glob-auto to testsuite-require. */
  const TESTSUITE_REQUIRE_HTML = [
    '<!DOCTYPE html>',
    '<html><head><meta charset="utf-8"><script>',
    'sap.ui.require([',
    '  "minimal/project/test/unit/controller/Main.controller.qunit"',
    '], function () {});',
    '</script></head><body></body></html>',
    '',
  ].join('\n');

  beforeEach(() => {
    project = setupFrom(MINIMAL_FIXTURE);
  });

  afterEach(() => {
    project.cleanup();
  });

  function opa5Runner(): FakeClaudeRunner {
    return new FakeClaudeRunner([
      {
        match: /Task: generate an OPA5 journey/,
        response: { raw: JSON.stringify({ newFileContent: PASSING_JOURNEY }) },
      },
    ]);
  }

  test('testsuite-require: a passed journey carries verification: lint-only (karma never executed it)', async () => {
    writeFileSync(
      join(project.root, 'webapp', 'test', 'testsuite.qunit.html'),
      TESTSUITE_REQUIRE_HTML,
      'utf8',
    );
    const result = await runGenerate({
      projectRoot: project.root,
      path: join(project.root, 'webapp', 'view', 'Main.view.xml'),
      force: true,
      opa5Only: true,
      runner: opa5Runner(),
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adaptersOk(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.report.generatedTests).toHaveLength(1);
    const entry = result.report.generatedTests[0];
    expect(entry?.status).toBe('passed');
    expect(entry?.testFile).toBe('webapp/test/integration/MainJourney.qunit.js');
    expect(entry?.verification).toBe('lint-only');
  });

  test('glob-auto: a passed journey is karma-collected via the broad files: glob — no marker', async () => {
    // The pristine fixture IS glob-auto (its testsuite.qunit.html has no
    // sap.ui.require array; karma files: carries globs).
    const result = await runGenerate({
      projectRoot: project.root,
      path: join(project.root, 'webapp', 'view', 'Main.view.xml'),
      force: true,
      opa5Only: true,
      runner: opa5Runner(),
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adaptersOk(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.report.generatedTests).toHaveLength(1);
    const entry = result.report.generatedTests[0];
    expect(entry?.status).toBe('passed');
    expect(entry?.verification).toBeUndefined();
    // V1.9.9 JS-unchanged witness — the run-level marker is TS-only: a JS
    // generate run (karma executed the tests) must never carry it, so cli.ts
    // prints no verification banner. Stamping it unconditionally → RED.
    expect(result.report.verification).toBeUndefined();
  });

  test('QUnit: a passed (registered, karma-executed) test never carries the marker', async () => {
    writeFileSync(
      join(project.root, 'webapp', 'controller', 'Other.controller.js'),
      [
        'sap.ui.define(["sap/ui/core/mvc/Controller"], function (Controller) {',
        '  "use strict";',
        '  return Controller.extend("minimal.project.controller.Other", {});',
        '});',
        '',
      ].join('\n'),
      'utf8',
    );
    const runner = new FakeClaudeRunner([
      {
        match: /Task: generate a QUnit unit test file/,
        response: {
          raw: JSON.stringify({ newFileContent: '// generated qunit test\n' }),
        },
      },
    ]);
    const result = await runGenerate({
      projectRoot: project.root,
      path: join(project.root, 'webapp', 'controller', 'Other.controller.js'),
      force: true,
      qunitOnly: true,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adaptersOk(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.report.generatedTests).toHaveLength(1);
    const entry = result.report.generatedTests[0];
    expect(entry?.status).toBe('passed');
    expect(entry?.verification).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// V1.9.2 (Phase 1) — generate proceeds for a TypeScript project: QUnit-only,
// static-only, karma NEVER invoked (verify OR baseline). Every change is
// projectLanguage-gated; the JS suites above are the frozen byte-identical
// witnesses.
describe('runGenerate — TypeScript (P1)', () => {
  // ts-helloworld is the small static TS fixture (no installed node_modules, so
  // cpSync is cheap): an `App.controller.ts` covered by `App.controller.qunit.ts`,
  // plus `view/App.view.xml` declaring that controller (for the OPA5-defer test).
  const TS_FIXTURE = join(process.cwd(), 'test', 'fixtures', 'ts-helloworld');
  let project: Project;

  beforeEach(() => {
    project = setupFrom(TS_FIXTURE);
  });

  afterEach(() => {
    project.cleanup();
  });

  // All-passing adapters with a karma spy — a single karma call is the firewall
  // breach witness. `tsc` is present because the TS verify lane runs
  // ui5lint → tsc → eslint (it has NO karma branch by construction).
  function tsAdapters(karmaCalls: unknown[]): VerifyAdapters {
    return {
      ui5lint: async () => ({ ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1 }),
      eslint: async () => ({ ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1 }),
      tsc: async () => ({ ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1 }),
      karma: async (args) => {
        karmaCalls.push(args);
        return { ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1, testFiles: [] };
      },
    };
  }

  // V1.9.7 (THR-3) — the Phase-4 correctness witness: a TypeScript project that
  // WOULD be lane-safe under the JS rules (a `sap.ui.require` testsuite.qunit.html
  // → `testsuite-require` discovery) is STILL forced to serial (K=1), even at
  // `--concurrency 2`, because its verify runs a whole-project `tsc --noEmit` that
  // globs the disk — a peer worker's in-flight `.qunit.ts` (written outside the
  // verify lane) would fail a SOUND candidate's tsc. THR-3's overlapping-verify
  // was evidence-REFUSED (win negligible: tsc ~2.7s vs LLM minutes; memory fine);
  // this guard is the correctness fix Phase 3's K=2 default made load-bearing.
  // Fail-on-revert: drop the `projectLanguage !== 'ts'` term in generate.ts's
  // `laneSafeDiscovery` → `report.concurrency` becomes 2 → this goes RED.
  test('a lane-safe TypeScript project is forced to K=1 even at --concurrency 2 (THR-3)', async () => {
    const ns = 'ui5/typescript/helloworld';
    // (1) A `sap.ui.require` testsuite → detectDiscoveryMode === 'testsuite-require'.
    mkdirSync(join(project.root, 'webapp', 'test'), { recursive: true });
    writeFileSync(
      join(project.root, 'webapp', 'test', 'testsuite.qunit.html'),
      [
        '<!DOCTYPE html>',
        '<html><head><script>',
        '  sap.ui.require([',
        `    "${ns}/test/unit/controller/Alpha.controller.qunit"`,
        '  ], function () { QUnit.start(); });',
        '</script></head><body></body></html>',
        '',
      ].join('\n'),
      'utf8',
    );
    // (2) Two uncovered `.ts` controllers → two QUnit candidates (would-be K=2).
    for (const name of ['Alpha', 'Bravo']) {
      writeFileSync(
        join(project.root, 'webapp', 'controller', `${name}.controller.ts`),
        [
          'import Controller from "sap/ui/core/mvc/Controller";',
          '/**',
          ' * @namespace ui5.typescript.helloworld.controller',
          ' */',
          `export default class ${name} extends Controller {`,
          '  public onInit(): void { /* noop */ }',
          '}',
          '',
        ].join('\n'),
        'utf8',
      );
    }
    // (3) Ship `typescript` so tscEnabled=true — the config where the whole-project
    //     tsc cross-contamination is real (a lint-only TS project runs single-file
    //     ui5lint+eslint and would be safe; we force ALL TS serial regardless).
    mkdirSync(join(project.root, 'node_modules', 'typescript'), { recursive: true });
    writeFileSync(
      join(project.root, 'node_modules', 'typescript', 'package.json'),
      JSON.stringify({ name: 'typescript', version: '5.6.3' }),
      'utf8',
    );

    // Non-vacuity: the project genuinely IS lane-safe by the JS discovery rules,
    // so a K=1 result can ONLY be the TS guard — not `unknown`-discovery fallback.
    expect(detectDiscoveryMode(project.root)).toBe('testsuite-require');

    const karmaCalls: unknown[] = [];
    const runner = new FakeClaudeRunner([
      {
        // The per-candidate QUnit generate prompt (any candidate). Content is
        // immaterial — this witness asserts the dispatch width + firewall, not
        // the generated test — so one response serves both candidates.
        match: /Controller module id/,
        response: {
          raw: JSON.stringify({
            newFileContent:
              `import Controller from "${ns}/controller/App.controller";\n` +
              'QUnit.module("Generated");\n' +
              'QUnit.test("loads", function (assert) { assert.ok(Controller); });\n',
          }),
        },
      },
    ]);

    const result = await runGenerate({
      projectRoot: project.root,
      all: true,
      force: true,
      qunitOnly: true,
      interactive: false,
      concurrency: 2,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      probeLib: async () => true,
      verifyAdapters: tsAdapters(karmaCalls),
      outputStream: memWritable([]),
    });

    // THR-3 correctness fix: TS is forced serial despite lane-safe discovery + K=2.
    expect(result.report.concurrency).toBe(1);
    // The never-build firewall holds under a K>1 REQUEST: karma never runs on TS.
    expect(karmaCalls).toHaveLength(0);
  });

  // Test A — HB-DISC discovery completeness + the never-build firewall. An
  // uncovered `.ts` controller must be discovered (→ a `.qunit.ts` candidate)
  // and verified WITHOUT karma, at the baseline probe AND the per-attempt verify.
  test('discovers an uncovered .ts controller and verifies it with karma == 0', async () => {
    const detailAbs = join(project.root, 'webapp', 'controller', 'Detail.controller.ts');
    writeFileSync(
      detailAbs,
      [
        'import Controller from "sap/ui/core/mvc/Controller";',
        '',
        '/**',
        ' * @namespace ui5.typescript.helloworld.controller',
        ' */',
        'export default class Detail extends Controller {',
        '  public onInit(): void {',
        '    /* noop */',
        '  }',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    const generatedTest = [
      'import Controller from "ui5/typescript/helloworld/controller/Detail.controller";',
      '',
      'QUnit.module("controller.Detail");',
      'QUnit.test("module loads", function (assert) {',
      '  assert.ok(Controller, "Detail controller module loads");',
      '});',
      '',
    ].join('\n');
    const runner = new FakeClaudeRunner([
      {
        match: /Task: generate a QUnit unit test file/,
        response: { raw: JSON.stringify({ newFileContent: generatedTest }) },
      },
    ]);

    const karmaCalls: unknown[] = [];
    const result = await runGenerate({
      projectRoot: project.root,
      path: detailAbs,
      force: true,
      interactive: false,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      probeLib: async () => true,
      verifyAdapters: tsAdapters(karmaCalls),
    });

    // (1) HB-DISC: the `.ts` controller was discovered and a `.qunit.ts` test
    //     was generated. Reverting TG-GUARD-LIFT (refuse) or TG-DISC (JS globs
    //     cannot classify a `.ts` controller) yields zero entries → RED.
    expect(result.report.generatedTests).toHaveLength(1);
    const entry = result.report.generatedTests[0]!;
    expect(entry.sourceFile).toBe('webapp/controller/Detail.controller.ts');
    expect(entry.testFile).toBe('webapp/test/unit/controller/Detail.controller.qunit.ts');
    expect(entry.status).toBe('passed');
    // (1b) TG-REPORT / FS-8 + V1.9.3 D1: a TS QUnit pass is reported with the
    //      honest verification depth — never a silent green. `ts-helloworld`
    //      ships NO `node_modules/typescript`, so `tscEnabled=false`: `tsc` is
    //      skipped (the injected `tsc` adapter is never called) and the lane
    //      narrows to ui5lint → the marker is `'lint-only'`, NOT `'static-only'`
    //      (which would falsely claim "type-checked"). The `tscEnabled=true`
    //      twin below proves `'static-only'` still fires when `tsc` runs.
    //      Reverting the D1 gate (stamp `'static-only'` unconditionally) → RED.
    expect(entry.verification).toBe('lint-only');
    // (1c) V1.9.9 — the RUN-LEVEL marker mirrors validate's (generate.ts stamps
    //      it past the early-returns): same D1 depth gate, so `'lint-only'`
    //      here. This is what makes cli.ts print the honest run banner on a TS
    //      generate run. Reverting the generate.ts stamp → undefined → RED.
    expect(result.report.verification).toBe('lint-only');

    // (2) THE FIREWALL: karma is never invoked on the TS path — not by the
    //     baseline probe (TG-FW-BASELINE) and not by the per-attempt verify
    //     (TG-LANG-WIRE → static-only lane). Reverting either fires karma → RED.
    expect(karmaCalls).toHaveLength(0);
  });

  // Test A′ (V1.9.3 D1 — the faithful-both-directions twin of Test A / G1) —
  // when the project DOES ship its own `typescript` (`tscEnabled=true`), `tsc`
  // runs and the marker is `'static-only'`. Together with Test A (lint-only when
  // tsc is skipped) this pins the D1 gate in both directions: reverting the gate
  // (always-`'static-only'`) leaves THIS green but flips Test A RED; a wrong gate
  // that always emitted `'lint-only'` would flip THIS RED. Karma stays at 0.
  test('a TS project that ships its own typescript reports static-only (tscEnabled=true)', async () => {
    // Seed `node_modules/typescript/package.json` — the FIRST branch
    // `hasProjectTypeScript` checks (mirrors Test D at the tsconfig-scope guard).
    // The ts-helloworld tsconfig already includes `./webapp/**/*`, so the test
    // dir is in `tsc` scope and the scope guard passes.
    mkdirSync(join(project.root, 'node_modules', 'typescript'), { recursive: true });
    writeFileSync(
      join(project.root, 'node_modules', 'typescript', 'package.json'),
      JSON.stringify({ name: 'typescript', version: '5.4.0' }),
      'utf8',
    );

    const detailAbs = join(project.root, 'webapp', 'controller', 'Detail.controller.ts');
    writeFileSync(
      detailAbs,
      [
        'import Controller from "sap/ui/core/mvc/Controller";',
        '/**',
        ' * @namespace ui5.typescript.helloworld.controller',
        ' */',
        'export default class Detail extends Controller {',
        '  public onInit(): void { /* noop */ }',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    const generatedTest = [
      'import Controller from "ui5/typescript/helloworld/controller/Detail.controller";',
      '',
      'QUnit.module("controller.Detail");',
      'QUnit.test("module loads", function (assert) {',
      '  assert.ok(Controller, "Detail controller module loads");',
      '});',
      '',
    ].join('\n');
    const runner = new FakeClaudeRunner([
      {
        match: /Task: generate a QUnit unit test file/,
        response: { raw: JSON.stringify({ newFileContent: generatedTest }) },
      },
    ]);

    const karmaCalls: unknown[] = [];
    const result = await runGenerate({
      projectRoot: project.root,
      path: detailAbs,
      force: true,
      interactive: false,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      probeLib: async () => true,
      verifyAdapters: tsAdapters(karmaCalls),
    });

    expect(result.report.generatedTests).toHaveLength(1);
    const entry = result.report.generatedTests[0]!;
    expect(entry.status).toBe('passed');
    // D1: `tsc` ran (tscEnabled=true) → the marker honestly reads `'static-only'`.
    expect(entry.verification).toBe('static-only');
    // V1.9.9 — run-level twin (see Test A's (1c)): `'static-only'` when tsc ran.
    expect(result.report.verification).toBe('static-only');
    // The firewall holds regardless of tscEnabled — karma is never the TS lane.
    expect(karmaCalls).toHaveLength(0);
  });

  // Test B — OPA5-for-TS is deferred (QUnit-only), surfaced explicitly.
  test('--opa5-only on a TS project generates no journey and prints the deferred notice', async () => {
    const appViewAbs = join(project.root, 'webapp', 'view', 'App.view.xml');
    const sink: string[] = [];
    const karmaCalls: unknown[] = [];

    const result = await runGenerate({
      projectRoot: project.root,
      path: appViewAbs,
      opa5Only: true,
      force: true,
      interactive: false,
      runner: new FakeClaudeRunner([]),
      probeAdapter: ALL_TOOLS_OK,
      probeLib: async () => true,
      verifyAdapters: tsAdapters(karmaCalls),
      outputStream: memWritable(sink),
    });

    // (1) No OPA5 journey was generated. Reverting the `&& projectLanguage !== 'ts'`
    //     gate pairs the view with its `.ts` controller (dual-suffix) → a Journey
    //     entry whose testFile matches /Journey/i → RED.
    expect(result.report.generatedTests.every((g) => !/Journey/i.test(g.testFile))).toBe(true);
    // (2) The defer is surfaced, never a silent no-op. Removing the deferred
    //     notice branch → RED.
    expect(sink.join('')).toContain('OPA5 generation for TypeScript projects is deferred');
    // The TS path stays karma-free here too.
    expect(karmaCalls).toHaveLength(0);
  });

  // Test C (Phase 2 — TG-SCAFFOLD-DEFER, decision #4) — a TS project with NO
  // existing test layout is REFUSED, never scaffolded. `scaffoldTestLayout`
  // writes `.js`/AMD QUnit templates, which would corrupt an ES-module TS
  // project; `.ts` scaffold templates are deferred to a later cycle.
  test('TG-SCAFFOLD-DEFER: a TS project with no webapp/test refuses, never scaffolds', async () => {
    // Strip the fixture's test layout so the no-tests branch (step 7) is reached.
    rmSync(join(project.root, 'webapp', 'test'), { recursive: true, force: true });
    expect(existsSync(join(project.root, 'webapp', 'test'))).toBe(false);

    // `interactive: true` + a picker spy: on the JS path this scaffolds. The TS
    // guard must short-circuit BEFORE the picker / any scaffold write.
    const picker = vi.fn(async () => 'sap.m' as const);
    const karmaCalls: unknown[] = [];
    const sink: string[] = [];
    const result = await runGenerate({
      projectRoot: project.root,
      force: true,
      interactive: true,
      templatePicker: picker,
      runner: new FakeClaudeRunner([]),
      probeAdapter: ALL_TOOLS_OK,
      probeLib: async () => true,
      verifyAdapters: tsAdapters(karmaCalls),
      outputStream: memWritable(sink),
    });

    // Refused with the no-tests exit reason, before any LLM call.
    expect(result.exitCode).toBe(1);
    expect(result.report.exitReason).toEqual({ kind: 'no-tests-template-required' });
    expect(result.report.llmCallCount).toBe(0);
    // The picker was NEVER invoked. Reverting the TG-SCAFFOLD-DEFER guard → the
    // picker is called + `scaffoldTestLayout` runs → this assertion goes RED.
    expect(picker).not.toHaveBeenCalled();
    // Nothing was scaffolded onto disk (no `.js`/AMD templates seeded).
    expect(existsSync(join(project.root, 'webapp', 'test'))).toBe(false);
    // The deferral is surfaced, not a silent refusal.
    expect(sink.join('')).toContain('.ts test scaffolding is deferred');
    // Firewall holds — no karma on the TS path.
    expect(karmaCalls).toHaveLength(0);
  });

  // Test D (Phase 3 — TG-ACCEPT / FS-6, the tsconfig-scope guard) — when the
  // project ships its own `typescript` (so `tsc --noEmit` is the accept check)
  // but its tsconfig `include` does NOT cover the generated test directory, the
  // accept check would be vacuous. generate-TS REFUSES, before any LLM call,
  // rather than emit a false static-only green.
  test('tsconfig-scope guard: a TS project whose tsconfig omits the test dir refuses', async () => {
    // tscEnabled is true only when the project ships `typescript`. Seed a marker
    // package so `hasProjectTypeScript` returns true; the guard is pre-flight, so
    // no real tsc is ever spawned (verifyAdapters are injected below anyway).
    mkdirSync(join(project.root, 'node_modules', 'typescript'), { recursive: true });
    writeFileSync(
      join(project.root, 'node_modules', 'typescript', 'package.json'),
      JSON.stringify({ name: 'typescript', version: '5.4.0' }),
      'utf8',
    );
    // Narrow the copied tsconfig so webapp/test/unit is OUT of `include` scope.
    writeFileSync(
      join(project.root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { strict: true },
        include: ['webapp/controller/**/*'],
      }),
      'utf8',
    );
    // An uncovered `.ts` controller so generate has a candidate to verify.
    const detailAbs = join(project.root, 'webapp', 'controller', 'Detail.controller.ts');
    writeFileSync(
      detailAbs,
      [
        'import Controller from "sap/ui/core/mvc/Controller";',
        '/**',
        ' * @namespace ui5.typescript.helloworld.controller',
        ' */',
        'export default class Detail extends Controller {',
        '  public onInit(): void { /* noop */ }',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    const sink: string[] = [];
    const karmaCalls: unknown[] = [];
    const runner = new FakeClaudeRunner([
      {
        match: /Task: generate a QUnit unit test file/,
        response: { raw: JSON.stringify({ newFileContent: '// should never be generated\n' }) },
      },
    ]);
    const result = await runGenerate({
      projectRoot: project.root,
      path: detailAbs,
      force: true,
      interactive: false,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      probeLib: async () => true,
      verifyAdapters: tsAdapters(karmaCalls),
      outputStream: memWritable(sink),
    });

    // Fail CLOSED: exit 1, the refusal is surfaced, and NO test was generated
    // (no LLM call). Reverting the guard → generate proceeds and produces a
    // `passed`/`static-only` entry → these assertions go RED.
    expect(result.exitCode).toBe(1);
    expect(result.report.generatedTests).toHaveLength(0);
    expect(result.report.llmCallCount).toBe(0);
    expect(sink.join('')).toContain('outside tsconfig.json "include"');
    // The firewall holds on the refusal path too.
    expect(karmaCalls).toHaveLength(0);
  });

  // G5 (V1.9.3 D2) — the multi-candidate cap_try_ts shape: a mid-run, NON-envelope
  // 429 on a `generate --all` must terminate the run with the honest
  // `rate-limited` exit reason (not `no-output` / `unfixed-findings`), with the
  // candidate already in flight kept and the remaining candidates short-circuited.
  // This drives a REAL BinaryRunner with a stubbed exec — a FakeClaudeRunner
  // bypasses interpretEnvelope and would never exercise the D2 transport guard,
  // so it could not go RED on revert. Reverting the binary-runner guard →
  // BinaryRunner throws MalformedLlmOutputError → isRateLimitedApiError(false) →
  // the candidate degrades to no-output, the run does NOT stop, and the exit
  // reason is no longer `rate-limited` → this test goes RED.
  test('multi-candidate --all: a non-envelope 429 on the 2nd candidate → rate-limited, 1st kept, 3rd not attempted', async () => {
    // Three uncovered `.ts` controllers → three QUnit candidates.
    for (const name of ['Alpha', 'Bravo', 'Charlie']) {
      writeFileSync(
        join(project.root, 'webapp', 'controller', `${name}.controller.ts`),
        [
          'import Controller from "sap/ui/core/mvc/Controller";',
          '/**',
          ' * @namespace ui5.typescript.helloworld.controller',
          ' */',
          `export default class ${name} extends Controller {`,
          '  public onInit(): void { /* noop */ }',
          '}',
          '',
        ].join('\n'),
        'utf8',
      );
    }

    // Dispatch by GLOBAL call index, so whichever candidate is processed FIRST
    // succeeds and whichever is processed SECOND hits the 429 — independent of
    // discovery order. The first call returns a shape-valid `.qunit.ts` for the
    // controller named in THAT prompt (so the retry-loop shape gate accepts it
    // on attempt 1 = exactly one call); every later call returns the 429 body.
    let callIndex = 0;
    const rateLimitBody = 'HTTP 429 Too Many Requests: rate limit exceeded, please retry later.';
    const exec = async (
      _file: string,
      _execArgs: readonly string[] = [],
      opts: { input?: string } = {},
    ): Promise<ExecResult> => {
      const idx = callIndex;
      callIndex += 1;
      if (idx === 0) {
        // TR-1 (V1.9.6): the prompt now arrives via the child's stdin
        // (`opts.input`), no longer at argv index 1 — read it from there to
        // extract the controller module id.
        const prompt = opts.input ?? '';
        const m = prompt.match(/Controller module id[^:\n]*:\s*(\S+)/);
        const moduleId = m?.[1] ?? 'ui5/typescript/helloworld/controller/Unknown.controller';
        const test = [
          `import Controller from "${moduleId}";`,
          '',
          'QUnit.module("g5");',
          'QUnit.test("module loads", function (assert) {',
          '  assert.ok(Controller, "controller module loads");',
          '});',
          '',
        ].join('\n');
        return {
          ok: true,
          exitCode: 0,
          stdout: successEnvelope(JSON.stringify({ newFileContent: test })),
          stderr: '',
          durationMs: 1,
        };
      }
      // Non-envelope 429 (exit 1 + non-empty stdout → retryable, not a kill).
      return { ok: false, exitCode: 1, stdout: rateLimitBody, stderr: '', durationMs: 1 };
    };
    const errorDir = mkdtempSync(join(tmpdir(), 'g5-d2-err-'));
    const runner = new BinaryRunner({
      errorOutputDir: errorDir,
      execImpl: exec,
      callIdFactory: () => 'g5-call',
    });

    const karmaCalls: unknown[] = [];
    const result = await runGenerate({
      projectRoot: project.root,
      all: true,
      qunitOnly: true,
      force: true,
      interactive: false,
      // V1.9.7 (THR-1) — this witness is specifically about the SEQUENTIAL
      // mid-run short-circuit (1st ok → 2nd 429 stops the run → 3rd never
      // claimed → exactly 2 entries), asserted via a global call-index fake.
      // Pin K=1 so the intent is explicit and immune to a future orchestrator
      // default or a lane-safe fixture (at K≥2 a freed worker could claim the
      // 3rd candidate before the terminal stop lands → 3 entries). The fixture
      // is `unknown`-discovery today, so this only makes the existing serial
      // behaviour explicit — no assertion changes.
      concurrency: 1,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      probeLib: async () => true,
      verifyAdapters: tsAdapters(karmaCalls),
      // Instant backoff so the SPEC §2.12 schedule exhausts without real waits.
      backoffSleeper: async () => {},
      outputStream: memWritable([]),
    });

    rmSync(errorDir, { recursive: true, force: true });

    // (1) The honest terminal reason — D2's payoff. Reverting the binary-runner
    //     guard makes this `unfixed-findings` (the 429 degrades to no-output and
    //     the run does NOT stop) → RED.
    expect(result.report.exitReason.kind).toBe('rate-limited');
    expect(result.exitCode).toBe(1);
    if (result.report.exitReason.kind === 'rate-limited') {
      // The raw 429 body propagated into the honest reason (not a malformed
      // attribution): the classifier carried the limit text through.
      expect(result.report.exitReason.lastError).toMatch(/rate limit|429|too many/i);
    }

    // (2) Short-circuit: exactly two entries — the 1st candidate processed and
    //     the 2nd (the 429). The 3rd was never claimed (stop fired) → no entry.
    expect(result.report.generatedTests).toHaveLength(2);
    const passed = result.report.generatedTests.filter((e) => e.status === 'passed');
    const noOutput = result.report.generatedTests.filter((e) => e.status === 'no-output');
    expect(passed).toHaveLength(1);
    expect(noOutput).toHaveLength(1);
    // The processed candidate is reported at its honest TS verification depth
    // (ts-helloworld ships no own `typescript` → tsc skipped → lint-only, D1).
    expect(passed[0]!.verification).toBe('lint-only');
    // The rate-limited candidate's no-output names the INITIAL phase (the
    // terminal signal killed its first call, nothing reached disk).
    expect(noOutput[0]!.quarantineReason?.phase).toBe('initial');

    // (3) THE FIREWALL holds on the D2 path too — karma is never invoked on TS.
    expect(karmaCalls).toHaveLength(0);
  });
});

describe('runGenerate — V1.9.4 PERF-17 user-selectable model (--model)', () => {
  let project: Project;

  beforeEach(() => {
    project = setupFrom(MINIMAL_FIXTURE);
    writeFileSync(
      join(project.root, 'webapp', 'controller', 'Other.controller.js'),
      [
        'sap.ui.define(["sap/ui/core/mvc/Controller"], function (Controller) {',
        '  "use strict";',
        '  return Controller.extend("minimal.project.controller.Other", {',
        '    onInit: function () {}',
        '  });',
        '});',
        '',
      ].join('\n'),
      'utf8',
    );
  });

  afterEach(() => {
    project.cleanup();
  });

  const passingTest = [
    'sap.ui.define([',
    '  "minimal/project/controller/Other.controller"',
    '], function (Other) {',
    '  "use strict";',
    '  QUnit.module("controller.Other");',
    '  QUnit.test("module loads", function (assert) {',
    '    assert.ok(Other, "Other controller module loads");',
    '  });',
    '});',
    '',
  ].join('\n');

  test('an explicit model threads onto the generate call and is recorded on report.model', async () => {
    const targetControllerAbs = join(project.root, 'webapp', 'controller', 'Other.controller.js');
    const runner = new FakeClaudeRunner([
      {
        match: /Task: generate a QUnit unit test file/,
        response: { raw: JSON.stringify({ newFileContent: passingTest }) },
      },
    ]);
    const result = await runGenerate({
      projectRoot: project.root,
      path: targetControllerAbs,
      force: true,
      qunitOnly: true,
      model: 'cheaper-model-x',
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adaptersOk(),
    });
    expect(result.exitCode).toBe(0);
    // Fail-on-revert guard: drop the GenerateContext.model thread or the
    // generate `finish()` recording and one of these goes red.
    expect(result.report.model).toBe('cheaper-model-x');
    expect(runner.calls.length).toBeGreaterThan(0);
    for (const call of runner.calls) {
      expect(call.model).toBe('cheaper-model-x');
    }
  });

  test('default run forwards NO model and records none', async () => {
    const targetControllerAbs = join(project.root, 'webapp', 'controller', 'Other.controller.js');
    const runner = new FakeClaudeRunner([
      {
        match: /Task: generate a QUnit unit test file/,
        response: { raw: JSON.stringify({ newFileContent: passingTest }) },
      },
    ]);
    const result = await runGenerate({
      projectRoot: project.root,
      path: targetControllerAbs,
      force: true,
      qunitOnly: true,
      runner,
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adaptersOk(),
    });
    expect(result.exitCode).toBe(0);
    expect('model' in result.report).toBe(false);
    expect(runner.calls.length).toBeGreaterThan(0);
    for (const call of runner.calls) {
      expect('model' in call).toBe(false);
    }
  });
});
