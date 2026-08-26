/**
 * V1.9.2 (TG-ACCEPT / FS-6) — the tsconfig-scope guard for generate-for-TS.
 *
 * A generated `.qunit.ts` is accepted on `tsc --noEmit`, which `verify/tsc.ts`
 * runs project-wide (no file args) so it type-checks exactly the files inside
 * the project `tsconfig.json` `include` scope. If the generated test lands
 * OUTSIDE that scope, `tsc` silently ignores it and a "tsc passed" result proves
 * nothing about the test — a vacuous green. This module answers "would `tsc`
 * type-check this path?" so `commands/generate.ts` can fail CLOSED before
 * generating an unverifiable test, never trusting a scope-less static-only pass.
 *
 * It reads `tsconfig.json` itself (tolerant of JSONC comments + trailing commas)
 * rather than shelling out, follows one level of `extends`, and applies
 * TypeScript's `include`/`exclude`/`files` glob semantics. Every ambiguous case
 * (missing / unparseable config, a path outside the config directory, no
 * matching `include`) resolves to NOT covered — fail-closed is the safe default.
 *
 * No new dependency: `node:fs` / `node:path` + the existing comment stripper.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { stripJsComments } from './strip-js-comments.js';

// TypeScript's default `exclude` set, applied even when `include` matches.
const DEFAULT_EXCLUDES = ['node_modules', 'bower_components', 'jspm_packages'];

export interface TsconfigScope {
  /** True when a parseable `tsconfig.json` was found at the project root. */
  readonly found: boolean;
  /** The effective `include` globs (surfaced in the fail-closed message). */
  readonly include: readonly string[];
  /** Would `tsc` (project-wide) type-check `absPath`? Fail-closed on any doubt. */
  covers(absPath: string): boolean;
}

interface RawTsconfig {
  include?: unknown;
  exclude?: unknown;
  files?: unknown;
  extends?: unknown;
}

export function loadTsconfigScope(projectRoot: string): TsconfigScope {
  const cfg = readTsconfigChain(join(projectRoot, 'tsconfig.json'), 0);
  if (cfg === null) return { found: false, include: [], covers: () => false };

  const includeStrings = stringArray(cfg.include);
  const fileStrings = stringArray(cfg.files);
  const excludeStrings = stringArray(cfg.exclude);

  // TS rule: `include` present → use it; else if `files` present → ONLY those
  // files (no recursive default); else the implicit `**/*` under the config dir.
  const effectiveInclude =
    includeStrings !== null ? includeStrings : fileStrings !== null ? [] : ['**/*'];
  const includeMatchers = effectiveInclude.map(tsGlobToRegExp);
  const excludeMatchers = [...(excludeStrings ?? []), ...DEFAULT_EXCLUDES].map(
    tsGlobToRegExp,
  );
  const fileSet = new Set((fileStrings ?? []).map(normalizeRel));

  return {
    found: true,
    include: effectiveInclude,
    covers(absPath: string): boolean {
      const rel = toPosix(relative(projectRoot, resolve(absPath)));
      if (rel.length === 0 || rel.startsWith('..')) return false; // outside the config dir
      if (fileSet.has(rel)) return true;
      if (excludeMatchers.some((re) => re.test(rel))) return false;
      return includeMatchers.some((re) => re.test(rel));
    },
  };
}

/**
 * Read a `tsconfig.json` and merge one level of `extends` (relative path only)
 * for the keys this guard reads. Returns `null` on a missing or unparseable
 * config (→ fail-closed). A child that sets its own `include`/`files` is used
 * as-is; only a child that sets neither inherits the base's.
 */
function readTsconfigChain(tsconfigPath: string, depth: number): RawTsconfig | null {
  const parsed = parseTsconfig(tsconfigPath);
  if (parsed === null) return null;
  if (
    depth >= 1 ||
    typeof parsed.extends !== 'string' ||
    parsed.extends.length === 0 ||
    parsed.include !== undefined ||
    parsed.files !== undefined
  ) {
    return parsed;
  }
  const basePath = resolveExtends(dirname(tsconfigPath), parsed.extends);
  if (basePath === null) return parsed;
  const base = parseTsconfig(basePath);
  if (base === null) return parsed;
  return {
    include: base.include,
    files: base.files,
    exclude: parsed.exclude ?? base.exclude,
  };
}

function parseTsconfig(tsconfigPath: string): RawTsconfig | null {
  if (!existsSync(tsconfigPath)) return null;
  try {
    const raw = readFileSync(tsconfigPath, 'utf8');
    // Strip `//` and `/* */` comments (length-preserving, string-aware), then
    // drop trailing commas — both legal JSONC, both fatal to `JSON.parse`.
    const stripped = stripJsComments(raw).replace(/,(\s*[}\]])/gu, '$1');
    const value: unknown = JSON.parse(stripped);
    if (value === null || typeof value !== 'object') return null;
    return value as RawTsconfig;
  } catch {
    return null;
  }
}

function resolveExtends(baseDir: string, ext: string): string | null {
  // Only relative `extends` are followed; a bare package specifier would need
  // module resolution, so treat it as un-inheritable (fail-closed on the child).
  if (!ext.startsWith('.')) return null;
  const p = isAbsolute(ext) ? ext : join(baseDir, ext);
  return /\.json$/u.test(p) ? p : `${p}.json`;
}

function stringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  return v.filter((x): x is string => typeof x === 'string');
}

function normalizeRel(p: string): string {
  return toPosix(p).replace(/^\.\//u, '');
}

/**
 * Convert a TypeScript `include`/`exclude` glob to an anchored RegExp over a
 * POSIX project-relative path. A pattern with no wildcard and no file extension
 * is a directory → `/**​/*` is appended (TS includes the whole subtree). `**​/`
 * matches any depth, `*` matches within a segment, `?` one non-separator char.
 */
function tsGlobToRegExp(glob: string): RegExp {
  let g = normalizeRel(glob).replace(/\/$/u, '');
  const lastSeg = g.split('/').pop() ?? '';
  const hasWildcard = /[*?]/u.test(g);
  const looksLikeFile = /\.[A-Za-z0-9]+$/u.test(lastSeg);
  if (!hasWildcard && !looksLikeFile) {
    g = `${g}/**/*`;
  }
  let re = '';
  for (let i = 0; i < g.length; i += 1) {
    const c = g[i]!;
    if (c === '*') {
      if (g[i + 1] === '*') {
        if (g[i + 2] === '/') {
          re += '(?:[^/]*/)*';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/gu, '\\$&');
    }
  }
  return new RegExp(`^${re}$`, 'u');
}

function toPosix(p: string): string {
  return p.replace(/\\/gu, '/');
}
