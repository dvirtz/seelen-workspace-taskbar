import { defineConfig } from "@playwright/test";

import type { SeelenOptions } from "./tests/fixtures/index.js";

export default defineConfig<{}, SeelenOptions>({
  testDir: "./tests",
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    seelenCdpUrl: process.env.SEELEN_CDP_URL || "http://[::1]:9222",
  },
  workers: 1,
});
