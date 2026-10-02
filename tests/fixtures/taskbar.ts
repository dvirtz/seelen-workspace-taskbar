import { expect, type Page, type Locator } from "@playwright/test";
import { Seelen } from "./seelen.js";

/** UI actions and assertions for one taskbar instance. */
export class Taskbar {
  readonly seelen: Seelen;

  constructor(readonly page: Page) {
    this.seelen = new Seelen(page);
  }

  app(label: string) {
    return this.page.getByRole("button", { name: `${label}; right-click for pin options`, exact: true });
  }

  async menu(button: Locator, action: string | RegExp) {
    await button.click({ button: "right" });
    await this.page.getByRole("menuitem", { name: action, exact: typeof action === "string" }).click();
  }

  async addShortcut(label: string, program = "C:\\Windows\\System32\\notepad.exe", args = "", workingDir = "") {
    await this.menu(this.page.locator("#task-items > button").first(), /^Pin shortcut/);
    const form = this.page.getByRole("form", { name: "Pin shortcut", exact: true });
    // Wait for openShortcutForm's asynchronous native focus before typing.
    await expect(form.getByLabel("Name", { exact: true })).toBeFocused();
    await form.getByLabel("Name", { exact: true }).fill(label);
    await form.getByLabel("Application or shortcut path").fill(program);
    await form.getByLabel("Arguments (optional)").fill(args);
    await form.getByLabel("Start in (optional)").fill(workingDir);
    // These are live desktop inputs; detect accidental user input before saving.
    await expect(form.getByLabel("Name", { exact: true })).toHaveValue(label);
    await expect(form.getByLabel("Application or shortcut path")).toHaveValue(program);
    await expect(form.getByLabel("Arguments (optional)")).toHaveValue(args);
    await expect(form.getByLabel("Start in (optional)")).toHaveValue(workingDir);
    await form.getByRole("button", { name: "Pin shortcut", exact: true }).click();
    await expect(this.app(label)).toBeAttached();
  }

  async pins() {
    const key = `pins:${await this.seelen.monitorId()}:${(await this.seelen.workspace()).id}`;
    return this.page.evaluate(key => JSON.parse(localStorage.getItem(key) || "[]") as Array<{
      key: string; label: string; path: string; relaunch: { command: string; args: string | string[] | null; workingDir: string | null };
    }>, key);
  }

  async helperButton(title: string) {
    const win = (await this.seelen.windows()).find(win => win.title.startsWith(title));
    expect(win, "Disposable test window is tracked by Seelen").toBeDefined();
    return this.app(win!.appName || win!.title);
  }

  async checkWindowCount() {
    await expect.poll(async () => {
      const state = await this.seelen.desktops();
      const active = await this.seelen.workspace();
      const id = await this.seelen.monitorId();
      const expected = (await this.seelen.windows()).filter(win => win.monitor === id &&
        (active.windows.includes(win.hwnd) || state.pinned.includes(win.hwnd))).length;
      return await this.page.locator("#task-items > .is-open").evaluateAll(buttons =>
        buttons.reduce((sum, button) => sum + Number(button.querySelector(".task-count")?.textContent || 1), 0)) - expected;
    }, { message: "Rendered counts must match the real monitor/workspace windows, including global pins." }).toBe(0);
  }
}
