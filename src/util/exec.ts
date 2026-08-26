import { execa } from 'execa';

export interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeout?: number;
  signal?: AbortSignal;
  /**
   * When true, execa resolves the binary against `<cwd>/node_modules/.bin/`
   * before PATH and handles Windows extension resolution (.cmd/.exe). Used
   * by the verify adapters to invoke project-local ui5lint/eslint/karma.
   */
  preferLocal?: boolean;
}

/**
 * The {@link exec} function type. Canonical alias for the injectable exec
 * seam — adapters and the batched baseline-lint path accept an `ExecImpl` so
 * tests can supply a deterministic stub.
 */
export type ExecImpl = typeof exec;

export async function exec(
  file: string,
  args: readonly string[] = [],
  options: ExecOptions = {},
): Promise<ExecResult> {
  const startedAt = Date.now();
  try {
    const result = await execa(file, [...args], {
      reject: false,
      shell: false,
      stripFinalNewline: false,
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.input !== undefined ? { input: options.input } : {}),
      ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.preferLocal === true ? { preferLocal: true } : {}),
    });
    const exitCode = typeof result.exitCode === 'number' ? result.exitCode : -1;
    let stderr = toString(result.stderr);
    // Spawn failure (e.g. ENOENT — a missing binary): with `reject: false`
    // execa RESOLVES rather than throws, but the child never started, so it
    // carries NO numeric exit code and an EMPTY stderr STREAM — the diagnostic
    // lives on `result.shortMessage` instead. Surface it so a missing tool /
    // `claude` binary always carries a reason. Scoped to the no-exit-code case
    // so a normal non-zero exit with empty stderr is left untouched. (On Windows
    // the same failure is routed through a cmd shim that DOES write to the
    // stderr stream, so this fallback is not reached there — it is the Linux
    // path, which otherwise returned an empty stderr.)
    if (typeof result.exitCode !== 'number' && stderr.length === 0) {
      stderr = result.shortMessage ?? result.message ?? '';
    }
    return {
      ok: exitCode === 0 && result.failed !== true,
      stdout: toString(result.stdout),
      stderr,
      exitCode,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      ok: false,
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
      exitCode: -1,
      durationMs: Date.now() - startedAt,
    };
  }
}

function toString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
  return String(value);
}
