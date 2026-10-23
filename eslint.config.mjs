import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";

// Next.js's own rules (React, hooks, accessibility basics, its pitfalls) and
// TypeScript's recommended ones. `npm run lint` runs it, and so does CI.
const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });

const config = [
  { ignores: [".next/**", "out/**", "build/**", "node_modules/**", "data/**", "backups/**", "coverage/**", "next-env.d.ts"] },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      // `_` names something left out on purpose: a field dropped from a copy
      // (`const { secret: _, ...shown } = row`), an argument a signature needs.
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true }],
    },
  },
];

export default config;
