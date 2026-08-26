import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach } from 'vitest';
import { CallBudget } from '../../src/claude/budget.js';
import { createCapState } from '../../src/budget/cap.js';
import { FakeClaudeRunner } from '../../src/claude/fake-runner.js';
import type { CheckContext } from '../../src/checks/types.js';

interface Harness {
  readonly projectRoot: string;
  writeFile(relPath: string, content: string): string;
  makeCtx(runner: FakeClaudeRunner, maxCalls?: number): CheckContext;
}

export function createCheckHarness(): Harness {
  const projectRoot = mkdtempSync(join(tmpdir(), 'sapui5-checks-'));
  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });
  return {
    projectRoot,
    writeFile(relPath, content) {
      const abs = join(projectRoot, relPath);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, 'utf8');
      return abs;
    },
    makeCtx(runner, maxCalls = 10) {
      return {
        projectRoot,
        runner,
        budget: new CallBudget({ maxCalls }),
        // COR-7: capState is required. A 100% per-check cap of at least 1 never
        // binds before the global budget (incl. the maxCalls=0 budget-exhausted
        // case), so check tests keep their prior semantics.
        capState: createCapState(100, Math.max(1, maxCalls)),
      };
    },
  };
}

export function findingsResponse(payload: unknown): { raw: string } {
  return { raw: JSON.stringify(payload) };
}
