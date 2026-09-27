import { IconPackManager, invoke, SeelenCommand, SeelenEvent, Settings, subscribe, Widget } from "@seelen-ui/lib";
import type {
  DesktopWorkspace,
  PhysicalMonitor,
  Relaunch,
  SeelenCommandGetIconArgs,
  UserAppWindow,
  UserAppWindowPreview,
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
  matchPath?: string | null;
  matchUmid?: string | null;
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
const WIDGET_HEIGHT = 280;
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
  previews: requiredElement<HTMLElement>("window-previews"),
  shortcutForm: requiredElement<HTMLFormElement>("shortcut-form"),
  appMenu: requiredElement<HTMLElement>("app-menu"),
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
const renderedTasks = new Map<HTMLButtonElement, TaskItem>();
let taskbarLeaseUpdatePending = false;
let previews: Record<number, UserAppWindowPreview> = {};
let previewKey: string | null = null;
let previewWorkspace: string | null = null;
let previewTimer: number | undefined;
let previewCloseTimer: number | undefined;
let shortcutWorkspace: string | null = null;
let menuWorkspace: string | null = null;
let menuKey: string | null = null;
let shortcutSource: Pin | null = null;
let editingShortcutKey: string | null = null;
let initialArguments = "";
let shortcutFocusRequest = 0;
const shortcutWindows = new Map<number, { workspaceId: string; pinKey: string }>();
const shortcutLaunches = new Map<string, { workspaceId: string; started: number; existing: Set<number> }>();

interface IconLayout { order: string[]; locked: boolean }
let drag: { button: HTMLButtonElement; pointerId: number; workspaceId: string; x: number; y: number; moved: boolean } | null = null;
let suppressDragClick = false;

function readIconLayout(workspaceId: string): IconLayout {
  try {
    const value = JSON.parse(localStorage.getItem(`icon-layout:${monitorId}:${workspaceId}`) ?? "null");
    return {
      order: Array.isArray(value?.order) ? [...new Set<string>(value.order.filter((key: unknown) => typeof key === "string"))] : [],
      locked: value?.locked === true,
    };
  } catch { return { order: [], locked: false }; }
}

function writeIconLayout(workspaceId: string, layout: IconLayout): void {
  localStorage.setItem(`icon-layout:${monitorId}:${workspaceId}`, JSON.stringify(layout));
}

function finishDrag(commit = false): void {
  const current = drag;
  if (!current) return;
  drag = null;
  current.button.classList.remove("is-dragging");
  if (elements.items.hasPointerCapture(current.pointerId)) elements.items.releasePointerCapture(current.pointerId);
  if (current.moved) {
    suppressDragClick = true;
    if (commit && current.workspaceId === activeWorkspace()?.id) {
      try {
        const layout = readIconLayout(current.workspaceId);
        if (!layout.locked) {
          const order = Array.from(elements.items.children).map((button) => renderedTasks.get(button as HTMLButtonElement)!.key);
          // Keep absent apps' positions so reopening an app restores its order.
          const visible = new Set(order);
          let index = 0;
          layout.order = layout.order.map((key) => visible.has(key) ? order[index++] : key);
          layout.order.push(...order.slice(index));
          writeIconLayout(current.workspaceId, layout);
        }
      } catch (error) { reportError(error); }
    }
  }
  updateCursorHitbox();
  updateAutoHide();
}

function toggleOrderLock(): void {
  const workspace = activeWorkspace();
  if (!workspace) return;
  try {
    const layout = readIconLayout(workspace.id);
    layout.locked = !layout.locked;
    writeIconLayout(workspace.id, layout);
    render();
  } catch (error) { reportError(error); }
}

document.addEventListener("pointermove", (event) => {
  if (!drag || event.pointerId !== drag.pointerId) return;
  if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 6) return;
  if (!drag.moved) elements.items.setPointerCapture(event.pointerId);
  drag.moved = true;
  drag.button.classList.add("is-dragging");
  closePreviews();
  closeAppMenu();
  const bounds = elements.items.getBoundingClientRect();
  if (event.clientY < bounds.top || event.clientY > bounds.bottom) return;
  const others = Array.from(elements.items.children).filter((button) => button !== drag!.button);
  const next = others.find((button) => {
    const rect = button.getBoundingClientRect();
    return event.clientX < rect.left + rect.width / 2;
  });
  elements.items.insertBefore(drag.button, next ?? null);
});
document.addEventListener("pointerup", (event) => {
  if (!drag || event.pointerId !== drag.pointerId) return;
  const bounds = elements.items.getBoundingClientRect();
  finishDrag(event.clientX >= bounds.left && event.clientX <= bounds.right && event.clientY >= bounds.top && event.clientY <= bounds.bottom);
  // Let the click from an ordinary press reach its original button.
  setTimeout(render, 0);
});
elements.items.addEventListener("lostpointercapture", () => { if (drag) { finishDrag(); render(); } });
elements.items.addEventListener("pointercancel", () => { finishDrag(); render(); });
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && drag) { finishDrag(); render(); }
});
window.addEventListener("blur", () => { if (drag) { finishDrag(); render(); } });

