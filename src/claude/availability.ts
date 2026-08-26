import { exec } from '../util/exec.js';

export const MISSING_CLAUDE_MESSAGE =
  'Install: npm i -g @anthropic-ai/claude-code, then run `claude /login` to authenticate.';

export type ClaudeAvailability =
  | { readonly ok: true; readonly version: string }
  | { readonly ok: false; readonly reason: string; readonly message: string };

export interface AvailabilityProbeOptions {
  readonly binary?: string;
  readonly execImpl?: typeof exec;
}

/**
 * Probe whether the `claude` CLI is installed and runnable (SPEC.md §2.12).
 * Auth is not exercised here — that would burn an LLM call before the user
 * has consented to one. A non-zero exit code from `claude --version` is the
 * deterministic signal we hard-fail on. A logged-out (but installed) binary
 * passes this probe and surfaces later, on the first LLM call, as a
 * `ClaudeApiError` (per SPEC §2.12 — auth missing is NOT a startup hard-fail).
 */
export async function probeClaudeAvailability(
  options: AvailabilityProbeOptions = {},
): Promise<ClaudeAvailability> {
  const binary = options.binary ?? 'claude';
  const execImpl = options.execImpl ?? exec;
  const result = await execImpl(binary, ['--version']);
  if (!result.ok) {
    const reason = result.stderr.trim() || `\`${binary} --version\` exited ${result.exitCode}`;
    return { ok: false, reason, message: MISSING_CLAUDE_MESSAGE };
  }
  return { ok: true, version: result.stdout.trim() };
}

/**
 * TR-2 (V1.9.6): the `claude` CLI range this tool's `-p --output-format json`
 * envelope + stdin transport has been validated against — major `2`, floored at
 * the version the V1.9.6 transport probe verified. The envelope is an
 * unversioned external contract, so a version outside this range MIGHT carry an
 * envelope-shape drift (surfaced at call time as `envelope-contract-mismatch`).
 * This is ADVISORY: {@link claudeVersionWarning} warns, it never hard-fails — a
 * newer CLI is far more likely compatible than not, and blocking would strand
 * every user on a fresh install. The tested floor is documented in README.
 */
export const MIN_TESTED_CLAUDE_VERSION = '2.1.200';
const TESTED_CLAUDE_MAJOR = 2;
const MIN_TESTED_CLAUDE_SEMVER: readonly [number, number, number] = [2, 1, 200];

function parseClaudeSemver(version: string): readonly [number, number, number] | null {
  const m = version.match(/(\d+)\.(\d+)\.(\d+)/);
  if (m === null) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * TR-2 (V1.9.6): advisory compatibility check for a probed `claude --version`
 * string. Returns a warning line when the version is unparseable, on a different
 * major, or below {@link MIN_TESTED_CLAUDE_VERSION}; otherwise `null`. NEVER
 * throws and NEVER hard-fails — the caller writes the line to a warning stream
 * and proceeds. A minor/patch ABOVE the floor does not warn (newer is presumed
 * compatible; a real drift surfaces distinctly as `envelope-contract-mismatch`).
 */
export function claudeVersionWarning(version: string): string | null {
  const parsed = parseClaudeSemver(version);
  const range = `${TESTED_CLAUDE_MAJOR}.x (>= ${MIN_TESTED_CLAUDE_VERSION})`;
  if (parsed === null) {
    return (
      `Could not parse a version from the claude CLI ("${version}"); this tool is ` +
      `validated against ${range}. It will still run — but if a call fails with an ` +
      `envelope-contract error, an untested CLI version is the likely cause.`
    );
  }
  const [maj, min, pat] = parsed;
  const [tMaj, tMin, tPat] = MIN_TESTED_CLAUDE_SEMVER;
  const belowFloor =
    maj < tMaj || (maj === tMaj && (min < tMin || (min === tMin && pat < tPat)));
  if (maj !== TESTED_CLAUDE_MAJOR || belowFloor) {
    return (
      `The installed claude CLI is version ${version}; this tool is validated against ` +
      `${range}. It will still run — but if a call fails with an envelope-contract ` +
      `error, this version gap is the likely cause.`
    );
  }
  return null;
}
