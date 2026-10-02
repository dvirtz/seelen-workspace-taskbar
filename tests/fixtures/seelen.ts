import { expect, type Page } from "@playwright/test";
import type { Widget } from "@seelen-ui/lib";
import type { VirtualDesktops, UserAppWindow, PhysicalMonitor, Settings } from "@seelen-ui/lib/types";

declare global {
  interface Window {
    __SLU_WIDGET_INSTANCE: Widget;
    __TAURI_INTERNALS__: { invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> };
  }
}

export const widgetId = "@dvirtz/workspace-taskbar";
// SDK 2.8.4 declares built-in widget IDs only; custom widgets are present at runtime.
type WidgetSettings = Record<string, unknown> & { enabled?: boolean };
type LiveSettings = Settings & {
  byWidget: Record<string, WidgetSettings>;
  monitorsV3: Record<string, { byWidget: Record<string, WidgetSettings> }>;
};

/** Access to Seelen's runtime through one monitor's widget page. */
export class Seelen {
  constructor(readonly page: Page) {}

  invoke<T>(command: string, args?: Record<string, unknown>) {
    return this.page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke<T>(command, args), { command, args });
  }

  desktops() { return this.invoke<VirtualDesktops>("get_virtual_desktops"); }
  windows() { return this.invoke<UserAppWindow[]>("get_user_app_windows"); }
  monitors() { return this.invoke<PhysicalMonitor[]>("get_connected_monitors"); }
  settings() { return this.invoke<LiveSettings>("state_get_settings"); }
  monitorId() { return this.page.evaluate(() => window.__SLU_WIDGET_INSTANCE.decoded.monitorId!); }

  async workspace() {
    const monitor = (await this.desktops()).monitors[await this.monitorId()];
    return monitor.workspaces.flat().find(entry => entry.id === monitor.active_workspace)!;
  }

  async configure(patch: Record<string, unknown>) {
    const current = await this.settings();
    const id = await this.monitorId();
    const monitor = current.monitorsV3[id];
    if (!monitor) throw new Error(`No saved monitor configuration for ${id}`);
    monitor.byWidget[widgetId] = { enabled: true, ...monitor.byWidget[widgetId], ...patch };
    await this.invoke("state_write_settings", { settings: current });
  }

  async switchWorkspace(id: string) {
    await this.invoke("switch_workspace", { workspaceId: id });
    await expect.poll(async () => (await this.workspace()).id).toBe(id);
    await expect.poll(async () => (await this.desktops()).switching).toBe(false);
  }
}
