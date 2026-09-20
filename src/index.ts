import { IconPackManager, invoke, SeelenCommand, SeelenEvent, Settings, subscribe, Widget } from "@seelen-ui/lib";
import type {
  DesktopWorkspace,
  PhysicalMonitor,
  Relaunch,
  SeelenCommandGetIconArgs,
  UserAppWindow,
  VirtualDesktops,
} from "@seelen-ui/lib/types";

type HideMode = "Never" | "Always" | "OnOverlap";
type WidthMode = "Minimal" | "Full Width" | "MinContent" | "FullWidth";

interface TaskbarConfig {
  hideMode: HideMode;
  mode?: WidthMode;
}

interface Pin {
  key: string;
  label: string;
  path: string | null;
  umid: string | null;
  relaunch: Relaunch | null;
}

interface TaskItem {
  key: string;
  pin: Pin | null;
  windows: UserAppWindow[];
  label: string;
}

interface NativeTaskbarLease {
  originalWegEnabled: boolean;
  monitorOverrides: Record<string, { existed: boolean; enabled?: boolean }>;
}

interface MutableWidgetSettings {
  enabled: boolean;
  [key: string]: unknown;
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`Missing required element #${id}`);
  }
  return element as T;
}

function requiredSelector<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector(selector);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`Missing required element ${selector}`);
  }
  return element as T;
}

const BAR_HEIGHT = 58;
const HIDE_DELAY = 800;
const SHOW_DELAY = 100;
const SEELEN_WEG_ID = "@seelen/weg";
const TASKBAR_LEASE_KEY = "native-taskbar-lease:v1";
const widget = Widget.self;
const monitorId = widget.decoded.monitorId;

const elements = {
  root: requiredElement<HTMLElement>("workspace-taskbar"),
  surface: requiredSelector<HTMLElement>(".taskbar-surface"),
  badge: requiredElement<HTMLElement>("workspace-badge"),
  items: requiredElement<HTMLElement>("task-items"),
  empty: requiredElement<HTMLElement>("empty-state"),
  toast: requiredElement<HTMLElement>("toast"),
};

const state: {
  desktops: VirtualDesktops | null;
  windows: UserAppWindow[];
  monitors: PhysicalMonitor[];
  focusedHwnd: number | null;
  widgetFocused: boolean;
  mouseAtBottomEdge: boolean;
  mousePosition: [number, number] | null;
  pointerOverSurface: boolean;
  cursorEventsAllowed: boolean | null;
  config: TaskbarConfig;
  autoHideTimer: number | null;
  toastTimer: number | null;
} = {
  desktops: null,
  windows: [],
  monitors: [],
  focusedHwnd: null,
  widgetFocused: false,
  mouseAtBottomEdge: false,
  mousePosition: null,
  pointerOverSurface: false,
  cursorEventsAllowed: null,
  config: { hideMode: "Never" },
  autoHideTimer: null,
  toastTimer: null,
};

let iconPackManager: IconPackManager | undefined;
const requestedIcons = new Set<string>();
let taskbarLeaseUpdatePending = false;

function readTaskbarLease(): NativeTaskbarLease | null {
  try {
    return JSON.parse(localStorage.getItem(TASKBAR_LEASE_KEY) ?? "null");
  } catch {
    return null;
  }
}

function customTaskbarIsGloballyEnabled(settings: Settings): boolean {
  return settings.inner.byWidget?.[widget.id]?.enabled === true;
}

function ensureMonitorSettings(settings: Settings, id: string): Record<string, MutableWidgetSettings> {
  settings.inner.monitorsV3 ??= {};
  settings.inner.monitorsV3[id] ??= {
    byWidget: {},
    wallpaperCollection: null,
    byWorkspace: {},
  };
  settings.inner.monitorsV3[id].byWidget ??= {};
  return settings.inner.monitorsV3[id].byWidget as Record<string, MutableWidgetSettings>;
}

