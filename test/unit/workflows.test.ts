/**
 * CI / release workflow invariants (CI-1..4). These parse the raw workflow
 * YAML as text — no yaml dependency — and assert the gates the V1.8 plan
 * requires, plus the safety invariant that the release workflow CANNOT fire
 * on a bare `git push` of a tag (0.9.0 is tagged-but-not-published).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const WORKFLOWS = join(process.cwd(), '.github', 'workflows');

function read(name: string): string {
  return readFileSync(join(WORKFLOWS, name), 'utf8');
}

/** Drop whole-line `#` comments so prose like "NOT `push:`" can't trip a match. */
function stripComments(yaml: string): string {
  return yaml
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
}

describe('CI workflow (CI-1..3 + test-tree typecheck gate)', () => {
  const ci = stripComments(read('ci.yml'));

  test('node matrix covers 20 and 22 (CI-1)', () => {
    const m = ci.match(/node:\s*\[([^\]]*)\]/);
    expect(m).not.toBeNull();
    const versions = (m?.[1] ?? '').split(',').map((s) => s.trim());
    expect(versions).toContain('20');
    expect(versions).toContain('22');
  });

  test('runs the production-only audit gate (CI-2)', () => {
    expect(ci).toMatch(/npm audit --omit=dev/);
  });

  test('runs the packaging smoke-test (CI-3)', () => {
    expect(ci).toMatch(/npm pack --dry-run/);
  });

  test('runs the test-tree typecheck gate', () => {
    expect(ci).toMatch(/npm run typecheck:test/);
  });
});

describe('Release workflow (CI-4) — wired, but cannot fire on a bare tag push', () => {
  const release = stripComments(read('release.yml'));

  test('triggers on a published GitHub Release, never on push/tags', () => {
    expect(release).toMatch(/^on:/m);
    expect(release).toMatch(/release:/);
    expect(release).toMatch(/types:\s*\[\s*published\s*\]/);
    // The safety invariant: a bare `git push` of the v0.9.0 tag must NOT
    // publish. No `push:` trigger and no `tags:` filter anywhere in the YAML.
    expect(release).not.toMatch(/^\s*push:/m);
    expect(release).not.toMatch(/tags:/);
  });

  test('publishes with provenance and public access', () => {
    expect(release).toMatch(/npm publish[^\n]*--provenance/);
    expect(release).toMatch(/--access public/);
  });

  test('grants id-token: write for OIDC provenance', () => {
    expect(release).toMatch(/id-token:\s*write/);
  });

  test('re-runs the test suite before publishing', () => {
    const publishIdx = release.indexOf('run: npm publish');
    const testIdx = release.indexOf('run: npm test');
    expect(testIdx).toBeGreaterThan(-1);
    expect(publishIdx).toBeGreaterThan(-1);
    expect(testIdx).toBeLessThan(publishIdx);
  });
});
