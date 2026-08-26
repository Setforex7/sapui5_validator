/**
 * SPEC §2.18: the validator's working directory (`.sapui5-validator/`) holds
 * the audit log and `report.json` and is never source-of-truth. We add it to
 * the project's `.gitignore` on first run **only if** `.gitignore` exists and
 * does not already mention the directory. We never create a `.gitignore` —
 * the user owns that file.
 *
 * The match is whitespace-tolerant and ignores leading slashes / trailing
 * slashes: any of `.sapui5-validator`, `.sapui5-validator/`, `/.sapui5-validator/`,
 * possibly preceded by `!` (negation) or `#` (commented) lines, all count as
 * "already mentioned" and trigger no write. A line whose only non-whitespace
 * is the directory name is what we *write*.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validatorDir, VALIDATOR_DIR } from './paths.js';
import { assertInsideProject } from './containment.js';

export type GitignoreOutcome =
  | { readonly kind: 'amended'; readonly path: string }
  | { readonly kind: 'already-present'; readonly path: string }
  | { readonly kind: 'no-gitignore' };

export async function ensureValidatorDirIgnored(
  projectRoot: string,
): Promise<GitignoreOutcome> {
  const gitignorePath = join(projectRoot, '.gitignore');
  if (!existsSync(gitignorePath)) return { kind: 'no-gitignore' };

  const current = await readFile(gitignorePath, 'utf8');
  if (mentionsValidatorDir(current)) {
    return { kind: 'already-present', path: gitignorePath };
  }

  // v0.8.1 V1: the root `.gitignore` can itself be a committed link out of
  // the tree — the amendment must not write through it.
  await assertInsideProject(gitignorePath, projectRoot);
  await writeFile(gitignorePath, withValidatorLineAppended(current), 'utf8');
  return { kind: 'amended', path: gitignorePath };
}

export type SelfScopedIgnoreOutcome =
  | { readonly kind: 'written'; readonly path: string }
  | { readonly kind: 'already-present'; readonly path: string };

/**
 * v0.8.1 V3 (SECURITY-QUALITY-AUDIT-v0.8.0): self-scoped audit-trail ignore.
 *
 * The root-`.gitignore` courtesy amend above writes nothing when the project
 * has no `.gitignore` — leaving `.sapui5-validator/` (full scanned source +
 * LLM transcripts under `last-run/`) silently git-trackable. Writing
 * `.sapui5-validator/.gitignore` containing `*` guarantees nothing inside the
 * tool's own directory is ever committed, on ANY project shape, without
 * touching the user's root `.gitignore`. The `*` matches the ignore file
 * itself, so the directory never dirties the clean-tree gate either.
 *
 * Both orchestrators call this before the first LLM/audit write. The
 * containment assert doubles as the run's up-front check that
 * `.sapui5-validator/` itself does not escape the project root (e.g. a
 * committed symlink) — on escape it throws, and the orchestrators abort
 * loudly rather than let every later audit/report write follow the link.
 *
 * An existing `.sapui5-validator/.gitignore` is left untouched ('already-
 * present'): it is either this tool's own previous write or a deliberate
 * user edit inside the tool's directory.
 */
export async function ensureSelfScopedIgnore(
  projectRoot: string,
): Promise<SelfScopedIgnoreOutcome> {
  const dir = validatorDir(projectRoot);
  const ignorePath = join(dir, '.gitignore');
  await assertInsideProject(ignorePath, projectRoot);
  if (existsSync(ignorePath)) return { kind: 'already-present', path: ignorePath };
  await mkdir(dir, { recursive: true });
  await writeFile(ignorePath, '*\n', 'utf8');
  return { kind: 'written', path: ignorePath };
}

/**
 * The exact append `ensureValidatorDirIgnored` performs. Shared with
 * {@link isExactValidatorAmendment} so the writer and the recognizer cannot
 * drift apart.
 */
function withValidatorLineAppended(content: string): string {
  return content.endsWith('\n') || content.length === 0
    ? `${content}${VALIDATOR_DIR}/\n`
    : `${content}\n${VALIDATOR_DIR}/\n`;
}

/**
 * R1.6 (AUDIT §5.6c): true iff `current` is byte-for-byte `previous` plus
 * the one line this tool appends. The clean-tree gate uses it to disregard
 * its own courtesy amendment from a previous run — any other edit (even
 * alongside the amendment) keeps the file dirty, preserving "the user owns
 * `.gitignore`".
 */
export function isExactValidatorAmendment(previous: string, current: string): boolean {
  return current === withValidatorLineAppended(previous);
}

function mentionsValidatorDir(content: string): boolean {
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (line.startsWith('#')) continue;
    // COR-11: recognize not just the exact directory line but any pre-existing
    // glob / anchored / parent pattern that already covers `.sapui5-validator`
    // (e.g. `.sapui5*`, `*-validator/`, `**/.sapui5-validator`). Without this,
    // a re-run sees the dir as un-ignored, re-amends `.gitignore`, and the
    // clean-tree gate then treats the tool's own append as a real user edit.
    // Over-recognition is intentionally safe: the self-scoped
    // `.sapui5-validator/.gitignore` guarantees containment regardless.
    if (patternCoversValidatorDir(line)) return true;
  }
  return false;
}

/**
 * True when a single `.gitignore` line, read as a gitignore pattern, would
 * ignore the `.sapui5-validator` directory at the repo root. Strips a leading
 * negation, a root anchor, a trailing directory slash, and a leading
 * double-star-slash prefix, then glob-matches the remaining single segment
 * against the directory name. A pattern with remaining path separators (e.g.
 * `sub/.sapui5-validator`) does not cover the root directory and returns false.
 */
function patternCoversValidatorDir(line: string): boolean {
  let p = line.replace(/^!/u, '').replace(/^\/+/u, '').replace(/\/+$/u, '');
  p = p.replace(/^\*\*\//u, '');
  if (p.length === 0 || p.includes('/')) return false;
  return globSegmentToRegExp(p).test(VALIDATOR_DIR);
}

/** Compile a single gitignore path-segment glob (`*`, `?`) to an anchored RegExp. */
function globSegmentToRegExp(segment: string): RegExp {
  let pattern = '';
  for (const ch of segment) {
    if (ch === '*') pattern += '[^/]*';
    else if (ch === '?') pattern += '[^/]';
    else pattern += ch.replace(/[.+^${}()|[\]\\]/gu, '\\$&');
  }
  return new RegExp(`^${pattern}$`, 'u');
}