async function claimNativeTaskbar(settings: Settings): Promise<void> {
  if (taskbarLeaseUpdatePending) return;

  const wegSettings = settings.inner.byWidget?.[SEELEN_WEG_ID];
  if (!wegSettings) {
    console.warn("SeelenWeg settings were not found; the native taskbar cannot be hidden safely");
    return;
  }

  let lease = readTaskbarLease();
  if (!lease) {
    lease = {
      originalWegEnabled: wegSettings.enabled === true,
      monitorOverrides: {},
    };

    for (const monitor of state.monitors) {
      const existing = (settings.inner.monitorsV3?.[monitor.id]?.byWidget as
        | Record<string, MutableWidgetSettings>
        | undefined)?.[SEELEN_WEG_ID];
      lease.monitorOverrides[monitor.id] = existing
        ? { existed: true, enabled: existing.enabled === true }
        : { existed: false };
    }
    localStorage.setItem(TASKBAR_LEASE_KEY, JSON.stringify(lease));
  }

  let changed = false;
  if (wegSettings.enabled !== true) {
    wegSettings.enabled = true;
    changed = true;
  }

  for (const monitor of state.monitors) {
    const byWidget = ensureMonitorSettings(settings, monitor.id);
    const existing = byWidget[SEELEN_WEG_ID] ?? {};
    if (existing.enabled !== false) {
      byWidget[SEELEN_WEG_ID] = { ...existing, enabled: false };
      changed = true;
    }
  }

  if (changed) {
    taskbarLeaseUpdatePending = true;
    try {
      await settings.save();
    } finally {
      taskbarLeaseUpdatePending = false;
    }
  }
}

async function releaseNativeTaskbar(settings: Settings): Promise<void> {
  if (taskbarLeaseUpdatePending) return;
  const lease = readTaskbarLease();
  if (!lease) return;

  // Clear first so monitor replicas cannot restore the same lease twice.
  localStorage.removeItem(TASKBAR_LEASE_KEY);
  const wegSettings = settings.inner.byWidget?.[SEELEN_WEG_ID];
  if (!wegSettings) return;

  wegSettings.enabled = lease.originalWegEnabled;
  for (const [id, original] of Object.entries(lease.monitorOverrides)) {
    const byWidget = ensureMonitorSettings(settings, id);
    if (original.existed) {
      byWidget[SEELEN_WEG_ID] = {
        ...(byWidget[SEELEN_WEG_ID] ?? {}),
        enabled: original.enabled === true,
      };
    } else {
      delete byWidget[SEELEN_WEG_ID];
    }
  }

  taskbarLeaseUpdatePending = true;
  try {
    await settings.save();
  } finally {
    taskbarLeaseUpdatePending = false;
  }
}

async function syncNativeTaskbarLease(settings: Settings): Promise<void> {
  if (customTaskbarIsGloballyEnabled(settings)) {
    await claimNativeTaskbar(settings);
  } else {
    await releaseNativeTaskbar(settings);
  }
}

function activeWorkspace(): DesktopWorkspace | null {
  if (!monitorId) return null;
  const monitor = state.desktops?.monitors?.[monitorId];
  if (!monitor) return null;
  const activeWorkspaceId = monitor.active_workspace ?? (monitor as typeof monitor & { activeWorkspace?: string }).activeWorkspace;
  return monitor.workspaces.flat().find((workspace) => workspace.id === activeWorkspaceId) ?? null;
}

function storageKey(workspaceId: string): string {
  return `pins:${monitorId}:${workspaceId}`;
}

function readPins(workspaceId: string): Pin[] {
  try {
    return JSON.parse(localStorage.getItem(storageKey(workspaceId)) ?? "[]");
  } catch {
    return [];
  }
}

function writePins(workspaceId: string, pins: Pin[]): void {
  localStorage.setItem(storageKey(workspaceId), JSON.stringify(pins));
}

function appKey(app: UserAppWindow | Pin): string {
  const command = app.relaunch?.command ?? ("path" in app ? app.path : app.process.path) ?? "";
  return app.umid ? `umid:${app.umid.toLowerCase()}` : `path:${command.toLowerCase()}`;
}

function pinFromWindow(win: UserAppWindow): Pin {
  return {
    key: appKey(win),
    label: win.appName || win.title || "Application",
    path: win.process?.path ?? null,
    umid: win.umid ?? null,
    relaunch: win.relaunch ?? null,
  };
}

function labelInitials(label: string): string {
  return label
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] ?? "")
    .join("") || "?";
}

function iconArguments(item: TaskItem): SeelenCommandGetIconArgs {
  const win = item.windows[0];
  return {
    path: item.pin?.relaunch?.icon ?? item.pin?.path ?? win?.relaunch?.icon ?? win?.process?.path ?? null,
    umid: item.pin?.umid ?? win?.umid ?? null,
  };
}

