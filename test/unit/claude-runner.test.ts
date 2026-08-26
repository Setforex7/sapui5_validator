import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  ALLOWED_TOOLS,
  FORBIDDEN_TOOL_PATTERNS,
  buildClaudeArgs,
} from '../../src/claude/runner.js';

const PROJECT_ROOT = process.cwd();
const SRC_DIR = join(PROJECT_ROOT, 'src');
const RUNNER_FILE_REL = 'src/claude/runner.ts';

describe('SPEC §1.7 allowlist', () => {
  test('matches SPEC.md §1.7 exactly', () => {
    expect([...ALLOWED_TOOLS]).toEqual([
      'Read',
      'Grep',
      'Glob',
      'Edit',
      'Bash(npm test*)',
      'Bash(ui5lint*)',
      'Bash(eslint*)',
      'Bash(npx ui5*)',
    ]);
  });

  test('never contains any forbidden Bash pattern', () => {
    for (const forbidden of FORBIDDEN_TOOL_PATTERNS) {
      expect(ALLOWED_TOOLS.some((t) => t.startsWith(forbidden))).toBe(false);
    }
  });

  test('is frozen — accidental mutation throws', () => {
    expect(Object.isFrozen(ALLOWED_TOOLS)).toBe(true);
    expect(() => (ALLOWED_TOOLS as string[]).push('Bash(rm -rf /)')).toThrow();
  });

  test('forbidden-pattern list itself names the exact SPEC §1.7 deny set', () => {
    expect([...FORBIDDEN_TOOL_PATTERNS]).toEqual([
      'Bash(rm',
      'Bash(git push',
      'Bash(git commit',
    ]);
  });
});

describe('buildClaudeArgs', () => {
  test('produces args with the SPEC allowlist and required fields', () => {
    const args = buildClaudeArgs({ prompt: 'hello', cwd: '/work' });
    expect(args.prompt).toBe('hello');
    expect(args.cwd).toBe('/work');
    expect(args.outputFormat).toBe('json');
    expect(args.allowedTools).toBe(ALLOWED_TOOLS);
  });

  test('omits systemPrompt and signal when not provided (exactOptionalPropertyTypes)', () => {
    const args = buildClaudeArgs({ prompt: 'p', cwd: '/w' });
    expect('systemPrompt' in args).toBe(false);
    expect('signal' in args).toBe(false);
  });

  test('threads systemPrompt and signal when provided', () => {
    const controller = new AbortController();
    const args = buildClaudeArgs({
      prompt: 'p',
      cwd: '/w',
      systemPrompt: 'sys',
      signal: controller.signal,
    });
    expect(args.systemPrompt).toBe('sys');
    expect(args.signal).toBe(controller.signal);
  });

  test('input type does not expose allowedTools — caller cannot override', () => {
    // Compile-time check: BuildClaudeArgsInput has no allowedTools field.
    // We assert at runtime that the returned allowlist is exactly ALLOWED_TOOLS.
    const args = buildClaudeArgs({ prompt: 'p', cwd: '/w' });
    expect(args.allowedTools).toEqual([...ALLOWED_TOOLS]);
  });

  test('V1.9.4 PERF-17: omits model when not provided (byte-identical to today)', () => {
    const args = buildClaudeArgs({ prompt: 'p', cwd: '/w' });
    expect('model' in args).toBe(false);
  });

  test('V1.9.4 PERF-17: threads a user-supplied model verbatim when provided', () => {
    const args = buildClaudeArgs({ prompt: 'p', cwd: '/w', model: 'user-model-id' });
    expect(args.model).toBe('user-model-id');
  });
});

