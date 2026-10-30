import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "../src/index.js";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const files = [
  ...readdirSync(join(root, "examples"))
    .filter((name) => name.endsWith(".blockml"))
    .map((name) => join(root, "examples", name)),
  ...readdirSync(join(root, "skills/blockml/assets"))
    .filter((name) => name.endsWith(".blockml"))
    .map((name) => join(root, "skills/blockml/assets", name)),
];

const STYLE_KEYS = ["at", "via", "dash", "color", "theme", "route", "direction"];

describe("shipped examples", () => {
  it.each(files)("parses cleanly and stays semantic-only: %s", (file) => {
    const source = readFileSync(file, "utf8");
    const result = parse(source);
    expect(result.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    for (const key of STYLE_KEYS) {
      expect(source).not.toMatch(new RegExp(`(^|[\\s{;])${key}\\s*:`));
    }
  });
});
