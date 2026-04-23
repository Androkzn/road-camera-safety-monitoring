import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["../tests/fe/**/*.test.ts"],
    globals: true,
  },
});
