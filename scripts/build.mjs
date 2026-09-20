import { build } from "esbuild";
import { copyFile, mkdir, rm } from "node:fs/promises";

const outputDirectory = "dist/widget";

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

await Promise.all([
  copyFile("src/metadata.yml", `${outputDirectory}/metadata.yml`),
  copyFile("src/index.html", `${outputDirectory}/index.html`),
  copyFile("src/index.css", `${outputDirectory}/index.css`),
]);

await build({
  entryPoints: ["src/index.ts"],
  outfile: `${outputDirectory}/index.js`,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: false,
  sourcemap: "inline",
  logLevel: "info",
});
