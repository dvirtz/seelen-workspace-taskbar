import "./build.mjs";

import { mkdir, readdir, rename } from "node:fs/promises";
import path from "node:path";
import { runWidgetCommand, widgetDirectory } from "./widget.mjs";

const bundleDirectory = path.resolve("dist/bundles");

await runWidgetCommand("bundle");

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
