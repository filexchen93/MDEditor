import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@mdeditor/document-session": fileURLToPath(
        new URL("./packages/document-session/src/index.ts", import.meta.url),
      ),
      "@mdeditor/editor-core": fileURLToPath(
        new URL("./packages/editor-core/src/index.ts", import.meta.url),
      ),
      "@mdeditor/markdown": fileURLToPath(
        new URL("./packages/markdown/src/index.ts", import.meta.url),
      ),
      "@mdeditor/plugin-api": fileURLToPath(
        new URL("./packages/plugin-api/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["packages/**/*.test.ts", "tests/**/*.test.ts"],
    exclude: ["tests/e2e/**", "**/node_modules/**", "**/dist/**"],
    coverage: {
      reporter: ["text", "html"],
    },
  },
});
