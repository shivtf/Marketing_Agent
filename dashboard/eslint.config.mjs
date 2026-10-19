// Lint for the dashboard: `npm run lint` (CI runs it on every push; ../.github/workflows/ci.yml).
// Next.js's own rules (React, hooks, accessibility, Next pitfalls), through the compatibility layer ESLint 9 needs.
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlatCompat } from '@eslint/eslintrc';

const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });

const config = [
  { ignores: ['.next/**', 'node_modules/**', 'out/**'] },
  ...compat.extends('next/core-web-vitals'),
];

export default config;