function shortcutMatchesWindow(pin: Pin, win: UserAppWindow): boolean {
  const normalize = (value: string | null | undefined) => value?.replaceAll("/", "\\").toLowerCase();
  const umid = pin.matchUmid ?? pin.umid;
  if (umid && win.umid && normalize(umid) === normalize(win.umid)) return true;
  const paths = [pin.matchPath, pin.relaunch?.command, pin.path].map(normalize).filter(Boolean);
  return [win.process.path, win.relaunch?.command].some((path) => !!path && paths.includes(normalize(path)));
}

function restoreShortcutFocus(): void {
  [...renderedTasks].find(([, item]) => item.key === shortcutSource?.key)?.[0].focus();
}

async function focusShortcutInput(input: HTMLInputElement): Promise<void> {
  const request = ++shortcutFocusRequest;
  // DOM focus alone does not activate the overlay's native window/WebView.
  await widget.focus();
  if (request === shortcutFocusRequest && !elements.shortcutForm.hidden) input.focus();
}

elements.shortcutForm.addEventListener("pointerdown", (event) => {
  if (event.target instanceof HTMLInputElement) {
    focusShortcutInput(event.target).catch(reportError);
  }
});

function closeAppMenu(restoreFocus = false): void {
  const key = menuKey;
  menuWorkspace = null;
  menuKey = null;
  elements.appMenu.hidden = true;
  elements.appMenu.replaceChildren();
  if (restoreFocus) [...renderedTasks].find(([, item]) => item.key === key)?.[0].focus();
  updateCursorHitbox();
  updateAutoHide();
}

