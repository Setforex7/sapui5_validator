import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const ROOT = process.cwd();

interface TsConfigShape {
  exclude?: string[];
}
interface PkgShape {
  files?: string[];
  main?: string;
  bin?: Record<string, string>;
  author?: string;
  license?: string;
  repository?: { type?: string; url?: string };
  homepage?: string;
  bugs?: { url?: string };
  publishConfig?: { access?: string };
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

describe('packaging: fake-runner stays out of dist/ and the published tarball', () => {
  test('tsconfig.json excludes src/claude/fake-runner.ts from the build', () => {
    const tsconfig = readJson<TsConfigShape>(join(ROOT, 'tsconfig.json'));
    expect(tsconfig.exclude ?? []).toContain('src/claude/fake-runner.ts');
  });

  test('package.json `files` does not ship src/', () => {
    const pkg = readJson<PkgShape>(join(ROOT, 'package.json'));
    const files = pkg.files ?? [];
    for (const entry of files) {
      const normalized = entry.replace(/\\/g, '/');
      expect(normalized.startsWith('src/')).toBe(false);
      expect(normalized).not.toBe('src');
    }
  });

  test('package.json main points into dist/, not src/', () => {
    const pkg = readJson<PkgShape>(join(ROOT, 'package.json'));
    expect((pkg.main ?? '').startsWith('dist/')).toBe(true);
  });
});

describe('packaging: publish metadata (PKG-1..6)', () => {
  const pkg = readJson<PkgShape>(join(ROOT, 'package.json'));

  test('a LICENSE file exists and is the ISC license (PKG-1)', () => {
    const licensePath = join(ROOT, 'LICENSE');
    expect(existsSync(licensePath)).toBe(true);
    const text = readFileSync(licensePath, 'utf8');
    expect(text).toMatch(/ISC License/);
    expect(text).toMatch(/Copyright \(c\) \d{4}/);
    expect(pkg.license).toBe('ISC');
  });

  test('LICENSE is in the published `files` allowlist (PKG-1)', () => {
    expect(pkg.files ?? []).toContain('LICENSE');
  });

  test('sourcemaps are excluded from the published tarball (PKG-6)', () => {
    expect(pkg.files ?? []).toContain('!dist/**/*.map');
  });

  test('author is non-empty (PKG-2)', () => {
    expect((pkg.author ?? '').trim().length).toBeGreaterThan(0);
  });

  test('repository / homepage / bugs point at the source repo (PKG-3)', () => {
    expect(pkg.repository?.url ?? '').toMatch(/github\.com/);
    expect(pkg.homepage ?? '').toMatch(/github\.com/);
    expect(pkg.bugs?.url ?? '').toMatch(/github\.com/);
  });

  test('publishConfig.access is public (PKG-4)', () => {
    expect(pkg.publishConfig?.access).toBe('public');
  });

  test('the bin entry resolves into dist/ and carries the node shebang (PKG-5)', () => {
    expect((pkg.bin ?? {})['sapui5-validate']).toBe('dist/cli.js');
    // The source entry carries the shebang tsc preserves verbatim into the
    // emitted bin — asserting the source is build-state-independent.
    const srcEntry = readFileSync(join(ROOT, 'src', 'cli.ts'), 'utf8');
    expect(srcEntry.startsWith('#!/usr/bin/env node')).toBe(true);
    // When dist/ is present (post-build, e.g. in CI), the bin must carry it too.
    const distEntry = join(ROOT, 'dist', 'cli.js');
    if (existsSync(distEntry)) {
      expect(readFileSync(distEntry, 'utf8').startsWith('#!/usr/bin/env node')).toBe(true);
    }
  });
});
