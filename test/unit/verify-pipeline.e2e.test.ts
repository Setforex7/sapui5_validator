/**
 * Real-toolchain smoke gated by VALIDATOR_E2E=1.
 *
 * Default test runs skip this file entirely (zero cost — no exec calls). When
 * VALIDATOR_E2E=1, it shells out to the actual ui5lint and eslint binaries
 * against the `minimal-project` fixture to confirm the verify pipeline talks
 * to the real toolchain correctly. Karma is NOT invoked here — spinning up
 * a real browser would slow CI and exceed scope per the Session 2 deviation.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { verifyArtifact } from '../../src/verify/pipeline.js';

const E2E = process.env['VALIDATOR_E2E'] === '1';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '..', 'fixtures', 'minimal-project');
const FIXTURE_HAS_DEPS = existsSync(join(FIXTURE, 'node_modules', '@ui5', 'linter'));

describe.skipIf(!E2E)('verifyArtifact — real ui5lint/eslint smoke', () => {
  test.skipIf(!FIXTURE_HAS_DEPS)(
    'invokes real ui5lint + eslint against minimal-project without throwing',
    async () => {
      const result = await verifyArtifact({
        projectRoot: FIXTURE,
        file: 'webapp/Component.js',
        eslintEnabled: true,
        // No testFiles → karma is skipped; the pipeline still exercises both
        // real lint binaries through preferLocal resolution.
      });
      // The fixture is intentionally seeded with break-marker comments, so
      // we don't assert `ok === true`. We do assert the pipeline produced a
      // structured result with at least the lint steps recorded.
      expect(Array.isArray(result.steps)).toBe(true);
      expect(result.steps.find((s) => s.step === 'ui5lint')).toBeDefined();
      expect(result.steps.find((s) => s.step === 'eslint')).toBeDefined();
      expect(result.steps.find((s) => s.step === 'karma')?.status).toBe('skipped');
    },
    60_000,
  );
});
