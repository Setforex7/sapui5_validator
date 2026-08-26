/**
 * Re-seed the deliberate-break files of each fixture under
 * `test/fixtures/<name>/`. The fixtures themselves are static and checked in;
 * this script restores them after a run that mutated them (e.g. the
 * `validate` end-to-end test that auto-applies LLM fixes — coming in a
 * later session).
 *
 * Mechanism: each fixture may contain a `.seed/` directory whose layout
 * mirrors the fixture root. Every file under `.seed/` is copied on top of
 * the fixture, overwriting the working copy. Fixtures with no `.seed/`
 * overlay (the Session-5 baseline) are reported as "0 file(s) re-seeded".
 *
 * Run with:  npx tsx scripts/prepare-fixture.ts
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const FIXTURES_DIR = resolve(process.cwd(), 'test', 'fixtures');
const SEED_DIR_NAME = '.seed';

function* walkFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) yield* walkFiles(full);
    else if (st.isFile()) yield full;
  }
}

function reseedFixture(fixtureDir: string): { restored: number } {
  const seedDir = join(fixtureDir, SEED_DIR_NAME);
  if (!existsSync(seedDir)) return { restored: 0 };
  let restored = 0;
  for (const seedFile of walkFiles(seedDir)) {
    const rel = relative(seedDir, seedFile);
    const target = join(fixtureDir, rel);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(seedFile, target);
    restored += 1;
  }
  return { restored };
}

function main(): void {
  if (!existsSync(FIXTURES_DIR)) {
    process.stderr.write(`No fixtures dir at ${FIXTURES_DIR}\n`);
    process.exit(1);
  }
  const fixtures = readdirSync(FIXTURES_DIR).filter((name) =>
    statSync(join(FIXTURES_DIR, name)).isDirectory(),
  );
  for (const fixture of fixtures) {
    const { restored } = reseedFixture(join(FIXTURES_DIR, fixture));
    process.stdout.write(`[${fixture}] re-seeded ${restored.toString()} file(s)\n`);
  }
}

main();
