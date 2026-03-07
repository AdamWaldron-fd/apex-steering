import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 60_000,
    globalSetup: "./src/helpers/global-setup.ts",
    include: ["src/tests/**/*.test.ts"],
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
