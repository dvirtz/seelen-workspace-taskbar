import { copyFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { runWidgetCommand } from "./widget.mjs";

try {
  if (process.platform !== "win32" || !process.env.APPDATA) {
    throw new Error("Installing into Seelen requires Windows and APPDATA.");
  }

  const bundleDirectory = path.resolve("dist/bundles");
  const entries = await readdir(bundleDirectory, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const latestBundle = entries
    .filter((entry) => entry.isFile() && /^bundle .*\.yml$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .at(-1);
  if (!latestBundle) {
    throw new Error("No local bundle found. Run npm run bundle first.");
  }

  const widgetsDirectory = path.join(process.env.APPDATA, "com.seelen.seelen-ui", "widgets");
  const destination = path.join(widgetsDirectory, "workspace-taskbar.yml");
  await mkdir(widgetsDirectory, { recursive: true });
  await copyFile(path.join(bundleDirectory, latestBundle), destination);
  console.log(`Installed ${latestBundle} to: ${destination}`);
  await runWidgetCommand("load", destination);
} catch (error) {
  console.error(error);
  process.exitCode = typeof error.code === "number" ? error.code : 1;
}