function showAppMenu(button: HTMLButtonElement, item: TaskItem): void {
  const workspace = activeWorkspace();
  if (!workspace) return;
  closePreviews();
  closeShortcutForm();
  closeAppMenu();
  menuWorkspace = workspace.id;
  menuKey = item.key;
  const source = item.pin ?? (item.windows[0] ? pinFromWindow(item.windows[0]) : null);
  const canPin = !!item.pin || (!!source && !item.windows[0]?.preventPinning);
  const action = (label: string, run: () => void, enabled = canPin) => {
    const option = document.createElement("button");
    option.type = "button";
    option.setAttribute("role", "menuitem");
    option.textContent = label;
    option.disabled = !enabled;
    option.addEventListener("click", () => {
      closeAppMenu(true);
      if (activeWorkspace()?.id === workspace.id) run();
    });
    elements.appMenu.append(option);
  };
  action(item.pin ? "Unpin" : "Pin application", () => togglePin(workspace, item));
  action("Pin shortcut…", () => openShortcutForm(source));
  if (item.pin?.key.startsWith("shortcut:")) {
    action("Edit shortcut…", () => openShortcutForm(item.pin, true));
  }
  action(readIconLayout(workspace.id).locked ? "Unlock icon order" : "Lock icon order", toggleOrderLock, true);
  elements.appMenu.hidden = false;
  const bounds = button.getBoundingClientRect();
  const width = elements.appMenu.getBoundingClientRect().width;
  elements.appMenu.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, bounds.left))}px`;
  elements.appMenu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  updateCursorHitbox();
  updateAutoHide();
}

document.addEventListener("pointerdown", (event) => {
  if (!elements.appMenu.hidden && event.target instanceof Node && !elements.appMenu.contains(event.target)) closeAppMenu();
});
elements.appMenu.addEventListener("keydown", (event) => {
  if (event.key === "Escape" || event.key === "Tab") {
    if (event.key === "Escape") event.preventDefault();
    closeAppMenu(true);
  } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    const options = Array.from(elements.appMenu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
    const index = options.findIndex((option) => option === document.activeElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
      : (index + (event.key === "ArrowUp" ? -1 : 1) + options.length) % options.length;
    options[next]?.focus();
  }
});

function closeShortcutForm(): void {
  shortcutFocusRequest++;
  shortcutWorkspace = null;
  editingShortcutKey = null;
  elements.shortcutForm.hidden = true;
  updateCursorHitbox();
  updateAutoHide();
}

function openShortcutForm(source: Pin | null = null, editing = false): void {
  const workspace = activeWorkspace();
  if (!workspace) return;
  closePreviews();
  closeAppMenu();
  shortcutWorkspace = workspace.id;
  shortcutSource = source;
  editingShortcutKey = editing ? source?.key ?? null : null;
  const title = editingShortcutKey ? "Edit shortcut" : "Pin shortcut";
  elements.shortcutForm.setAttribute("aria-label", title);
  elements.shortcutForm.querySelector("strong")!.textContent = title;
  elements.shortcutForm.querySelector<HTMLButtonElement>('button[type="submit"]')!.textContent =
    editingShortcutKey ? "Save changes" : "Pin shortcut";
  elements.shortcutForm.reset();
  const args = source?.relaunch?.args;
  // Quote Windows argv values, including embedded quotes and trailing backslashes.
  initialArguments = Array.isArray(args) ? args.map((arg) =>
    `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`).join(" ") : args ?? "";
  const values = {
    label: source?.label ?? "",
    program: source?.relaunch?.command ?? (source?.umid ? `shell:AppsFolder\\${source.umid}` : source?.path) ?? "",
    args: initialArguments,
    workingDir: source?.relaunch?.workingDir ?? "",
  };
  for (const [name, value] of Object.entries(values)) {
    (elements.shortcutForm.elements.namedItem(name) as HTMLInputElement).value = value;
  }
  elements.shortcutForm.hidden = false;
  elements.root.classList.remove("is-hidden");
  const firstInput = elements.shortcutForm.querySelector("input");
  if (firstInput) focusShortcutInput(firstInput).catch(reportError);
  updateCursorHitbox();
  updateAutoHide();
}

requiredElement("cancel-shortcut").addEventListener("click", () => {
  closeShortcutForm();
  restoreShortcutFocus();
});

elements.shortcutForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!shortcutWorkspace || shortcutWorkspace !== activeWorkspace()?.id) return;
  const data = new FormData(elements.shortcutForm);
  const label = String(data.get("label") ?? "").trim();
  // Explorer's Copy as path includes surrounding quotes; Run expects the path alone.
  const cleanPath = (value: FormDataEntryValue | null) => String(value ?? "").trim().replace(/^"(.*)"$/, "$1");
  const command = cleanPath(data.get("program"));
  if (!label || !command) {
    showToast("Enter a name and application or shortcut path");
    return;
  }
  const pin: Pin = {
    // Keep shortcut identities distinct even when their applications match.
    key: editingShortcutKey ?? `shortcut:${crypto.randomUUID()}`,
    label,
    path: command,
    umid: null,
    matchPath: command === (shortcutSource?.relaunch?.command ?? shortcutSource?.path)
      ? shortcutSource?.matchPath ?? shortcutSource?.path : null,
    matchUmid: command === (shortcutSource?.relaunch?.command ??
      (shortcutSource?.umid ? `shell:AppsFolder\\${shortcutSource.umid}` : shortcutSource?.path))
      ? shortcutSource?.matchUmid ?? shortcutSource?.umid : null,
    relaunch: {
      command,
      args: String(data.get("args") ?? "") === initialArguments
        ? shortcutSource?.relaunch?.args ?? (initialArguments || null)
        : String(data.get("args") ?? "") || null,
      workingDir: cleanPath(data.get("workingDir")) || null,
      icon: shortcutSource?.relaunch?.icon ?? null,
    },
  };
  try {
    const pins = readPins(shortcutWorkspace);
    const editing = editingShortcutKey !== null;
    if (editing) {
      const index = pins.findIndex((entry) => entry.key === editingShortcutKey);
      if (index < 0) {
        showToast("This shortcut is no longer pinned");
        return;
      }
      pins[index] = pin;
    } else {
      pins.push(pin);
    }
    writePins(shortcutWorkspace, pins);
    closeShortcutForm();
    render();
    restoreShortcutFocus();
    showToast(editing ? `Updated ${label}` : `Pinned ${label} to this workspace`);
  } catch (error) {
    reportError(error);
  }
});

function closePreviews(): void {
  clearTimeout(previewTimer);
  clearTimeout(previewCloseTimer);
  previewKey = null;
  elements.previews.hidden = true;
  elements.previews.replaceChildren();
  for (const button of renderedTasks.keys()) button.setAttribute("aria-expanded", "false");
  updateCursorHitbox();
  updateAutoHide();
}

function schedulePreviewClose(): void {
  clearTimeout(previewTimer);
  clearTimeout(previewCloseTimer);
  previewCloseTimer = setTimeout(closePreviews, 300);
}

function updatePreviewImages(): void {
  for (const card of Array.from(elements.previews.querySelectorAll<HTMLButtonElement>(".window-preview"))) {
    const preview = previews[Number(card.dataset.hwnd)];
    const image = card.querySelector("img")!;
    const fallback = card.querySelector<HTMLElement>(".preview-unavailable")!;
    if (preview && image.dataset.hash !== preview.hash) {
      image.dataset.hash = preview.hash;
      image.hidden = false;
      fallback.hidden = true;
      image.src = `data:image/webp;base64,${preview.data}`;
    } else if (!preview) {
      image.hidden = true;
      image.removeAttribute("src");
      delete image.dataset.hash;
      fallback.hidden = false;
    }
  }
}

function showPreviews(button: HTMLButtonElement, item: TaskItem, refreshing = false): void {
  if (drag?.moved) return;
  clearTimeout(previewTimer);
  if (!refreshing) clearTimeout(previewCloseTimer);
  if (!button.isConnected || item.windows.length < 2) return;
  if (!elements.shortcutForm.hidden || !elements.appMenu.hidden) return;
  previewKey = item.key;
  previewWorkspace = activeWorkspace()?.id ?? null;
  for (const task of renderedTasks.keys()) task.setAttribute("aria-expanded", String(task === button));
  elements.previews.setAttribute("aria-label", `${item.label} windows`);
  // Keep cards mounted across thumbnail and window updates to preserve clicks and focus.
  const existing = new Map(Array.from(elements.previews.querySelectorAll<HTMLButtonElement>(".window-preview"))
    .map((card) => [Number(card.dataset.hwnd), card]));
  const wanted = new Set(item.windows.map((win) => win.hwnd));
  for (const [hwnd, card] of existing) if (!wanted.has(hwnd)) card.remove();
  for (const win of item.windows) {
    let card = existing.get(win.hwnd);
    if (!card) {
      card = document.createElement("button");
      card.type = "button";
      card.className = "window-preview";
      card.dataset.hwnd = String(win.hwnd);
      const title = document.createElement("span");
      title.className = "preview-title";
      const image = document.createElement("img");
      image.alt = "";
      image.draggable = false;
      const fallback = document.createElement("span");
      fallback.className = "preview-unavailable";
      fallback.textContent = "Preview unavailable";
      image.addEventListener("error", () => { image.hidden = true; fallback.hidden = false; });
      card.append(title, image, fallback);
      card.addEventListener("click", () => {
        closePreviews();
        invoke(SeelenCommand.WegToggleWindowState, { hwnd: win.hwnd, wasFocused: false }).catch(reportError);
      });
      elements.previews.append(card);
    }
    card.querySelector(".preview-title")!.textContent = win.title || item.label;
    card.setAttribute("aria-label", `Open ${win.title || item.label}`);
    card.title = win.title || item.label;
  }
  elements.previews.hidden = false;
  updatePreviewImages();
  const bounds = button.getBoundingClientRect();
  const width = elements.previews.getBoundingClientRect().width;
  elements.previews.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, bounds.left + bounds.width / 2 - width / 2))}px`;
  updateCursorHitbox();
  updateAutoHide();
}

