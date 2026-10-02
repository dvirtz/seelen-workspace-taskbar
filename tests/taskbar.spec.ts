import { test, expect } from "./fixtures/index.js";
import { widgetId } from "./fixtures/seelen.js";

test("the live Seelen taskbar has initialized", { tag: "@smoke" }, async ({ taskbars }) => {
  // Check every discovered monitor instance without changing desktop state.
  for (const taskbar of taskbars) {
    const { page } = taskbar;
    await test.step(`Check taskbar: ${page.url()}`, async () => {
      await expect(page.locator("#workspace-badge")).toHaveText(/\S/);
      await expect(page.locator("#workspace-badge")).not.toHaveText("—");
      await expect(page.locator("#task-items")).toHaveAttribute("role", "toolbar");
      // Auto-hide may move the whole bar offscreen, so inspect its rendered
      // contents rather than requiring the overlay to be visible.
      await expect.poll(() => page.evaluate(() => {
        const items = document.querySelectorAll("#task-items > button");
        const empty = document.querySelector<HTMLElement>("#empty-state");
        return items.length > 0
          ? empty?.hidden === true
          : empty?.hidden === false && empty.textContent === "No windows here yet";
      })).toBe(true);
    });
  }
});

test("taskbars occupy the bottom of their monitors and show scoped window counts", async ({ taskbars }) => {
  const ids: string[] = [];
  for (const taskbar of taskbars) {
    const { page, seelen } = taskbar;
    const id = await seelen.monitorId();
    ids.push(id);
    const monitor = (await seelen.monitors()).find(monitor => monitor.id === id)!;
    const rect = await page.evaluate(async () => {
      const widget = window.__SLU_WIDGET_INSTANCE;
      return { position: await widget.window.innerPosition(), size: await widget.window.innerSize(), ready: widget.isReady };
    });
    expect(rect.ready).toBe(true);
    expect(rect.position.x).toBe(monitor.rect.left);
    expect(rect.position.y + rect.size.height).toBe(monitor.rect.bottom);
    expect(rect.size.width).toBe(monitor.rect.right - monitor.rect.left);
    expect(rect.size.height).toBe(Math.round(280 * monitor.scaleFactor));
    await taskbar.checkWindowCount();
    for (const button of await page.locator("#task-items > button").all()) {
      await expect(button).toHaveAttribute("aria-label", /.+; right-click for pin options/);
      await expect(button.locator(".task-icon img, .task-icon-fallback")).toHaveCount(1);
    }
  }
  expect(new Set(ids).size).toBe(ids.length);
  // Disabled monitor instances are intentionally absent.
  const current = await taskbars[0].seelen.settings();
  const expected = (await taskbars[0].seelen.monitors()).filter(monitor =>
    (current.monitorsV3[monitor.id]?.byWidget[widgetId]?.enabled ?? current.byWidget[widgetId]?.enabled ?? true));
  expect(ids.sort()).toEqual(expected.map(monitor => monitor.id).sort());
});

test("width settings are applied per monitor and survive a reload", async ({ desktop, taskbar, seelen }) => {
  const { page } = desktop;
  const others = await Promise.all(desktop.taskbars.filter(candidate => candidate !== taskbar).map(async other =>
    ({ page: other.page, mode: await other.page.locator("#workspace-taskbar").getAttribute("data-mode") })));
  for (const mode of ["Full Width", "Minimal"]) {
    await seelen.configure({ mode });
    await expect(page.locator("#workspace-taskbar")).toHaveAttribute("data-mode", mode);
    await expect.poll(async () => {
      const surface = await page.locator(".taskbar-surface").boundingBox();
      return Math.round(surface!.width);
    }).toBeGreaterThan(0);
    if (mode === "Full Width") {
      const width = await page.locator("#workspace-taskbar").evaluate(element => {
        const style = getComputedStyle(element);
        return Math.round(element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
      });
      await expect.poll(async () => Math.round((await page.locator(".taskbar-surface").boundingBox())!.width)).toBe(width);
    }
    await page.reload();
    await expect(page.locator("#workspace-taskbar")).toHaveAttribute("data-mode", mode);
    for (const other of others) await expect(other.page.locator("#workspace-taskbar")).toHaveAttribute("data-mode", other.mode!);
  }
});

test("auto-hide modes and native hitboxes respond to real pointer and overlap", async ({ desktop, seelen }) => {
  const { page, title, native } = desktop;
  const id = await seelen.monitorId();
  const monitor = (await seelen.monitors()).find(entry => entry.id === id)!;
  const helper = (await seelen.windows()).find(win => win.title.startsWith(title))!;
  const root = page.locator("#workspace-taskbar");
  const x = Math.round((monitor.rect.left + monitor.rect.right) / 2);
  await native("bounds", String(helper.hwnd), String(monitor.rect.left), String(monitor.rect.bottom - 300),
    String(monitor.rect.right - monitor.rect.left), "300");
  await seelen.invoke("weg_toggle_window_state", { hwnd: helper.hwnd, wasFocused: false });
  await native("cursor", String(x), String(monitor.rect.top + 20));

  await seelen.configure({ hideMode: "Never" });
  await expect(root).not.toHaveClass(/is-hidden/);
  // Native WindowFromPoint must pass through the transparent part of the WebView.
  await native("cursor", String(x), String(monitor.rect.bottom - 150));
  await expect(async () => { await native("hit", String(x), String(monitor.rect.bottom - 150), String(helper.hwnd)); }).toPass({ timeout: 5000 });
  for (const hideMode of ["Always", "OnOverlap"]) {
    await seelen.configure({ hideMode });
    await expect(root).toHaveClass(/is-hidden/);
    await native("cursor", String(x), String(monitor.rect.bottom - 30));
    await expect(async () => { await native("hit", String(x), String(monitor.rect.bottom - 30), String(helper.hwnd)); }).toPass({ timeout: 5000 });
    // The physical bottom edge must reveal it again.
    await native("cursor", String(x), String(monitor.rect.bottom - 1));
    await expect(root).not.toHaveClass(/is-hidden/);
    await native("cursor", String(x), String(monitor.rect.top + 20));
    await expect(root).toHaveClass(/is-hidden/);
  }
  await seelen.configure({ hideMode: "Never" });
  await expect(root).not.toHaveClass(/is-hidden/);
});