function requestMissingIcon(args: SeelenCommandGetIconArgs): void {
  const key = `${args.path ?? ""}|${args.umid ?? ""}`;
  if ((!args.path && !args.umid) || requestedIcons.has(key)) return;
  requestedIcons.add(key);
  IconPackManager.requestIconExtraction(args).catch((error) => {
    requestedIcons.delete(key);
    console.warn("Could not extract application icon", error);
  });
}

function createIcon(item: TaskItem): HTMLSpanElement {
  const wrapper = document.createElement("span");
  wrapper.className = "task-icon";

  const fallback = document.createElement("span");
  fallback.className = "task-icon-fallback";
  fallback.textContent = labelInitials(item.label);

  const args = iconArguments(item);
  const icon = iconPackManager?.getIcon(args);
  const source = icon?.dark ?? icon?.base ?? icon?.light;

  if (!source) {
    wrapper.append(fallback);
    requestMissingIcon(args);
    return wrapper;
  }

  const image = document.createElement("img");
  image.className = "task-icon-image";
  image.src = source;
  image.alt = "";
  image.draggable = false;
  image.addEventListener("error", () => image.replaceWith(fallback), { once: true });
  wrapper.append(image);
  return wrapper;
}

function showToast(message: string): void {
  elements.toast.textContent = message;
  elements.toast.classList.add("is-visible");
  if (state.toastTimer !== null) clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => elements.toast.classList.remove("is-visible"), 1800);
}

async function launch(pin: Pin): Promise<void> {
  if (pin.relaunch) {
    await invoke(SeelenCommand.Run, {
      program: pin.relaunch.command,
      args: pin.relaunch.args ?? null,
      workingDir: pin.relaunch.workingDir ?? null,
      elevated: false,
    });
    return;
  }

  const program = pin.umid ? `shell:AppsFolder\\${pin.umid}` : pin.path;
  if (!program) throw new Error(`No launch command is available for ${pin.label}`);
  await invoke(SeelenCommand.Run, {
    program,
    args: null,
    workingDir: null,
    elevated: false,
  });
}

async function activate(item: TaskItem): Promise<void> {
  const win = item.windows.toSorted((a, b) => b.lastForegroundAt - a.lastForegroundAt)[0];
  if (win) {
    await invoke(SeelenCommand.WegToggleWindowState, {
      hwnd: win.hwnd,
      wasFocused: state.focusedHwnd === win.hwnd,
    });
  } else {
    if (item.pin) await launch(item.pin);
  }
}

function togglePin(workspace: DesktopWorkspace | null, item: TaskItem): void {
  if (!workspace) return;
  const pins = readPins(workspace.id);
  const existingIndex = pins.findIndex((pin) => pin.key === item.key);

  if (existingIndex >= 0) {
    const [removed] = pins.splice(existingIndex, 1);
    writePins(workspace.id, pins);
    showToast(`Unpinned ${removed.label} from this workspace`);
  } else {
    const source = item.windows[0];
    if (!source || source.preventPinning) {
      showToast("This application cannot be pinned");
      return;
    }
    const pin = pinFromWindow(source);
    pins.push(pin);
    writePins(workspace.id, pins);
    showToast(`Pinned ${pin.label} to this workspace`);
  }

  render();
}

function visibleWindows(workspace: DesktopWorkspace | null): UserAppWindow[] {
  if (!workspace || !state.desktops) return [];
  const ids = new Set([...workspace.windows, ...state.desktops.pinned]);
  return state.windows.filter((win) => win.monitor === monitorId && ids.has(win.hwnd));
}

function taskbarOverlapsWindow(): boolean {
  const workspace = activeWorkspace();
  const monitor = state.monitors.find((entry) => entry.id === monitorId);
  if (!workspace || !monitor) return false;

  const barTop = monitor.rect.bottom - Math.round(BAR_HEIGHT * monitor.scaleFactor);
  return visibleWindows(workspace).some((win) => {
    const rect = win.rect;
    if (win.isIconic || !rect) return false;
    return rect.right > monitor.rect.left &&
      rect.left < monitor.rect.right &&
      rect.bottom > barTop &&
      rect.top < monitor.rect.bottom;
  });
}

function autoHideWanted(): boolean {
  if (state.desktops?.switching) return false;
  if (state.widgetFocused || state.mouseAtBottomEdge || state.pointerOverSurface) return false;

  switch (state.config.hideMode) {
    case "Always":
      return true;
    case "OnOverlap":
      return taskbarOverlapsWindow();
    default:
      return false;
  }
}

