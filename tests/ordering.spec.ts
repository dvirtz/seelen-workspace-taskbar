import { test, expect } from "./fixtures/index.js";

test("drag order persists, Escape and outside drops cancel, and locking prevents dragging", async ({ desktop, taskbar }) => {
  const { page, title } = desktop;
  const labels = ["A", "B", "C"].map(suffix => `${title} ${suffix}`);
  for (const label of labels) await taskbar.addShortcut(label);
  const order = () => page.locator("#task-items > button").evaluateAll(buttons => buttons.map(button => button.getAttribute("aria-label")));
  const drag = async (cancel?: "escape" | "outside") => {
    const from = await taskbar.app(labels[0]).boundingBox();
    const to = await taskbar.app(labels[2]).boundingBox();
    expect(from).not.toBeNull(); expect(to).not.toBeNull();
    await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
    await page.mouse.down();
    try {
      await page.mouse.move(to!.x + to!.width - 2, to!.y + to!.height / 2, { steps: 12 });
      if (cancel === "escape") await page.keyboard.press("Escape");
      if (cancel === "outside") await page.mouse.move(to!.x, 5, { steps: 4 });
    } finally { await page.mouse.up(); }
  };
  const initial = await order();
  await drag("escape");
  await expect.poll(order).toEqual(initial);
  await drag("outside");
  await expect.poll(order).toEqual(initial);
  await drag();
  await expect.poll(order).not.toEqual(initial);
  const changed = await order();
  await page.reload();
  await expect.poll(order).toEqual(changed);
  await taskbar.menu(taskbar.app(labels[0]), "Lock icon order");
  await expect(taskbar.app(labels[0])).not.toHaveClass(/is-reorderable/);
  await page.reload();
  await expect(taskbar.app(labels[0])).not.toHaveClass(/is-reorderable/);
  await drag();
  await expect.poll(order).toEqual(changed);
  await taskbar.menu(taskbar.app(labels[0]), "Unlock icon order");
  await expect(taskbar.app(labels[0])).toHaveClass(/is-reorderable/);
});