elements.previews.addEventListener("pointerenter", () => clearTimeout(previewCloseTimer));
elements.previews.addEventListener("pointerleave", schedulePreviewClose);
elements.previews.addEventListener("focusin", () => clearTimeout(previewCloseTimer));
elements.previews.addEventListener("focusout", (event) => {
  if (!(event.relatedTarget instanceof Node) || !elements.previews.contains(event.relatedTarget)) schedulePreviewClose();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !elements.shortcutForm.hidden) {
    closeShortcutForm();
    restoreShortcutFocus();
    return;
  }
  if (event.key === "Escape" && previewKey) {
    const anchor = [...renderedTasks].find(([, item]) => item.key === previewKey)?.[0];
    closePreviews();
    anchor?.focus();
  }
});

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
  if (pin.key.startsWith("shortcut:")) {
    const workspace = activeWorkspace();
    if (workspace) shortcutLaunches.set(pin.key, {
      workspaceId: workspace.id,
      started: Date.now(),
      existing: new Set(state.windows.map((win) => win.hwnd)),
    });
  }
  try {
    const program = pin.relaunch?.command ?? (pin.umid ? `shell:AppsFolder\\${pin.umid}` : pin.path);
    if (!program) throw new Error(`No launch command is available for ${pin.label}`);
    await invoke(SeelenCommand.Run, {
      program,
      args: pin.relaunch?.args ?? null,
      workingDir: pin.relaunch?.workingDir ?? null,
      elevated: false,
    });
  } catch (error) {
    shortcutLaunches.delete(pin.key);
    throw error;
  }
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
  if (drag) return false;
  if (!elements.appMenu.hidden) return false;
  if (!elements.shortcutForm.hidden) return false;
  if (state.desktops?.switching) return false;
  if (previewKey || state.widgetFocused || state.mouseAtBottomEdge || state.pointerOverSurface) return false;

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
  if (drag) { setCursorEventsAllowed(true); return; }
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
  const surfaces = [elements.surface];
  if (!elements.previews.hidden) surfaces.push(elements.previews);
  if (!elements.shortcutForm.hidden) surfaces.push(elements.shortcutForm);
  if (!elements.appMenu.hidden) surfaces.push(elements.appMenu);
  const isOverSurface = surfaces.some((surface) => {
    const bounds = surface.getBoundingClientRect();
    const left = monitor.rect.left + bounds.left * scale;
    const top = monitor.rect.bottom - Math.round(WIDGET_HEIGHT * scale) + bounds.top * scale;
    const right = monitor.rect.left + bounds.right * scale;
    const bottom = monitor.rect.bottom - Math.round(WIDGET_HEIGHT * scale) + bounds.bottom * scale;
    return mouseX >= left && mouseX < right && mouseY >= top && mouseY < bottom;
  });

  if (isOverSurface !== state.pointerOverSurface) {
    state.pointerOverSurface = isOverSurface;
    if (!isOverSurface && previewKey) schedulePreviewClose();
    updateAutoHide();
  }
  setCursorEventsAllowed(isOverSurface);
}

