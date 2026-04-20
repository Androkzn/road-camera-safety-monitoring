import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier/flat";
import globals from "globals";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  react.configs.flat["jsx-runtime"],
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Compiler-oriented rules from eslint-plugin-react-hooks@7+; many
      // valid patterns (ref sync, reset-on-key effects, stable SSE callbacks)
      // fail these until the codebase opts into the React Compiler fully.
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/purity": "off",
      "react-hooks/refs": "off",
      "react-hooks/preserve-manual-memoization": "off",
      "react-refresh/only-export-components": "off",
      "react/button-has-type": "error",
    },
    settings: {
      react: { version: "detect" },
    },
  },
  eslintConfigPrettier,
);
