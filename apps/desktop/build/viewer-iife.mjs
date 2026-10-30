import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = new URL("../../../", import.meta.url);

const VIEWER_ENTRY = fileURLToPath(new URL("packages/viewer/src/index.ts", root));
const CORE_ENTRY = fileURLToPath(new URL("packages/core/src/index.ts", root));
export const VIEWER_SRC = fileURLToPath(new URL("packages/viewer/src", root));
export const CORE_SRC = fileURLToPath(new URL("packages/core/src", root));

/** Bundle the viewer exactly as the standalone HTML reader expects it. */
export async function bundleViewerIife() {
  const result = await build({
    entryPoints: [VIEWER_ENTRY],
    bundle: true,
    format: "iife",
    globalName: "BlockML",
    target: ["safari15"],
    write: false,
    logLevel: "silent",
    alias: { "@block-ml/core": CORE_ENTRY },
  });
  const text = result.outputFiles?.[0]?.text;
  if (!text) throw new Error("esbuild did not emit the viewer IIFE");
  return text;
}
