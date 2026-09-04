import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const authoredJavaScript = ["**/*.{js,cjs,mjs}"];
const authoredNodeTypeScript = ["packages/**/*.ts", "scripts/**/*.ts", "test/**/*.ts"];
const authoredDashboardTypeScript = ["dashboard/src/**/*.{ts,tsx}"];
const authoredTypeScript = [...authoredNodeTypeScript, ...authoredDashboardTypeScript];
const [typescriptBase, typescriptEslintRecommended, typescriptRecommended] =
  tseslint.configs.recommended;

export default [
  {
    ignores: [
      ".agents/**",
      ".forge/**",
      "dashboard/dist/**",
      "dist/**",
      "node_modules/**",
      "dashboard/node_modules/**",
      "plugin/ForgeStudioPlugin.rbxmx",
      "packages/studio-evidence/catalog/**",
      "packages/studio-evidence/manifest/**",
      "packages/studio-evidence/src/generated.ts",
      "packages/studio-evidence/src/roblox-api-catalog.generated.ts",
      "plugin/src/Forge/GeneratedStudioEvidence.luau",
    ],
  },
  {
    files: authoredJavaScript,
    ...eslint.configs.recommended,
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node,
    },
  },
  {
    files: authoredTypeScript,
    languageOptions: {
      ...typescriptBase.languageOptions,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: typescriptBase.plugins,
    rules: {
      ...typescriptEslintRecommended.rules,
      ...typescriptRecommended.rules,
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          ignoreRestSiblings: true,
          varsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: authoredNodeTypeScript,
    languageOptions: { globals: globals.node },
  },
  {
    files: authoredDashboardTypeScript,
    languageOptions: { globals: globals.browser },
  },
];
