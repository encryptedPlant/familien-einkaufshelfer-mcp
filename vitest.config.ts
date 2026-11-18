import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Unit and storage integration tests only. Playwright specs live in e2e/
    // and use the .spec.ts suffix, so they are never picked up here.
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
