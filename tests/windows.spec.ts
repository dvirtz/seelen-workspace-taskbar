import { test, expect } from "./fixtures/index.js";

test("a running window can be focused, minimized and restored", async ({ desktop, taskbar, seelen }) => {
  const { page, title } = desktop;
  const button = await taskbar.helperButton(title);
  const hwnd = (await seelen.windows()).find(win => win.title.startsWith(title))!.hwnd;
  // Establish a known unfocused state; creating a native form need not activate it.
  await page.evaluate(() => window.__SLU_WIDGET_INSTANCE.focus());
  await expect(button).not.toHaveClass(/is-focused/);
  await button.click();
  await expect.poll(async () => (await seelen.invoke<{ hwnd: number }>("get_focused_app")).hwnd).toBe(hwnd);
  await expect(button).toHaveClass(/is-focused/);
  await button.click();
  await expect.poll(async () => (await seelen.windows()).find(win => win.hwnd === hwnd)?.isIconic).toBe(true);
  await button.click();
  await expect.poll(async () => (await seelen.windows()).find(win => win.hwnd === hwnd)?.isIconic).toBe(false);
});

test("shortcut launches group real windows and support focus, minimize and previews", async ({ desktop, taskbar, seelen }) => {
  const { page, title, program } = desktop;
  const label = `${title} launcher`;
  await taskbar.addShortcut(label, program, desktop.arguments(`${title} launched`, 2));
  expect((await taskbar.pins()).find(pin => pin.label === label)?.relaunch).toMatchObject({
    command: program, args: desktop.arguments(`${title} launched`, 2),
  });
  const button = taskbar.app(label);
  // The existing fixture window may match this executable, so launch after it exits.
  for (const win of (await seelen.windows()).filter(win => win.title.startsWith(title))) process.kill(win.process.id);
  await expect(button).not.toHaveClass(/is-open/);
  await button.click();
  await expect.poll(async () => (await seelen.windows()).filter(win => win.title.startsWith(`${title} launched`)).length,
    { timeout: 15_000 }).toBe(2);
  await expect(button.locator(".task-count")).toHaveText("2");
  await button.hover();
  const previews = page.locator("#window-previews");
  await expect(previews).toBeVisible();
  await expect(previews.locator("button")).toHaveCount(2);
  await expect.poll(async () => (await previews.locator(".preview-title").allTextContents()).sort())
    .toEqual([`${title} launched 1`, `${title} launched 2`]);
  const first = previews.locator("button").first();
  const hwnd = Number(await first.getAttribute("data-hwnd"));
  await first.click();
  await expect.poll(async () => (await seelen.invoke<{ hwnd: number }>("get_focused_app")).hwnd).toBe(hwnd);
  await expect(previews).toBeHidden();
  await button.click();
  await expect.poll(async () => (await seelen.windows()).find(win => win.hwnd === hwnd)?.isIconic).toBe(true);
  // With several windows, minimizing can focus another member of the group.
  // Select the minimized window explicitly to verify restoration.
  await button.hover();
  await previews.locator(`[data-hwnd="${hwnd}"]`).click();
  await expect.poll(async () => (await seelen.windows()).find(win => win.hwnd === hwnd)?.isIconic).toBe(false);
  await button.focus();
  await button.press("ArrowUp");
  await expect(previews).toBeVisible();
  await expect(previews.locator("button").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(previews).toBeHidden();
});

