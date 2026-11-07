import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // dist: the build. .claude: local tool settings and session worktrees (whole copies of the repository).
  // server/pcb/footprints: KiCad's vendor files, copied as they are. scripts/bench-results: benchmark output.
  globalIgnores(['dist', '.claude', 'server/pcb/footprints', 'scripts/bench-results']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: { ...globals.browser, ...globals.node },
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]' }],
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactRefresh.configs.vite,
    ],
    // the two hook rules only: the rest of the plugin's preset checks code for the React Compiler, which this app
    // does not build with, and stops reading a component at its first finding
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // off: tsc reports unused names itself (noUnusedLocals in both tsconfigs)
      '@typescript-eslint/no-unused-vars': 'off',
      // an empty catch is how this code says "ignore it" (pointer capture already gone, a body that is not JSON)
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['server/**/*.ts', 'scripts/**/*.ts'],
    rules: {
      // off: the routes pass middleware typed for AuthRequest as any, and the checks stub fetch, storage and errors
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    files: ['dev/*.tsx'],
    rules: {
      // off: a dev page's entry renders itself and exports nothing, so there is nothing for fast refresh to keep
      'react-refresh/only-export-components': 'off',
    },
  },
])
