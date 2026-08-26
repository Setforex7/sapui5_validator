/**
 * R1.1 (AUDIT §5.2) / v0.8.1 V1 (SECURITY-QUALITY-AUDIT-v0.8.0) —
 * `applyAndVerifyFix` containment guard.
 *
 * The normalizer pins `finding.file` to the scanned target, but the fix
 * phase keeps its own defense-in-depth: a finding whose `file` resolves
 * outside `projectRoot` must throw BEFORE any write. v0.8.1 upgraded the
 * guard from lexical `resolve` to realpath-based `assertInsideProject` —
 * the junction witness below is the audit's verified V1 bypass and goes red
 * on revert to the lexical check. The other tests fail on revert of the
 * containment check in `commands/validate.ts` entirely.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { CallBudget } from '../../src/claude/budget.js';
import { FakeClaudeRunner } from '../../src/claude/fake-runner.js';
import { applyAndVerifyFix } from '../../src/commands/validate.js';
import type { Finding } from '../../src/types.js';
import type { VerifyPipelineInput, VerifyResult } from '../../src/verify/pipeline.js';

const VERIFY_OK: VerifyResult = { ok: true, steps: [], feedbackForLlm: '' };

function finding(file: string): Finding {
  return {
    checkId: 'no-direct-dom',
    file,
    message: 'direct DOM access',
    source: 'check',
    proposedFix: { newFileContent: 'fixed content\n' },
  };
}

describe('applyAndVerifyFix containment (R1.1)', () => {
  let projectRoot: string;
  let outsideDir: string;

  beforeEach(() => {
    const base = mkdtempSync(join(tmpdir(), 'sapui5-validator-containment-'));
    projectRoot = join(base, 'project');
    outsideDir = join(base, 'outside');
    mkdirSync(join(projectRoot, 'webapp'), { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(join(projectRoot, '..'), { recursive: true, force: true });
  });

  function ctx(f: Finding, verifyFn?: (input: VerifyPipelineInput) => Promise<VerifyResult>) {
    return {
      finding: f,
      projectRoot,
      runner: new FakeClaudeRunner([]),
      budget: new CallBudget({ maxCalls: 5 }),
      eslintEnabled: false,
      verifyFn: verifyFn ?? (async () => VERIFY_OK),
    };
  }

  test('relative path escaping projectRoot throws before any write', async () => {
    const victim = join(outsideDir, 'evil.js');
    writeFileSync(victim, 'original outside content\n', 'utf8');
    await expect(
      applyAndVerifyFix(ctx(finding('../outside/evil.js'))),
    ).rejects.toThrow(/outside project root/);
    // The throw happened before the write loop: the victim is untouched.
    expect(readFileSync(victim, 'utf8')).toBe('original outside content\n');
  });

  test('absolute path outside projectRoot throws before any write', async () => {
    const victim = join(outsideDir, 'abs-evil.js');
    writeFileSync(victim, 'untouched\n', 'utf8');
    await expect(applyAndVerifyFix(ctx(finding(victim)))).rejects.toThrow(
      /outside project root/,
    );
    expect(readFileSync(victim, 'utf8')).toBe('untouched\n');
  });

  test('projectRoot itself is not a writable target', async () => {
    await expect(applyAndVerifyFix(ctx(finding('.')))).rejects.toThrow(
      /outside project root/,
    );
  });

  test('v0.8.1 V1: junction/symlink under webapp pointing out of tree throws before any write', async () => {
    // The audit's verified repro: proj/webapp/linked ──(junction)──► ../outside.
    // The pre-0.8.1 lexical check returned BLOCKED=false for this shape and
    // writeFile overwrote the outside file through the link.
    const victim = join(outsideDir, 'target.js');
    writeFileSync(victim, 'ORIGINAL-OUTSIDE-CONTENT\n', 'utf8');
    symlinkSync(outsideDir, join(projectRoot, 'webapp', 'linked'), 'junction');
    await expect(
      applyAndVerifyFix(ctx(finding('webapp/linked/target.js'))),
    ).rejects.toThrow(/outside project root/);
    expect(readFileSync(victim, 'utf8')).toBe('ORIGINAL-OUTSIDE-CONTENT\n');
  });

  test('control: an in-root file passes the guard and applies normally', async () => {
    const rel = 'webapp/Main.controller.js';
    writeFileSync(join(projectRoot, rel), 'sap.ui.define([], function(){});\n', 'utf8');
    const outcome = await applyAndVerifyFix(ctx(finding(rel)));
    expect(outcome).toEqual({ kind: 'applied', attempts: 1 });
    expect(readFileSync(join(projectRoot, rel), 'utf8')).toBe('fixed content\n');
    expect(existsSync(join(outsideDir, 'evil.js'))).toBe(false);
  });
});
