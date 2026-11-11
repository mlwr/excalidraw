import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/e2e/**/*.e2e.ts"],
    fileParallelism: false,
    testTimeout: 120000,
    hookTimeout: 60000,
  },
});
