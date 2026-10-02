import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import nextPlugin from '@next/eslint-plugin-next'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['.next', 'out', 'dist']),
  {
    files: ['**/*.{js,jsx,mjs}'],
    extends: [js.configs.recommended, reactHooks.configs.flat.recommended],
    plugins: { '@next/next': nextPlugin },
    languageOptions: {
      ecmaVersion: 2020,
      // Next inlines process.env.NEXT_PUBLIC_* at build time, in the browser
      // bundle too, so `process` is a global everywhere here.
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
      // API; next/image would route each one through our server to resize it.
      '@next/next/no-img-element': 'off',
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]' }],
    },
  },
  {
    // Config files run in Node.
    files: ['*.config.{js,mjs}'],
    languageOptions: { globals: globals.node },
  },
])
