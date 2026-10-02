import { expect, type TestInfo } from "@playwright/test";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { widgetId } from "./seelen.js";
import type { Taskbar } from "./taskbar.js";

const execFileAsync = promisify(execFile);

type DesktopSnapshot = Awaited<ReturnType<Desktop["capture"]>>;
type TestApplication = Awaited<ReturnType<Desktop["createApplication"]>>;

/** Saves and restores the real desktop around an interaction test. */
export class Desktop {
  application!: TestApplication;

  constructor(readonly taskbar: Taskbar, readonly taskbars: Taskbar[]) {}

  get title() { return this.application.title; }
  get program() { return this.application.program; }
  get arguments() { return this.application.arguments; }
  get native() { return this.application.native; }
  get startWindow() { return this.application.startWindow; }

  get page() { return this.taskbar.page; }
  get seelen() { return this.taskbar.seelen; }

  async capture(testInfo: TestInfo) {
    const id = await this.seelen.monitorId();
    const state = await this.seelen.desktops();
    // Seelen wraps Storage: keys are not enumerable and key() returns prefixed
    // names. Read the known logical keys through its getItem/setItem API instead.
    const storageKeys = state.monitors[id].workspaces.flat().flatMap(workspace =>
      [`pins:${id}:${workspace.id}`, `icon-layout:${id}:${workspace.id}`]);
    const snapshot = {
      monitorId: id,
      originalWorkspace: (await this.seelen.workspace()).id,
      originalSettings: (await this.seelen.settings()).monitorsV3[id]?.byWidget[widgetId],
      originalStorage: await this.readStorage(storageKeys),
      originalFocus: await this.seelen.invoke<{ hwnd: number }>("get_focused_app"),
      originalCursor: await this.seelen.invoke<[number, number]>("get_mouse_position"),
    };
    await testInfo.attach("original-desktop-state", {
      body: JSON.stringify(snapshot, null, 2), contentType: "application/json",
    });
    return snapshot;
  }

  private readStorage(keys: string[]) {
    return this.page.evaluate(keys => Object.fromEntries(keys.map(key => [key, localStorage.getItem(key)])), keys);
  }

  async createApplication(id: string, testInfo: TestInfo) {
    const seelen = this.seelen;
    const program = testInfo.outputPath("SeelenTestWindow.exe");
    await mkdir(testInfo.outputDir, { recursive: true });
    await execFileAsync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
      fileURLToPath(new URL("../support/build-window.ps1", import.meta.url)),
      "-Source", fileURLToPath(new URL("../support/Window.cs", import.meta.url)), "-Destination", program], { windowsHide: true });

    let cursorMoved = false;
    const native = async (...args: string[]) => {
      if (args[0] === "cursor") cursorMoved = true;
      await execFileAsync(program, args, { windowsHide: true });
    };
    try { await native("desktop"); } catch {
      throw new Error("Live Seelen interaction tests require an unlocked Windows desktop. Unlock it and rerun.");
    }

    const title = `Seelen test ${randomUUID()}`;
    const owned: ChildProcess[] = [];
    const monitor = (await this.seelen.monitors()).find(entry => entry.id === id)!;
    const args = (label: string, count = 1) =>
      [label, String(monitor.rect.left + 100), String(monitor.rect.top + 100), String(count)];

    return {
      title, program, native,
      get cursorMoved() { return cursorMoved; },
      arguments: (label: string, count?: number) => args(label, count).map(arg => `"${arg}"`).join(" "),
      async startWindow(count = 1) {
        const child = spawn(program, args(title, count), { windowsHide: true, stdio: "ignore" });
        owned.push(child);
        await once(child, "spawn");
        await expect.poll(async () => (await seelen.windows()).filter(win => win.title.startsWith(title)).length,
          { timeout: 15_000 }).toBe(count);
      },
      async stop() {
        try {
          // Also include processes launched through the shortcut UI.
          const testWindows = (await seelen.windows()).filter(win =>
            win.title.startsWith(title) && win.process.path?.toLowerCase() === program.toLowerCase());
          for (const pid of new Set(testWindows.map(win => win.process.id))) {
            try { process.kill(pid); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
          }
        } finally {
          for (const child of owned) if (child.exitCode === null) child.kill();
        }
      },
    };
  }

  async prepare(snapshot: DesktopSnapshot, application: TestApplication) {
    await this.seelen.configure({ hideMode: "Never", mode: "Minimal" });
    await this.page.evaluate(keys => { for (const key of keys) localStorage.removeItem(key); }, Object.keys(snapshot.originalStorage));
    await this.page.reload();
    await expect(this.page.locator("#workspace-badge")).toHaveText(/\S/);
    await application.startWindow();
  }

  private async restoreSettings(snapshot: DesktopSnapshot) {
    const current = await this.seelen.settings();
    const overrides = current.monitorsV3[snapshot.monitorId].byWidget;
    if (snapshot.originalSettings === undefined) delete overrides[widgetId];
    else overrides[widgetId] = snapshot.originalSettings;
    await this.seelen.invoke("state_write_settings", { settings: current });
  }

  private async restoreStorage(snapshot: DesktopSnapshot) {
    await this.page.evaluate(storage => {
      for (const [key, value] of Object.entries(storage)) {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      }
    }, snapshot.originalStorage);
    expect(await this.readStorage(Object.keys(snapshot.originalStorage))).toEqual(snapshot.originalStorage);
    await this.page.reload();
  }

  private async restoreCursor(snapshot: DesktopSnapshot, application: TestApplication) {
    // CDP input does not move the physical cursor; restore only native movement.
    if (application.cursorMoved) {
      await expect(async () => { await application.native("cursor", ...snapshot.originalCursor.map(String)); }).toPass({ timeout: 5000 });
    }
  }

  private async restoreFocus(snapshot: DesktopSnapshot) {
    const hwnd = snapshot.originalFocus.hwnd;
    if ((await this.seelen.windows()).some(win => win.hwnd === hwnd)) {
      await expect(async () => {
        await this.seelen.invoke("weg_toggle_window_state", { hwnd, wasFocused: false });
      }).toPass({ timeout: 5000 });
    }
  }

  async restore(snapshot: DesktopSnapshot, application: TestApplication) {
    const steps = [
      () => application.stop(),
      () => this.seelen.switchWorkspace(snapshot.originalWorkspace),
      () => this.restoreSettings(snapshot),
      () => this.restoreStorage(snapshot),
      () => this.restoreCursor(snapshot, application),
      () => this.restoreFocus(snapshot),
    ];
    // Run every restoration step even if an earlier step fails.
    const errors: unknown[] = [];
    for (const step of steps) {
      try { await step(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Desktop cleanup failed; see original-desktop-state attachment for recovery.");
  }
}
