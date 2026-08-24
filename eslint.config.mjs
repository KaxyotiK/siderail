import js from "@eslint/js";

export default [
  { ignores: ["coverage/**", "node_modules/**"] },
  js.configs.recommended,
  {
    files: ["src/**/*.mjs", "scripts/**/*.mjs", "test/**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        Buffer: "readonly",
        console: "readonly",
        performance: "readonly",
        process: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        queueMicrotask: "readonly",
        setImmediate: "readonly",
        TextDecoder: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      "no-void": "error",
      "no-control-regex": "off",
      "no-empty": "off",
      "no-regex-spaces": "off",
      "no-useless-escape": "off"
    }
  }
];
