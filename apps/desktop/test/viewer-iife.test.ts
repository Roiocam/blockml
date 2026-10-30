import { describe, expect, it } from "vitest";
import { bundleViewerIife } from "../build/viewer-iife.mjs";

describe("bundleViewerIife", () => {
  it("emits a self-contained script that assigns BlockML", async () => {
    const script = await bundleViewerIife();
    expect(script).toContain("var BlockML");
    expect(script).toContain("function mount");
  });
});
