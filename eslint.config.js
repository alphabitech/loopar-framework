import react from "eslint-plugin-react";
import prettier from "eslint-config-prettier";
import tsParser from "@typescript-eslint/parser";

export default [
  {
    ignores: ["dist/**", ".cache/**", "public/**", "**/node_modules/**", "**/*.esm.js"],
  },
  prettier,
  {
    plugins: { react },
    rules: {
      "react/jsx-key": "off",
    },
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: { parser: tsParser },
  },
];
