/**
 * v0.8.1 V2 (SECURITY-QUALITY-AUDIT-v0.8.0) — `generate` write-path
 * containment. Pre-0.8.1 the generated-test write (`retry-loop.ts`) had NO
 * containment check at all: a hostile karma `files:` glob like
 * `../../../../tmp/attacker-drop/…/…qunit.js` flowed through
 * `resolveQUnitRoot`/`expectedTestPath` into an out-of-tree
 * `targetTestFileAbs`, and the quarantine destination could follow a link
 * under `webapp/` out of the project. These witnesses go red on revert of
 * the `assertInsideProject` calls in `generateAndVerify`/`quarantine`.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { CallBudget } from '../../src/claude/budget.js';
import { FakeClaudeRunner } from '../../src/claude/fake-runner.js';
import { generateAndVerify } from '../../src/generation/retry-loop.js';
import { OutsideProjectRootError } from '../../src/util/containment.js';
import type { VerifyResult } from '../../src/verify/pipeline.js';

const VERIFY_OK: VerifyResult = { ok: true, steps: [], feedbackForLlm: '' };
const VERIFY_FAIL: VerifyResult = {
  ok: false,
  steps: [],
  failedStep: 'karma',
  feedbackForLlm: 'assert failed',
};

describe('generateAndVerify containment (v0.8.1 V2)', () => {
  let base: string;
  let root: string;
  let outsideDir: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'sapui5-gen-containment-'));
    root = join(base, 'project');
    outsideDir = join(base, 'attacker-drop');
    mkdirSync(join(root, 'webapp', 'test', 'unit'), { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  function makeCtx(runner: FakeClaudeRunner, verify: VerifyResult) {
    return {
      projectRoot: root,
      runner,
      budget: new CallBudget({ maxCalls: 10 }),
      eslintEnabled: false,
      verifyFn: async () => verify,
    };
  }

  function makeRequest(target: string) {
    return {
      initialPrompt: 'Generate test',
      buildRefinementPrompt: () => 'refine',
      targetTestFileAbs: target,
    };
  }

  test('hostile karma-glob shape (`..`-derived target) is refused BEFORE the LLM call', async () => {
    // The audit's verified V2 PoC: join(projectRoot, qunitRoot-with-`..`)
    // collapses to a path outside the project. The refusal must also spend
    // no LLM budget — the target is known-bad before any generation.
    const target = join(root, '..', 'attacker-drop', 'controller', 'App.controller.qunit.js');
    const runner = new FakeClaudeRunner([]);
    await expect(
      generateAndVerify(makeRequest(target), makeCtx(runner, VERIFY_OK)),
    ).rejects.toThrow(OutsideProjectRootError);
    expect(runner.calls.length).toBe(0);
    expect(readdirSync(outsideDir)).toEqual([]);
  });

  test('absolute out-of-tree target is refused before the LLM call', async () => {
    const target = join(outsideDir, 'Abs.qunit.js');
    const runner = new FakeClaudeRunner([]);
    await expect(
      generateAndVerify(makeRequest(target), makeCtx(runner, VERIFY_OK)),
    ).rejects.toThrow(/outside project root/);
    expect(runner.calls.length).toBe(0);
    expect(existsSync(target)).toBe(false);
  });

  test('junction/symlink under webapp pointing out of tree is refused (realpath catch)', async () => {
    // proj/webapp/test/linked ──(junction; plain symlink on POSIX)──► outside.
    // A lexical check calls this in-tree; realpath must not.
    symlinkSync(outsideDir, join(root, 'webapp', 'test', 'linked'), 'junction');
    const target = join(root, 'webapp', 'test', 'linked', 'Evil.qunit.js');
    const runner = new FakeClaudeRunner([]);
    await expect(
      generateAndVerify(makeRequest(target), makeCtx(runner, VERIFY_OK)),
    ).rejects.toThrow(OutsideProjectRootError);
    expect(runner.calls.length).toBe(0);
    expect(readdirSync(outsideDir)).toEqual([]);
  });

  test('quarantine destination behind a linked _failing dir is refused', async () => {
    // The generated test itself is in-tree, but webapp/test/_failing is a
    // link out of the project — the quarantine move (unlink+rename) must
    // refuse rather than drop the failing artifact outside the tree.
    symlinkSync(outsideDir, join(root, 'webapp', 'test', '_failing'), 'junction');
    const target = join(root, 'webapp', 'test', 'unit', 'Bad.qunit.js');
    const runner = new FakeClaudeRunner([
      { match: /./, response: { raw: JSON.stringify({ newFileContent: '// BROKEN\n' }) } },
    ]);
    await expect(
      generateAndVerify(makeRequest(target), makeCtx(runner, VERIFY_FAIL)),
    ).rejects.toThrow(OutsideProjectRootError);
    expect(readdirSync(outsideDir)).toEqual([]);
  });

  test('control: a legitimate in-tree target still generates and writes', async () => {
    const target = join(root, 'webapp', 'test', 'unit', 'Ok.qunit.js');
    const runner = new FakeClaudeRunner([
      { match: /./, response: { raw: JSON.stringify({ newFileContent: '// PASS\n' }) } },
    ]);
    const outcome = await generateAndVerify(
      makeRequest(target),
      makeCtx(runner, VERIFY_OK),
    );
    expect(outcome.kind).toBe('generated');
    expect(existsSync(target)).toBe(true);
  });
});
