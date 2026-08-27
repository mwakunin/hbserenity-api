import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    // Every test file shares one Postgres database and truncates between
    // tests — running files in parallel would let them clobber each other.
    fileParallelism: false,
    globalSetup: ["./src/test/global-setup.ts"],
    env: {
      NODE_ENV: "test",
    },
  },
});
