import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import nextPlugin from '@next/eslint-plugin-next'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['.next', 'out', 'dist', '.layer', 'public/branding']),
  {
    files: ['**/*.{js,jsx,mjs}'],
    extends: [js.configs.recommended, reactHooks.configs.flat.recommended],
    plugins: { '@next/next': nextPlugin },
    languageOptions: {
      ecmaVersion: 2020,
      // The UI reads no process.env (its settings are /config.json, read at
      // run time), but Next's own code and config files still may.
      globals: { ...globals.browser, process: 'readonly' },
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
      // Every image is a IIIF URL on another host, already sized by its Image
      // API; next/image would resize each one through a server, and a static
      // export has none.
      '@next/next/no-img-element': 'off',
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]' }],
    },
  },
  {
    // Config files and scripts run in Node.
    files: ['*.config.{js,mjs}', 'scripts/**/*.{js,mjs}'],
    languageOptions: { globals: globals.node },
  },
])