describe('V1.9.4 PERF-7 — per-call tool subset (`tools`), §1.7 narrow-only', () => {
  test('unset `tools` keeps the full §1.7 allowlist, byte-identical to today (same reference)', () => {
    const args = buildClaudeArgs({ prompt: 'p', cwd: '/w' });
    // Reference equality: an unset `tools` must not allocate a new array — the
    // argv (and thus the cached prefix) stays exactly as before this feature.
    expect(args.allowedTools).toBe(ALLOWED_TOOLS);
  });

  test('a narrowed subset is forwarded verbatim as the per-call allowlist', () => {
    const args = buildClaudeArgs({
      prompt: 'p',
      cwd: '/w',
      tools: ['Read', 'Grep', 'Glob'],
    });
    expect([...args.allowedTools]).toEqual(['Read', 'Grep', 'Glob']);
  });

  // THE load-bearing fail-on-revert guard (diagnosis §5, R4): without the
  // subset assertion, `tools` would be a §1.7 escape hatch — any caller could
  // WIDEN the allowlist past the SPEC set (e.g. re-introduce `Bash(rm*)`) by
  // routing it through the optional param. Reverting the assertion turns each
  // of these green-on-throw cases into a silent build of an over-broad grant.
  test('throws when ANY `tools` entry is outside ALLOWED_TOOLS (a forbidden Bash tool)', () => {
    expect(() =>
      buildClaudeArgs({ prompt: 'p', cwd: '/w', tools: ['Read', 'Bash(rm -rf /)'] }),
    ).toThrow(/not in the SPEC §1\.7 allowlist/);
  });

  test('throws on an unknown tool name not present in the allowlist', () => {
    expect(() =>
      buildClaudeArgs({ prompt: 'p', cwd: '/w', tools: ['WebFetch'] }),
    ).toThrow(/not in the SPEC §1\.7 allowlist/);
  });

  test('throws even when only ONE of several entries escapes the allowlist', () => {
    expect(() =>
      buildClaudeArgs({
        prompt: 'p',
        cwd: '/w',
        tools: ['Read', 'Grep', 'Bash(git push origin main)'],
      }),
    ).toThrow();
  });

  test('accepts every single-element subset drawn from ALLOWED_TOOLS (no false positive)', () => {
    for (const tool of ALLOWED_TOOLS) {
      expect(() => buildClaudeArgs({ prompt: 'p', cwd: '/w', tools: [tool] })).not.toThrow();
    }
  });

  test('accepts the full allowlist passed explicitly (the boundary subset = the set itself)', () => {
    expect(() =>
      buildClaudeArgs({ prompt: 'p', cwd: '/w', tools: [...ALLOWED_TOOLS] }),
    ).not.toThrow();
  });
});

describe('V1.9.4 PERF-17 — no model id pinned in src/ (CLAUDE.md "no model ID in code")', () => {
  // Decision §11.8(a): the `--model` flag AND the opt-in menu both stay
  // free-form — zero model names anywhere in `src/`. The binary picks the
  // default when no `--model` is forwarded. This is the fail-on-revert guard:
  // a hardcoded default (`model = 'claude-…'`) or a named menu alias
  // (`'sonnet'` / `'haiku'`) as a string literal turns this red.
  const MODEL_ID_LITERAL = /['"`](?:claude-[a-z0-9.\-]+|opus|sonnet|haiku)['"`]/i;

  test('no src/*.ts file contains a quoted model-id / alias literal', () => {
    const offenders: Array<{ readonly file: string; readonly snippet: string }> = [];
    for (const file of walkTs(SRC_DIR)) {
      const contents = readFileSync(file, 'utf8');
      const m = MODEL_ID_LITERAL.exec(contents);
      if (m !== null) {
        offenders.push({
          file: relative(PROJECT_ROOT, file).replace(/\\/g, '/'),
          snippet: m[0],
        });
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the guard regex is not vacuous — it matches a hypothetical pinned id', () => {
    // Sanity: were a default ever hardcoded, the pattern above would catch it.
    expect(MODEL_ID_LITERAL.test("const DEFAULT = 'claude-opus-4-8';")).toBe(true);
    expect(MODEL_ID_LITERAL.test("model: 'sonnet'")).toBe(true);
    expect(MODEL_ID_LITERAL.test("model: 'haiku'")).toBe(true);
    // ...and does NOT flag the legitimate binary name or prose.
    expect(MODEL_ID_LITERAL.test("file: 'claude'")).toBe(false);
    expect(MODEL_ID_LITERAL.test('// the binary picks the default model')).toBe(false);
  });
});

describe('DoD #12 — literal `allowedTools` is forbidden outside runner.ts', () => {
  test('no src/ file other than src/claude/runner.ts mentions `allowedTools` as a property assignment', () => {
    const offenders: string[] = [];
    for (const file of walkTs(SRC_DIR)) {
      const rel = relative(PROJECT_ROOT, file).replace(/\\/g, '/');
      if (rel === RUNNER_FILE_REL) continue;
      const contents = readFileSync(file, 'utf8');
      // The allowlist concern is property assignments like `allowedTools: ...`
      // and shorthand object keys. Field references like `args.allowedTools`
      // are reads and are fine.
      if (/(^|[^.\w])allowedTools\s*:/m.test(contents)) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });
});

function* walkTs(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      yield* walkTs(full);
    } else if (st.isFile() && full.endsWith('.ts')) {
      yield full;
    }
  }
}