function updateAutoHide({ immediate = false }: { immediate?: boolean } = {}): void {
  if (state.autoHideTimer !== null) clearTimeout(state.autoHideTimer);
  const hidden = autoHideWanted();
  const flush = immediate || state.config.hideMode === "Never" || state.desktops?.switching;

  if (flush) {
    elements.root.classList.toggle("is-hidden", hidden);
    updateCursorHitbox();
    return;
  }

  state.autoHideTimer = setTimeout(() => {
    elements.root.classList.toggle("is-hidden", hidden);
    updateCursorHitbox();
  }, hidden ? HIDE_DELAY : SHOW_DELAY);
}

function applyWidgetSettings(): void {
  const isFullWidth = state.config.mode === "Full Width" || state.config.mode === "FullWidth";
  elements.root.dataset.mode = isFullWidth ? "Full Width" : "Minimal";
  updateAutoHide({ immediate: state.config.hideMode === "Never" });
}

function migrateWidthMode(settings: Settings): boolean {
  let changed = false;
  const migrate = (config: MutableWidgetSettings | undefined) => {
    if (!config) return;
    if (config.mode === "MinContent") {
      config.mode = "Minimal";
      changed = true;
    } else if (config.mode === "FullWidth") {
      config.mode = "Full Width";
      changed = true;
    }
  };

  migrate(settings.inner.byWidget?.[widget.id]);
  for (const monitor of Object.values(settings.inner.monitorsV3 ?? {})) {
    migrate(monitor.byWidget?.[widget.id]);
  }
  return changed;
}

function updateMouseEdge([x, y]: [number, number]): void {
  const monitor = state.monitors.find((entry) => entry.id === monitorId);
  const atEdge = !!monitor &&
    x >= monitor.rect.left &&
    x < monitor.rect.right &&
    y === monitor.rect.bottom - 1;

  if (atEdge !== state.mouseAtBottomEdge) {
    state.mouseAtBottomEdge = atEdge;
    updateAutoHide();
  }
}

function setCursorEventsAllowed(allowed: boolean): void {
  if (state.cursorEventsAllowed === allowed) return;
  state.cursorEventsAllowed = allowed;
  widget.window.setIgnoreCursorEvents(!allowed).catch((error) => {
    console.warn("Could not update taskbar hitbox", error);
  });
}

function updateCursorHitbox(mousePosition = state.mousePosition): void {
  if (!mousePosition || !elements.surface) {
    setCursorEventsAllowed(false);
    return;
  }

  const monitor = state.monitors.find((entry) => entry.id === monitorId);
  if (!monitor || elements.root.classList.contains("is-hidden")) {
    state.pointerOverSurface = false;
    setCursorEventsAllowed(false);
    return;
  }

  const [mouseX, mouseY] = mousePosition;
  const scale = monitor.scaleFactor;
  const bounds = elements.surface.getBoundingClientRect();
  const left = monitor.rect.left + bounds.left * scale;
  const top = monitor.rect.bottom - Math.round(BAR_HEIGHT * scale) + bounds.top * scale;
  const right = monitor.rect.left + bounds.right * scale;
  const bottom = monitor.rect.bottom - Math.round(BAR_HEIGHT * scale) + bounds.bottom * scale;
  const isOverSurface = mouseX >= left && mouseX < right && mouseY >= top && mouseY < bottom;

  if (isOverSurface !== state.pointerOverSurface) {
    state.pointerOverSurface = isOverSurface;
    updateAutoHide();
  }
  setCursorEventsAllowed(isOverSurface);
}

function modelFor(workspace: DesktopWorkspace): TaskItem[] {
  const pins = readPins(workspace.id);
  const running = visibleWindows(workspace);
  const groups = new Map<string, Omit<TaskItem, "label">>();

  for (const pin of pins) {
    groups.set(pin.key, { key: pin.key, pin, windows: [] });
  }

  for (const win of running) {
    const key = appKey(win);
    const group = groups.get(key) ?? { key, pin: null, windows: [] };
    group.windows.push(win);
    groups.set(key, group);
  }

  return [...groups.values()].map((group) => ({
    ...group,
    label: group.pin?.label || group.windows[0]?.appName || group.windows[0]?.title || "Application",
  }));
}