function modelFor(workspace: DesktopWorkspace): TaskItem[] {
  const pins = readPins(workspace.id);
  const running = visibleWindows(workspace);
  const groups = new Map<string, Omit<TaskItem, "label">>();
  const windowIds = new Set(state.windows.map((win) => win.hwnd));
  for (const hwnd of shortcutWindows.keys()) {
    if (!windowIds.has(hwnd)) shortcutWindows.delete(hwnd);
  }
  for (const [key, launch] of shortcutLaunches) {
    if (Date.now() - launch.started > 30000) shortcutLaunches.delete(key);
  }

  for (const pin of pins) {
    groups.set(pin.key, { key: pin.key, pin, windows: [] });
  }

  for (const win of running) {
    const candidates = pins.filter((pin) => pin.key.startsWith("shortcut:") && shortcutMatchesWindow(pin, win));
    const assigned = shortcutWindows.get(win.hwnd);
    const existing = assigned?.workspaceId === workspace.id
      ? candidates.find((pin) => pin.key === assigned.pinKey) : undefined;
    const launched = candidates.filter((pin) => {
      const launch = shortcutLaunches.get(pin.key);
      return launch?.workspaceId === workspace.id && !launch.existing.has(win.hwnd);
    }).sort((a, b) => shortcutLaunches.get(b.key)!.started - shortcutLaunches.get(a.key)!.started)[0];
    const exact = candidates.filter((pin) => win.relaunch && pin.relaunch &&
      JSON.stringify(pin.relaunch.args) === JSON.stringify(win.relaunch.args) &&
      pin.relaunch.workingDir === win.relaunch.workingDir);
    const regularKey = appKey(win);
    const shortcut = existing ?? launched ?? (groups.has(regularKey) ? undefined
      : exact.length === 1 ? exact[0] : candidates.length === 1 ? candidates[0] : undefined);
    if (shortcut) shortcutWindows.set(win.hwnd, { workspaceId: workspace.id, pinKey: shortcut.key });
    const key = shortcut?.key ?? regularKey;
    const group = groups.get(key) ?? { key, pin: null, windows: [] };
    group.windows.push(win);
    groups.set(key, group);
  }

  return [...groups.values()].map((group) => ({
    ...group,
    label: group.pin?.label || group.windows[0]?.appName || group.windows[0]?.title || "Application",
  }));
}

