import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "scripts/**/*.test.ts"],
    environment: "node",
    // The Dwaar property tests run thousands of cases, each verifying a real
    // Ed25519 signature. That is deliberate -- the gate is the thing that must
    // not be wrong -- and it needs more than the 5s default.
    testTimeout: 60_000,
    globals: false,
    reporters: ["default"],
  },
});
