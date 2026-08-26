/**
 * SPEC §2.5 — the TypeScript routing seam.
 *
 * History: this was a hard WALL — it globbed `webapp/**\/*.ts` and aborted the
 * run on any match. V1.9 Phase 0 (GA1-02) refactored it into a detection +
 * routing SEAM over {@link detectProjectLanguage}; **Phase 2 flips it per
 * command**:
 *
 *   - **`validate`** on a TS project now **PROCEEDS** via TS-aware discovery
 *     (GA1-01/04, the HB-2 guarantee) and the static-only verify lane
 *     (`ui5lint` + `tsc --noEmit` + config-gated `eslint`). The never-build
 *     firewall (`commands/validate.ts`) skips karma entirely, because
 *     karma-running a `.ts` would transpile it via the project's own
 *     `babel.config.js` = arbitrary code execution (the `TS-V1` boundary the
 *     CLI never crosses). The residual honest-refusal floor is the tooling
 *     probe (a TS project with no usable static toolchain — `ui5lint` absent —
 *     still refuses with `missing-required-tooling`, never a silent pass).
 *   - **`generate`** on a TS project now **PROCEEDS** too (V1.9.2 —
 *     TG-GUARD-LIFT): it emits `.qunit.ts` QUnit tests accepted STATIC-ONLY via
 *     the same lane (`ui5lint` + `tsc --noEmit` + config-gated `eslint`),
 *     **never karma** (the never-build firewall, at verify AND the baseline
 *     probe). QUnit-only this cycle (OPA5-for-TS is deferred). The §2.5 refusal
 *     is gone for both commands; the only TS floor left is the tooling probe
 *     (a TS project with no usable static linter still refuses).
 *
 * The command-routed flip is the single most dangerous change in the V1.9
 * cycle and is intentionally isolated to this one function.
 */

import { detectProjectLanguage } from './detect.js';
import type { ProjectLanguage } from './detect.js';

export const TS_REFUSAL_MESSAGE = 'TypeScript SAPUI5 support is planned for V2.';

export type TsGuardCommand = 'validate' | 'generate';

export type TsGuardResult =
  | { readonly ok: true; readonly language: ProjectLanguage }
  | { readonly ok: false; readonly tsFiles: readonly string[]; readonly message: string };

export interface TsGuardOptions {
  /**
   * The command being routed. `validate` proceeds for TS (the static-only
   * lane); `generate` still refuses (generate-for-TS is deferred to 1.1).
   * Required so every call site is explicit about which side of the flip it is
   * on — the JS path is identical for both (`ok: true`, `language: 'js'`).
   */
  readonly command: TsGuardCommand;
}

export async function checkTsGuard(
  projectRoot: string,
  options: TsGuardOptions,
): Promise<TsGuardResult> {
  const language = await detectProjectLanguage(projectRoot);
  if (language === 'js') return { ok: true, language: 'js' };
  // language === 'ts'
  if (options.command === 'validate') {
    // Phase-2 flip: validate proceeds through TS-aware discovery + the
    // static-only verify lane. Discovery is already TS-aware (GA1-01/04), so
    // the run enumerates real targets, not zero (the HB-2 guarantee).
    return { ok: true, language: 'ts' };
  }
  // generate: V1.9.2 (TG-GUARD-LIFT) — now PROCEEDS for TS, identical to the
  // `validate` branch above. Discovery is TS-aware (GA1-01/04), so the run
  // enumerates real `.qunit.ts` targets, not zero (the HB-DISC guarantee); the
  // never-build firewall keeps karma off the TS path at verify AND baseline
  // (SPEC §2.5/§2.10). The redundant return is intentional — it leaves the
  // `validate` branch above byte-identical while flipping only `generate`.
  return { ok: true, language: 'ts' };
}