function render(): void {
  const workspace = activeWorkspace();
  elements.items.replaceChildren();

  if (!workspace) {
    elements.badge.textContent = "—";
    elements.empty.textContent = monitorId ? "Waiting for workspace data…" : "No monitor was assigned";
    elements.empty.hidden = false;
    return;
  }

  if (!state.desktops || !monitorId) return;
  const monitor = state.desktops.monitors[monitorId];
  const allWorkspaces = monitor.workspaces.flat();
  const workspaceNumber = allWorkspaces.findIndex((entry) => entry.id === workspace.id) + 1;
  elements.badge.textContent = workspace.name || `Workspace ${workspaceNumber}`;
  elements.badge.title = `Pins here belong only to ${elements.badge.textContent}`;

  const items = modelFor(workspace);
  elements.empty.textContent = "No windows here yet";
  elements.empty.hidden = items.length > 0;

  for (const item of items) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "task-item";
    button.classList.toggle("is-open", item.windows.length > 0);
    button.classList.toggle("is-focused", item.windows.some((win) => win.hwnd === state.focusedHwnd));
    button.title = item.label;
    button.setAttribute("aria-label", `${item.label}; right-click to ${item.pin ? "unpin" : "pin"}`);
    button.append(createIcon(item));

    if (item.windows.length > 1) {
      const count = document.createElement("span");
      count.className = "task-count";
      count.textContent = String(item.windows.length);
      button.append(count);
    }

    if (item.pin) {
      const pinMark = document.createElement("span");
      pinMark.className = "pin-mark";
      pinMark.textContent = "●";
      pinMark.setAttribute("aria-label", "Pinned");
      button.append(pinMark);
    }

    button.addEventListener("click", () => activate(item).catch(reportError));
    button.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      togglePin(workspace, item);
    });
    elements.items.append(button);
  }

  updateAutoHide();
}

async function positionWidget(): Promise<void> {
  const monitor = state.monitors.find((entry) => entry.id === monitorId);
  if (!monitor) return;
  const height = Math.round(BAR_HEIGHT * monitor.scaleFactor);
  await widget.setPosition({
    left: monitor.rect.left,
    top: monitor.rect.bottom - height,
    right: monitor.rect.right,
    bottom: monitor.rect.bottom,
  });
}

function reportError(error: unknown): void {
  console.error(error);
  showToast(error instanceof Error ? error.message : String(error));
}

function currentTaskbarConfig(settings: Settings): TaskbarConfig {
  const config = settings.getCurrentWidgetConfig();
  const hideMode = config.hideMode;
  const mode = config.mode;
  return {
    hideMode: hideMode === "Always" || hideMode === "OnOverlap" ? hideMode : "Never",
    mode: mode === "Full Width" || mode === "FullWidth" || mode === "MinContent" ? mode : "Minimal",
  };
}

await widget.init({ useThemes: true, saveAndRestoreLastRect: false });

iconPackManager = await IconPackManager.create();
await iconPackManager.onChange(render);
let settings = await Settings.getAsync();
if (migrateWidthMode(settings)) {
  await settings.save();
}
state.config = currentTaskbarConfig(settings);
applyWidgetSettings();
await Settings.onChange((nextSettings) => {
  settings = nextSettings;
  state.config = currentTaskbarConfig(settings);
  applyWidgetSettings();
  syncNativeTaskbarLease(settings).catch(reportError);
});

[state.desktops, state.windows, state.monitors] = await Promise.all([
  invoke(SeelenCommand.StateGetVirtualDesktops),
  invoke(SeelenCommand.GetUserAppWindows),
  invoke(SeelenCommand.SystemGetMonitors),
]);

await syncNativeTaskbarLease(settings);

await Promise.all([
  subscribe(SeelenEvent.VirtualDesktopsChanged, ({ payload }) => {
    state.desktops = payload;
    render();
  }),
  subscribe(SeelenEvent.UserAppWindowsChanged, ({ payload }) => {
    state.windows = payload;
    render();
  }),
  subscribe(SeelenEvent.GlobalFocusChanged, ({ payload }) => {
    state.focusedHwnd = payload.hwnd;
    state.widgetFocused = payload.hwnd === widget.windowId || payload.ownerHwnd === widget.windowId;
    render();
  }),
  subscribe(SeelenEvent.GlobalMouseMove, ({ payload }) => {
    state.mousePosition = payload;
    updateMouseEdge(payload);
    updateCursorHitbox(payload);
  }),
  subscribe(SeelenEvent.SystemMonitorsChanged, ({ payload }) => {
    state.monitors = payload;
    positionWidget().catch(reportError);
  }),
]);

await positionWidget();
render();
setCursorEventsAllowed(false);
await widget.ready();
