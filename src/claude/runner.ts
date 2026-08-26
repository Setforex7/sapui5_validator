/**
 * ClaudeRunner is the sole indirection between the rest of the CLI and the
 * `claude` binary (SPEC.md §1.5). `buildClaudeArgs()` is the only sanctioned
 * way to construct `ClaudeRunArgs`: the §1.7 allowlist is hard-coded here and
 * an ESLint rule plus a grep test forbid the literal `allowedTools:` property
 * anywhere else in `src/`.
 */

export interface ClaudeRunArgs {
  readonly prompt: string;
  readonly systemPrompt?: string;
  readonly allowedTools: readonly string[];
  readonly cwd: string;
  readonly outputFormat: 'json';
  readonly signal?: AbortSignal;
  /**
   * V1.9.4 PERF-17 — additive-optional per-call model override. When set,
   * {@link BinaryRunner} appends `--model <model>` to the `claude -p` argv
   * (forwarding a USER-supplied id — never a value pinned in `src/`). When
   * UNSET the argv is byte-identical to today and the `claude` binary picks
   * the model, so CLAUDE.md's "no model ID in code" invariant holds (the
   * binary's own default is unchanged). Opting into a cheaper model
   * is a user trade: the verify gate still enforces every artifact, but on the
   * TS static-only lane (no karma) a weaker model can emit a shallow-but-
   * compiling test the static gate cannot catch — surfaced as a warning at the
   * opt-in menu (diagnosis §1 / approach (k)), never a silent default-down.
   */
  readonly model?: string;
}

/**
 * V1.9.4 PERF-1 — the token-usage block from a `claude -p --output-format json`
 * envelope's `usage`, normalised to camelCase. All four counts are needed to
 * reason about spend: the total billed input is
 * `inputTokens + cacheReadTokens + cacheCreationTokens` (the uncached
 * `inputTokens` is NOT the total — diagnosis §6), so a consumer that reads only
 * one field under-reports. Token counts are the primary metric; cost
 * (`ClaudeRunResult.totalCostUsd`) is a labelled estimate.
 */
export interface ClaudeUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
}

export interface ClaudeRunResult {
  readonly ok: boolean;
  readonly json: unknown;
  readonly raw: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly callId: string;
  /**
   * V1.9.4 PERF-1 — additive-optional observability surfaced from the envelope
   * (the schema already `.passthrough()`d these; the runner now forwards them).
   * Absent when the envelope carried none — never a zero placeholder, so a
   * presence-gated consumer can distinguish "no data" from "zero". `sessionId`
   * is captured for the Phase-4 per-worker session-resume work; `totalCostUsd`
   * is an estimate (may be null under Max → omitted here).
   */
  readonly usage?: ClaudeUsage;
  readonly totalCostUsd?: number;
  readonly numTurns?: number;
  readonly sessionId?: string;
}

export interface ClaudeRunner {
  run(args: ClaudeRunArgs): Promise<ClaudeRunResult>;
}

/**
 * SPEC.md §1.7 allowlist. Deviating from this set requires a SPEC change.
 * Forbidden under any circumstance: `Bash(rm*)`, `Bash(git push*)`,
 * `Bash(git commit*)`, any state-mutating command outside the project's
 * source folders.
 */
export const ALLOWED_TOOLS: readonly string[] = Object.freeze([
  'Read',
  'Grep',
  'Glob',
  'Edit',
  'Bash(npm test*)',
  'Bash(ui5lint*)',
  'Bash(eslint*)',
  'Bash(npx ui5*)',
]);

export const FORBIDDEN_TOOL_PATTERNS: readonly string[] = Object.freeze([
  'Bash(rm',
  'Bash(git push',
  'Bash(git commit',
]);

export interface BuildClaudeArgsInput {
  readonly prompt: string;
  readonly cwd: string;
  readonly systemPrompt?: string;
  readonly signal?: AbortSignal;
  /**
   * V1.9.4 PERF-17 — additive-optional user-supplied model id. Forwarded to
   * {@link ClaudeRunArgs.model} only when set; unset leaves the args (and the
   * resulting argv) byte-identical to the no-model path. `buildClaudeArgs`
   * stays a pure forwarder here — it never substitutes a default id, so `src/`
   * pins no model.
   */
  readonly model?: string;
  /**
   * V1.9.4 PERF-7 — additive-optional per-call tool list. When set it REPLACES
   * the default {@link ALLOWED_TOOLS} for this one call, but {@link
   * buildClaudeArgs} asserts it is a **subset** of the §1.7 allowlist: a call
   * site may only *narrow* the grant (e.g. a read-only findings check sending
   * `['Read','Grep','Glob']` — no `Edit`/`Bash`), never widen it. Any entry
   * outside {@link ALLOWED_TOOLS} throws, so this is not a §1.7 escape hatch.
   * Named `tools` (NOT `allowedTools`) so the eslint rule banning a literal
   * `allowedTools:` key outside this file still holds. Unset → the full
   * allowlist, byte-identical to today.
   */
  readonly tools?: readonly string[];
}

export function buildClaudeArgs(input: BuildClaudeArgsInput): ClaudeRunArgs {
  // V1.9.4 PERF-7 — resolve the per-call tool grant. Unset keeps the full §1.7
  // allowlist (by reference, so the args stay byte-identical to today).
  const tools = input.tools ?? ALLOWED_TOOLS;
  // §1.7 subset assertion (load-bearing — diagnosis §5 / R4). A per-call
  // `tools` list may only *narrow* the allowlist; any entry outside
  // ALLOWED_TOOLS would otherwise widen the §1.7 grant through this optional
  // param, turning it into an escape hatch (e.g. re-introducing `Bash(rm*)`).
  // Throw on the first out-of-set tool. When `tools` is unset every entry is
  // trivially in the set, so the default path never throws.
  for (const tool of tools) {
    if (!ALLOWED_TOOLS.includes(tool)) {
      throw new Error(
        `buildClaudeArgs: tool "${tool}" is not in the SPEC §1.7 allowlist; ` +
          'a per-call `tools` list may only narrow the allowlist, never widen it.',
      );
    }
  }
  const args: ClaudeRunArgs = {
    prompt: input.prompt,
    allowedTools: tools,
    cwd: input.cwd,
    outputFormat: 'json',
    ...(input.systemPrompt !== undefined ? { systemPrompt: input.systemPrompt } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
  };
  return args;
}
