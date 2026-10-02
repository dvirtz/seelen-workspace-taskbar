import { test as base, expect } from "@playwright/test";
import type { Browser, PlaywrightWorkerArgs, TestInfo } from "@playwright/test";
import { Desktop } from "./desktop.js";
import { Taskbar } from "./taskbar.js";
import type { Seelen } from "./seelen.js";

export interface SeelenOptions {
  seelenCdpUrl: string;
}

interface Fixtures {
  taskbars: Taskbar[];
  taskbar: Taskbar;
  seelen: Seelen;
  desktop: Desktop;
}

// Seelen exposes CDP. Playwright Test's connectOptions expects a
// Playwright server, so this fixture connects with connectOverCDP().
async function browserFixture(
  { playwright, seelenCdpUrl }: Pick<PlaywrightWorkerArgs, "playwright"> & SeelenOptions,
  use: (browser: Browser) => Promise<void>,
) {
  const browser = await playwright.chromium.connectOverCDP(seelenCdpUrl, { timeout: 10_000 });
  try {
    await use(browser);
  } finally {
    // Disconnect without closing Seelen's existing pages or context.
    await browser.close();
  }
}

async function taskbarsFixture({ browser }: { browser: Browser }, use: (taskbars: Taskbar[]) => Promise<void>) {
  let taskbars: Taskbar[] = [];
  await expect.poll(async () => {
    taskbars = [];
    for (const page of browser.contexts().flatMap(context => context.pages())) {
      if (await page.locator("#workspace-taskbar").count()) taskbars.push(new Taskbar(page));
    }
    return taskbars.length;
  }, { message: "Load and enable Workspace Taskbar in Seelen first." }).toBeGreaterThan(0);
  await use(taskbars);
}

async function taskbarFixture({ taskbars }: Pick<Fixtures, "taskbars">, use: (taskbar: Taskbar) => Promise<void>) {
  // Prefer a monitor with multiple existing workspaces for isolation tests.
  const state = await taskbars[0].seelen.desktops();
  for (const taskbar of taskbars) {
    if (state.monitors[await taskbar.seelen.monitorId()].workspaces.flat().length > 1) {
      await use(taskbar);
      return;
    }
  }
  await use(taskbars[0]);
}

async function seelenFixture({ taskbar }: Pick<Fixtures, "taskbar">, use: (seelen: Seelen) => Promise<void>) {
  await use(taskbar.seelen);
}

/** Isolate interaction tests and restore desktop state even if setup or the test fails. */
async function desktopFixture(
  { taskbar, taskbars }: Pick<Fixtures, "taskbar" | "taskbars">,
  use: (desktop: Desktop) => Promise<void>,
  testInfo: TestInfo,
) {
  testInfo.setTimeout(90_000);
  const desktop = new Desktop(taskbar, taskbars);
  const snapshot = await desktop.capture(testInfo);
  desktop.application = await desktop.createApplication(snapshot.monitorId, testInfo);
  try {
    await desktop.prepare(snapshot, desktop.application);
    await use(desktop);
  } finally {
    await desktop.restore(snapshot, desktop.application);
  }
}

export const test = base.extend<Fixtures, SeelenOptions>({
  seelenCdpUrl: ["", { option: true, scope: "worker" }],
  browser: [browserFixture, { scope: "worker" }],
  taskbars: taskbarsFixture,
  taskbar: taskbarFixture,
  seelen: seelenFixture,
  desktop: desktopFixture,
});

export { expect };
