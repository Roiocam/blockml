import { describe, expect, it } from "vitest";
import { applyLayout, parse } from "../src/index.js";

const source = `# 顶部注释，必须保留
node a "A" {
  kind: service
  at: 10, 20
  note: """
带 } 的多行
说明"""
}

node b "B"

edge a -> b "调用"
`;

describe("applyLayout", () => {
  it("replaces an existing at without touching anything else", () => {
    const document = parse(source).document;
    const next = applyLayout(source, document, { nodes: new Map([["a", { x: 100, y: 200 }]]) });
    expect(next).toContain("at: 100, 200");
    expect(next).toContain("# 顶部注释，必须保留");
    expect(next).toContain("带 } 的多行");
    expect(next.replace("at: 100, 200", "at: 10, 20")).toBe(source);
  });

  it("expands a block-less node to hold a position", () => {
    const document = parse(source).document;
    const next = applyLayout(source, document, { nodes: new Map([["b", { x: 5, y: 6 }]]) });
    expect(next).toContain('node b "B" {');
    expect(next).toContain("  at: 5, 6");
    expect(parse(next).document.nodes.find((n) => n.id === "b")?.at).toEqual({ x: 5, y: 6 });
  });

  it("inserts via into an edge block-less declaration", () => {
    const document = parse(source).document;
    const edge = document.edges[0]!;
    const next = applyLayout(source, document, { edges: new Map([[edge.id, { x: -30, y: 12 }]]) });
    const reparsed = parse(next);
    expect(reparsed.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(reparsed.document.edges[0]?.via).toEqual({ x: -30, y: 12 });
  });

  it("keeps line numbers valid when several nodes move at once", () => {
    const document = parse(source).document;
    const next = applyLayout(source, document, {
      nodes: new Map([
        ["a", { x: 1, y: 1 }],
        ["b", { x: 2, y: 2 }],
      ]),
    });
    const reparsed = parse(next).document;
    expect(reparsed.nodes.find((n) => n.id === "a")?.at).toEqual({ x: 1, y: 1 });
    expect(reparsed.nodes.find((n) => n.id === "b")?.at).toEqual({ x: 2, y: 2 });
  });
});
