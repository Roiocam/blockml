/// <reference types="vite/client" />

declare module "virtual:blockml-viewer-iife" {
  /** Self-contained IIFE that assigns `globalThis.BlockML`. */
  const script: string;
  export default script;
}
