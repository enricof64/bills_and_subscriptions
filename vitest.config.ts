import { defineConfig } from "vitest/config";

/**
 * Test config, deliberately separate from vite.config.ts.
 *
 * Tests cover the pure logic (dates, matching, storage, grouping) and import
 * modules without rendering anything. The host surface storage.ts talks to
 * (ctx.api.storage) is faked in test/browser-globals.ts.
 *
 * @wealthfolio/addon-sdk resolves fine under Node's ESM loader, but its entry
 * evaluates `window` at module scope, and src/lib/sync.ts imports it for a
 * value (QueryKeys). test/setup.ts installs the browser globals before any test
 * module is imported, so no alias or deps.inline entry is needed for it.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    environment: "node",
    globals: false,
    setupFiles: ["./test/setup.ts"],
    restoreMocks: true,
  },
});
