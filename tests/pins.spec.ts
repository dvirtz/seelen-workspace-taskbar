import { test, expect } from "./fixtures/index.js";

test("shortcut form prefills, validates, saves, edits, cancels and unpins", async ({ desktop, taskbar }) => {
  const { page, title } = desktop;
  const source = await taskbar.helperButton(title);
  await taskbar.menu(source, /^Pin shortcut/);
  const form = page.locator("#shortcut-form");
  await expect(form.getByLabel("Name", { exact: true })).toBeFocused();
  await expect(form.getByLabel("Name", { exact: true })).not.toHaveValue("");
  await expect(form.getByLabel("Application or shortcut path")).not.toHaveValue("");
  await form.getByLabel("Name", { exact: true }).fill("");
  await form.getByRole("button", { name: "Pin shortcut", exact: true }).click();
  await expect(form).toBeVisible();
  expect(await taskbar.pins()).toEqual([]);
  await form.getByRole("button", { name: "Cancel" }).click();

  const label = `${title} shortcut`;
  const path = "C:\\Windows\\System32\\notepad.exe";
  await taskbar.addShortcut(label, `"${path}"`, '--profile "Work profile"', '"C:\\Windows"');
  const saved = (await taskbar.pins())[0];
  expect(saved).toMatchObject({ label, path, relaunch: { command: path, args: '--profile "Work profile"', workingDir: "C:\\Windows" } });
  await taskbar.menu(taskbar.app(label), /^Edit shortcut/);
  await expect(form.getByLabel("Arguments (optional)")).toHaveValue('--profile "Work profile"');
  await form.getByLabel("Name", { exact: true }).fill("Cancelled edit");
  await form.getByRole("button", { name: "Cancel" }).click();
  expect(await taskbar.pins()).toEqual([saved]);

  await taskbar.menu(taskbar.app(label), /^Edit shortcut/);
  await form.getByLabel("Name", { exact: true }).fill(`${label} edited`);
  await form.getByLabel("Application or shortcut path").fill("C:\\Seelen test\\Example.lnk");
  await form.getByRole("button", { name: "Save changes" }).click();
  expect(await taskbar.pins()).toHaveLength(1);
  expect((await taskbar.pins())[0]).toMatchObject({ key: saved.key, label: `${label} edited`, path: "C:\\Seelen test\\Example.lnk" });
  await page.reload();
  await expect(taskbar.app(`${label} edited`)).toBeAttached();
  await taskbar.menu(taskbar.app(`${label} edited`), "Unpin");
  await expect(taskbar.app(`${label} edited`)).toHaveCount(0);
  expect(await taskbar.pins()).toEqual([]);
});

test("running applications can be pinned and unpinned", async ({ desktop, taskbar }) => {
  const { page, title } = desktop;
  const button = await taskbar.helperButton(title);
  await taskbar.menu(button, "Pin application");
  await expect(button.locator(".pin-mark")).toHaveCount(1);
  expect(await taskbar.pins()).toHaveLength(1);
  await page.reload();
  await expect(button.locator(".pin-mark")).toHaveCount(1);
  await taskbar.menu(button, "Unpin");
  await expect(button.locator(".pin-mark")).toHaveCount(0);
  await expect(button).toHaveClass(/is-open/);
});

test("pins and running windows follow the active workspace and stay local to a monitor", async ({ desktop, taskbar, seelen }) => {
  const { title } = desktop;
  const original = await seelen.workspace();
  const id = await seelen.monitorId();
  const other = (await seelen.desktops()).monitors[id].workspaces.flat().find(entry => entry.id !== original.id);
  test.skip(!other, "Requires two existing Seelen workspaces on a tested monitor.");
  const label = `${title} workspace pin`;
  await taskbar.addShortcut(label);
  for (const other of desktop.taskbars.filter(candidate => candidate !== taskbar)) await expect(other.app(label)).toHaveCount(0);
  const helper = (await seelen.windows()).find(win => win.title.startsWith(title))!;
  await seelen.switchWorkspace(other!.id);
  await expect(taskbar.app(label)).toHaveCount(0);
  await expect(taskbar.app(helper.appName)).toHaveCount(0);
  await taskbar.checkWindowCount();
  await seelen.invoke("move_window_to_workspace", { hwnd: helper.hwnd, workspaceId: other!.id });
  await expect(taskbar.app(helper.appName)).toHaveClass(/is-open/);
  await taskbar.checkWindowCount();
  await seelen.switchWorkspace(original.id);
  await expect(taskbar.app(label)).toBeAttached();
  await expect(taskbar.app(helper.appName)).toHaveCount(0);
  await taskbar.checkWindowCount();
});

