import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  resolve: {
    alias: {
      // Bundle straight from source so the desktop shell and the CLI share one viewer.
      "@blockml/core": fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url)),
      "@blockml/viewer": fileURLToPath(new URL("../../packages/viewer/src/index.ts", import.meta.url)),
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
