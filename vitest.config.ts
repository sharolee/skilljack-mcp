import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "admin/**/*.test.ts"],
    // Upstream tests exercise the unfiltered contract. The fork enables the
    // resource filter by default; the new resource-filter.test.ts opts in
    // explicitly so both behaviours stay covered.
    // Upstream catalog tests expect the flat <available_skills> list. Domain
    // routing is opt-in per test via domain-router.test.ts / an explicit map;
    // disable the repo-root domains.json default for the rest of the suite.
    env: { SKILLJACK_RESOURCE_FILTER: "off", SKILLJACK_DOMAIN_MAP: "off" },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/ui/**", "src/**/*.test.ts", "src/__fixtures__/**", "src/__test-helpers__/**"],
      reporter: ["text", "lcov"],
    },
    restoreMocks: true,
    mockReset: true,
  },
});
