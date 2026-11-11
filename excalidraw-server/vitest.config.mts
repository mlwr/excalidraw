import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // tests share one PostgreSQL database
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
