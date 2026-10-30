import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

describe("desktop toolbar parity", () => {
  it("keeps the reader controls the standalone HTML also offers", () => {
    for (const id of ["mode", "layers", "layout", "route", "fit", "zoom-in", "zoom-out"]) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it("hides editing-only controls in presentation mode", () => {
    expect(css).toContain('body[data-mode="presentation"] #layers');
    expect(css).toContain('body[data-mode="presentation"] #layout');
  });
});
