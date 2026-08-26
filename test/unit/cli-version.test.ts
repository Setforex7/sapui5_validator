import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { program } from '../../src/cli.js';

// Regression test for Bug 8 (v0.2.1): src/cli.ts hard-coded `.version('0.1.0')`,
// so `sapui5-validate --version` drifted from package.json silently. The version
// must now come from package.json — see CLAUDE.md "Avoid hard-coded values".
describe('cli: --version reports the package.json version', () => {
  test('the configured CLI version matches package.json exactly', () => {
    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
    ) as { version: string };

    // commander's `.version()` getter returns whatever was passed to the
    // setter — this is the exact string `--version` prints, no subprocess.
    expect(program.version()).toBe(pkg.version);
  });
});
