import { execFile } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const widgetDirectory = path.resolve("dist/widget");

export async function runWidgetCommand(action, resourcePath = widgetDirectory) {
  if (!["load", "unload", "bundle"].includes(action)) {
    throw new Error("Expected widget action: load, unload, or bundle");
  }

  const slu = process.env.SLU_PATH || (process.platform === "win32"
    ? "C:\\Program Files\\Seelen\\Seelen UI\\slu.exe"
    : "slu");
  const { stdout, stderr } = await execFileAsync(
    slu,
    ["resource", action, "widget", resourcePath],
    { cwd: process.cwd() },
  );
  if (stdout.trim()) console.log(stdout.trim());
  if (stderr.trim()) console.error(stderr.trim());
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await runWidgetCommand(process.argv[2]);
  } catch (error) {
    console.error(error);
    process.exitCode = typeof error.code === "number" ? error.code : 1;
  }
}
