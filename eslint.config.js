import tseslint from 'typescript-eslint';

const baseRestrictedSyntax = [
  {
    selector: 'ExportDefaultDeclaration',
    message: 'Default exports are not allowed; use named exports (CLAUDE.md).',
  },
  {
    selector: 'TSAsExpression > TSAsExpression',
    message:
      "Double type assertions ('as unknown as') are not allowed; validate with zod instead (CLAUDE.md).",
  },
];

const allowedToolsRestrictedSyntax = [
  {
    selector: "Property[key.type='Identifier'][key.name='allowedTools']",
    message:
      'Construct ClaudeRunArgs via buildClaudeArgs() in src/claude/runner.ts; never assign allowedTools directly elsewhere (SPEC §1.7).',
  },
  {
    selector: "Property[key.type='Literal'][key.value='allowedTools']",
    message:
      'Construct ClaudeRunArgs via buildClaudeArgs() in src/claude/runner.ts; never assign allowedTools directly elsewhere (SPEC §1.7).',
  },
];

// V1.9.5 (INF-2) — mechanical containment tripwire. Every filesystem write
// under the scanned project must go through assertInsideProject()
// (src/util/containment.ts) before the write (CLAUDE.md); the blessed writer
// modules enumerated in the override below are the audited call sites that
// already do. Any OTHER src/ module calling a node:fs write API fails lint
// until the write is routed through a blessed writer or the module is added
// to the allowlist WITH a containment guard.
const FS_WRITE_CALL_NAMES =
  'writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync' +
  '|rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync|cp|cpSync' +
  '|rename|renameSync|copyFile|copyFileSync|symlink|symlinkSync|truncate|truncateSync';
const FS_WRITE_MESSAGE =
  'Filesystem writes in src/ are restricted to the blessed writer modules, each of which ' +
  'guards the target with assertInsideProject() (src/util/containment.ts) first. Route the ' +
  'write through one of them, or add this module to the eslint.config.js allowlist WITH a ' +
  'containment guard (CLAUDE.md; V1.9.5 INF-2).';
const fsWriteRestrictedSyntax = [
  {
    // Named-import call style: `writeFileSync(...)` — the only style src/ uses.
    selector: `CallExpression[callee.type='Identifier'][callee.name=/^(${FS_WRITE_CALL_NAMES})$/]`,
    message: FS_WRITE_MESSAGE,
  },
  {
    // Namespace/member call style: `fs.writeFileSync(...)`, `fs.promises.writeFile(...)`.
    selector: `CallExpression[callee.type='MemberExpression'][callee.property.name=/^(${FS_WRITE_CALL_NAMES})$/]`,
    message: FS_WRITE_MESSAGE,
  },
  // Accepted gap: an aliased import (`import { writeFileSync as w }`) or a
  // re-exported binding evades both call-site selectors; that idiom does not
  // exist in src/ and is caught in review.
];

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'test/fixtures/**',
      'eslint.config.js',
      'vitest.config.ts',
      '*.cjs',
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'test/**/*.ts', 'scripts/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-ignore': true,
          'ts-expect-error': 'allow-with-description',
          'ts-nocheck': true,
          'ts-check': false,
        },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-restricted-syntax': ['error', ...baseRestrictedSyntax],
    },
  },
  {
    // Forbid literal `allowedTools:` outside runner.ts so `buildClaudeArgs()`
    // remains the only sanctioned constructor of ClaudeRunArgs (SPEC §1.7).
    files: ['src/**/*.ts'],
    ignores: ['src/claude/runner.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...baseRestrictedSyntax,
        ...allowedToolsRestrictedSyntax,
      ],
    },
  },
  {
    // V1.9.5 (INF-2): the fs-write containment tripwire (see the
    // fsWriteRestrictedSyntax doc comment). Flat-config note: this LAST
    // matching block replaces the previous one's `no-restricted-syntax` for
    // ordinary src/ modules, so it re-lists the base + allowedTools entries.
    // The ignored files keep the PREVIOUS block's rules (base + allowedTools)
    // — they stay banned from `allowedTools:` and exempt only from the
    // fs-write ban. `src/claude/runner.ts` is ignored by both narrowing
    // blocks (it legitimately constructs `allowedTools`) and keeps the base
    // rules from the first block; it is not an fs writer today.
    files: ['src/**/*.ts'],
    ignores: [
      'src/claude/runner.ts',
      // The blessed writer modules — every write call in each is preceded by
      // an assertInsideProject() containment guard (enumerated V1.9.5 INF-2;
      // re-audit before extending this list):
      'src/audit/log.ts',
      // V1.9.8 — DetectionCache.persist(): assertInsideProject() on the cache
      // dir BEFORE mkdir and on the file before the write.
      'src/checks/cache.ts',
      'src/claude/binary-runner.ts',
      'src/commands/generate.ts',
      'src/commands/validate.ts',
      'src/generation/registration.ts',
      'src/generation/retry-loop.ts',
      'src/generation/templates/index.ts',
      'src/output/html.ts',
      'src/output/report.ts',
      'src/util/gitignore.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...baseRestrictedSyntax,
        ...allowedToolsRestrictedSyntax,
        ...fsWriteRestrictedSyntax,
      ],
    },
  },
);
