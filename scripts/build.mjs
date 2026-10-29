import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const shared = {
  bundle: true,
  sourcemap: false,
  target: ["es2022"],
  logLevel: "info",
};

async function ensure(path) {
  await mkdir(path, { recursive: true });
}

async function buildCore() {
  await ensure(resolve(root, "packages/core/dist"));
  await build({
    ...shared,
    entryPoints: [resolve(root, "packages/core/src/index.ts")],
    outfile: resolve(root, "packages/core/dist/index.js"),
    format: "esm",
  });
}

async function buildViewer() {
  await ensure(resolve(root, "packages/viewer/dist"));
  await build({
    ...shared,
    entryPoints: [resolve(root, "packages/viewer/src/index.ts")],
    outfile: resolve(root, "packages/viewer/dist/index.js"),
    format: "esm",
    external: ["@blockml/core"],
  });

  await build({
    ...shared,
    entryPoints: [resolve(root, "packages/viewer/src/index.ts")],
    outfile: resolve(root, "packages/viewer/dist/viewer.iife.js"),
    format: "iife",
    globalName: "BlockML",
  });

  // Ship the stylesheet as plain CSS too, for consumers that prefer a file.
  const stylesSource = await readFile(resolve(root, "packages/viewer/src/styles.ts"), "utf8");
  const match = /export const VIEWER_CSS = `([\s\S]*)`;/.exec(stylesSource);
  if (match) {
    await writeFile(resolve(root, "packages/viewer/dist/styles.css"), match[1], "utf8");
  }
}

async function buildCli() {
  await ensure(resolve(root, "packages/cli/dist"));
  await build({
    ...shared,
    entryPoints: [resolve(root, "packages/cli/src/index.ts")],
    outfile: resolve(root, "packages/cli/dist/cli.js"),
    format: "esm",
    platform: "node",
    packages: "external",
  });
}

await buildCore();
await buildViewer();
await buildCli();
console.log("build complete");
