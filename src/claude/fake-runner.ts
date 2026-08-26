/**
 * Test-only scripted `ClaudeRunner`. NEVER imported from the runtime path:
 * this file is excluded from the build `tsconfig.json` and is therefore
 * absent from `dist/` and the published package. The packaging test in
 * `test/unit/packaging.test.ts` asserts both invariants.
 */

import type { ClaudeRunArgs, ClaudeRunResult, ClaudeRunner } from './runner.js';

export type FakeRunnerMatcher =
  | string
  | RegExp
  | ((args: ClaudeRunArgs) => boolean);

export type FakeRunnerResponse =
  | Partial<ClaudeRunResult>
  | ((args: ClaudeRunArgs) => Partial<ClaudeRunResult>);

export interface FakeRunnerEntry {
  readonly match: FakeRunnerMatcher;
  readonly response: FakeRunnerResponse;
}

export interface FakeClaudeRunnerOptions {
  /** Inject a deterministic call-id factory. Default: incrementing counter. */
  readonly callIdFactory?: () => string;
}

export class FakeClaudeRunner implements ClaudeRunner {
  readonly calls: ClaudeRunArgs[] = [];
  private readonly script: FakeRunnerEntry[];
  private readonly callIdFactory: () => string;
  private callIndex = 0;

  constructor(script: readonly FakeRunnerEntry[] = [], options: FakeClaudeRunnerOptions = {}) {
    this.script = [...script];
    if (options.callIdFactory !== undefined) {
      this.callIdFactory = options.callIdFactory;
    } else {
      let counter = 0;
      this.callIdFactory = () => {
        counter += 1;
        return `fake-${counter.toString(10)}`;
      };
    }
  }

  enqueue(entry: FakeRunnerEntry): void {
    this.script.push(entry);
  }

  async run(args: ClaudeRunArgs): Promise<ClaudeRunResult> {
    this.calls.push(args);
    const entry = this.script.find((e) => matches(e.match, args));
    if (entry === undefined) {
      throw new Error(
        `FakeClaudeRunner: no scripted response for prompt: ${args.prompt.slice(0, 120)}`,
      );
    }
    const partial = typeof entry.response === 'function' ? entry.response(args) : entry.response;
    this.callIndex += 1;
    return {
      ok: true,
      json: {},
      raw: '',
      stderr: '',
      exitCode: 0,
      durationMs: 0,
      callId: this.callIdFactory(),
      ...partial,
    };
  }
}

function matches(matcher: FakeRunnerMatcher, args: ClaudeRunArgs): boolean {
  if (typeof matcher === 'string') return args.prompt.includes(matcher);
  if (matcher instanceof RegExp) return matcher.test(args.prompt);
  return matcher(args);
}
