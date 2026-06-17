import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

export default [
  js.configs.recommended,
  prettier,
  {
    files: ["src/**/*.js", "scripts/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.jest,
      },
    },
    rules: {
      "no-unused-vars": "warn",
      "no-undef": "error",
      "no-empty": "off",
      "no-useless-assignment": "off",
      "no-console": "off",
      "preserve-caught-error": "off",
    },
  },
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.jest,
      },
    },
    rules: {
      "no-unused-vars": "warn",
      "no-undef": "off",
      "no-empty": "off",
      "no-useless-assignment": "off",
      "no-console": "off",
      "no-redeclare": "off",
      "preserve-caught-error": "off",
    },
  },
  {
    ignores: ["node_modules/", "docs/", "**/*.min.js", "coverage/"],
  },
];