function updateTaskFocus(): void {
  for (const [button, item] of renderedTasks) {
    button.classList.toggle("is-focused", item.windows.some((win) => win.hwnd === state.focusedHwnd));
  }
}

function render(): void {
  const workspace = activeWorkspace();
  // Preserve capture during background window/icon updates; render fresh on release.
  if (drag && drag.workspaceId === workspace?.id) return;
  finishDrag();
  if (shortcutWorkspace && shortcutWorkspace !== workspace?.id) closeShortcutForm();
  if (menuWorkspace && menuWorkspace !== workspace?.id) closeAppMenu();
  clearTimeout(previewTimer);
  if (previewWorkspace !== workspace?.id) closePreviews();
  renderedTasks.clear();
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

  const layout = readIconLayout(workspace.id);
  const ranks = new Map(layout.order.map((key, index) => [key, index]));
  const items = modelFor(workspace).sort((a, b) => (ranks.get(a.key) ?? Infinity) - (ranks.get(b.key) ?? Infinity));
  elements.empty.textContent = "No windows here yet";
  elements.empty.hidden = items.length > 0;

  for (const item of items) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "task-item";
    button.classList.toggle("is-reorderable", !layout.locked);
    button.addEventListener("dragstart", (event) => event.preventDefault());
    button.addEventListener("pointerdown", (event) => {
      suppressDragClick = false;
      if (event.button !== 0 || !event.isPrimary || readIconLayout(workspace.id).locked) return;
      drag = { button, pointerId: event.pointerId, workspaceId: workspace.id, x: event.clientX, y: event.clientY, moved: false };
      updateAutoHide();
    });
    button.classList.toggle("is-open", item.windows.length > 0);
    button.title = item.label;
    button.setAttribute("aria-label", `${item.label}; right-click for pin options`);
    button.append(createIcon(item));

    if (item.windows.length > 1) {
      button.title = "";
      button.setAttribute("aria-controls", "window-previews");
      button.setAttribute("aria-expanded", "false");
      button.addEventListener("pointerenter", () => {
        clearTimeout(previewCloseTimer);
        clearTimeout(previewTimer);
        previewTimer = setTimeout(() => showPreviews(button, item), 350);
      });
      button.addEventListener("pointerleave", schedulePreviewClose);
      button.addEventListener("keydown", (event) => {
        if (event.key === "ArrowUp") {
          event.preventDefault();
          showPreviews(button, item);
          elements.previews.querySelector<HTMLButtonElement>("button")?.focus();
        }
      });
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

    button.addEventListener("click", (event) => { if (suppressDragClick && event.detail !== 0) return; closePreviews(); activate(item).catch(reportError); });
    button.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      showAppMenu(button, item);
    });
    elements.items.append(button);
    renderedTasks.set(button, item);
  }

  updateTaskFocus();
  if (previewKey) {
    const anchor = [...renderedTasks].find(([, item]) => item.key === previewKey && item.windows.length > 1);
    if (anchor) showPreviews(anchor[0], anchor[1], true);
    else closePreviews();
  }
  updateAutoHide();
}

async function positionWidget(): Promise<void> {
  const monitor = state.monitors.find((entry) => entry.id === monitorId);
  if (!monitor) return;
  const height = Math.round(WIDGET_HEIGHT * monitor.scaleFactor);
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
  subscribe(SeelenEvent.UserAppWindowsPreviewsChanged, ({ payload }) => {
    previews = payload;
    updatePreviewImages();
  }),
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
    // Keep the pressed button mounted between pointer-down and click when the
    // taskbar gains focus, otherwise the first click can be lost.
    updateTaskFocus();
    updateAutoHide();
  }),
  subscribe(SeelenEvent.GlobalMouseMove, ({ payload }) => {
    state.mousePosition = payload;
    updateMouseEdge(payload);
    updateCursorHitbox(payload);
  }),
  subscribe(SeelenEvent.SystemMonitorsChanged, ({ payload }) => {
    closePreviews();
    state.monitors = payload;
    positionWidget().catch(reportError);
  }),
]);

try {
  previews = await invoke(SeelenCommand.GetUserAppWindowsPreviews);
} catch (error) {
  console.warn("Could not load window previews", error);
}

await positionWidget();
render();
setCursorEventsAllowed(false);
await widget.ready();
