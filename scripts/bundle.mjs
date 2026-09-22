import "./build.mjs";

import { execFile } from "node:child_process";
import { mkdir, readdir, rename } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const widgetDirectory = path.resolve("dist/widget");
const bundleDirectory = path.resolve("dist/bundles");
const slu = process.env.SLU_PATH || (process.platform === "win32"
  ? "C:\\Program Files\\Seelen\\Seelen UI\\slu.exe"
  : "slu");

const { stdout, stderr } = await execFileAsync(
  slu,
  ["resource", "bundle", "widget", widgetDirectory],
  { cwd: process.cwd() },
);

if (stdout.trim()) console.log(stdout.trim());
if (stderr.trim()) console.error(stderr.trim());

const generatedBundles = (await readdir(widgetDirectory))
  .filter((name) => name.startsWith("bundle ") && name.endsWith(".yml"))
  .sort();

const generatedBundle = generatedBundles.at(-1);
if (!generatedBundle) {
  throw new Error("Seelen CLI did not create a widget bundle");
}

await mkdir(bundleDirectory, { recursive: true });
const destination = path.join(bundleDirectory, generatedBundle);
await rename(path.join(widgetDirectory, generatedBundle), destination);
console.log(`Bundle moved to: ${destination}`);
