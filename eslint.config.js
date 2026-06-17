const js = require("@eslint/js");
const prettier = require("eslint-config-prettier");
const globals = require("globals");
const tseslint = require("typescript-eslint");

module.exports = [
  js.configs.recommended,
  prettier,
  {
    files: ["src/**/*.js", "scripts/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
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
      sourceType: "commonjs",
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
