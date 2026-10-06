import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Node environment: the suite covers the pure JSON sanitizer that guards
    // the save path. No DOM or React harness is needed — the canvas and its
    // windows are exercised by hand in bb, not here.
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
