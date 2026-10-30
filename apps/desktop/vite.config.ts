import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { bundleViewerIife, CORE_SRC, VIEWER_SRC } from "./build/viewer-iife.mjs";

const VIEWER_IIFE = "virtual:blockml-viewer-iife";
const VIEWER_IIFE_ID = "\0" + VIEWER_IIFE;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : [];
  });
}

/**
 * The desktop app already bundles the viewer for its own canvas. Standalone HTML
 * exports need that same viewer as one self-contained script, so build it on
 * demand from source instead of relying on a stale `packages/viewer/dist`.
 */
function viewerIife(): Plugin {
  return {
    name: "blockml-viewer-iife",
    resolveId(id) {
      return id === VIEWER_IIFE ? VIEWER_IIFE_ID : undefined;
    },
    async load(id) {
      if (id !== VIEWER_IIFE_ID) return undefined;
      const text = await bundleViewerIife();
      // Rebuild when either package changes; both source trees are small.
      for (const file of [...sourceFiles(VIEWER_SRC), ...sourceFiles(CORE_SRC)]) this.addWatchFile(file);
      return `export default ${JSON.stringify(text)};`;
    },
  };
}

export default defineConfig({
  clearScreen: false,
  plugins: [viewerIife()],
  resolve: {
    alias: {
      // Bundle straight from source so the desktop shell and the CLI share one viewer.
      "@block-ml/core": fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url)),
      "@block-ml/viewer": fileURLToPath(new URL("../../packages/viewer/src/index.ts", import.meta.url)),
    },
  },
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: "safari15",
    outDir: "dist",
    emptyOutDir: true,
  },
});
