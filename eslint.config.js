import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Process boundaries from CLAUDE.md §3.1, enforced as import restrictions.
const restrict = (patterns) => ({
  'no-restricted-imports': ['error', { patterns }],
});

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/out/**', '**/dist/**', '**/release/**', '.feature-map/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', ignoreRestSiblings: true }],
      'no-empty': ['error', { allowEmptyCatch: false }],
    },
  },
  {
    files: ['packages/core/**/*.ts'],
    rules: restrict([
      { group: ['electron', 'electron/*'], message: 'core must stay free of Electron (ADR 012).' },
      {
        group: ['playwright', 'playwright-core', 'playwright/*'],
        message: 'core must not drive the browser.',
      },
      {
        group: ['@tabreach/browser-worker', '@tabreach/browser-worker/*'],
        message: 'core talks to the worker only via protocol.',
      },
    ]),
  },
  {
    files: ['packages/browser-worker/**/*.ts'],
    rules: restrict([
      {
        group: ['node:sqlite', '@tabreach/core', '@tabreach/core/*'],
        message: 'browser-worker has no database access.',
      },
      {
        group: ['electron', 'electron/*'],
        message: 'browser-worker talks to its host only through the host adapter.',
      },
    ]),
  },
  {
    files: ['packages/protocol/**/*.ts', 'packages/adapter-packs/**/*.ts'],
    rules: restrict([
      {
        group: [
          '@tabreach/core',
          '@tabreach/browser-worker',
          'electron',
          'playwright',
          'playwright/*',
          'playwright-core',
          'node:sqlite',
        ],
        message: 'shared packages carry contracts only.',
      },
    ]),
  },
  {
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    rules: restrict([
      {
        group: [
          '@tabreach/core',
          '@tabreach/core/*',
          '@tabreach/browser-worker',
          '@tabreach/browser-worker/*',
        ],
        message: 'renderer imports only @tabreach/protocol.',
      },
      {
        group: ['electron', 'node:*', 'playwright', 'playwright/*', 'playwright-core'],
        message: 'renderer is sandboxed UI code.',
      },
    ]),
  },
  {
    files: ['apps/desktop/src/main/**/*.ts', 'apps/desktop/src/preload/**/*.ts'],
    rules: restrict([
      {
        group: ['node:sqlite', 'playwright', 'playwright/*', 'playwright-core'],
        message: 'main is a supervisor: no DB, no Playwright.',
      },
    ]),
  },
);
