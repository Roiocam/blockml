import { describe, expect, it } from "vitest";
import { defaultLayout, layoutDocument, parse, relatedEdges, relatedNodes } from "../src/index.js";
import type { LayoutAlgorithm } from "../src/index.js";

const source = `group access "接入" { color: #f59e0b }
group core "核心" { color: #4f46e5 }
group data "数据" { color: #10b981 }

node web "web" { group: access, kind: ui }
node gw "gateway" { group: access }
node order "order" { group: core }
node stock "inventory" { group: core }
node pay "payment" { group: core }
node pg "PostgreSQL" { group: data, kind: db }
node cache "Redis" { group: data, kind: cache }

edge web -> gw "https"
edge gw -> order "rest"
edge gw -> stock "rest"
edge order -> stock "rest"
edge order -> pay "rest"
edge order -> pg "sql"
edge stock -> pg "sql"
edge pay -> cache "cache"
`;

const document = parse(source).document;
const algorithms: LayoutAlgorithm[] = ["layered", "pipeline", "snowflake", "compact"];

describe("layoutDocument", () => {
  for (const algorithm of algorithms) {
    it(`${algorithm}: positions every node exactly once`, () => {
      const result = layoutDocument(document, algorithm);
      expect(result.size).toBe(document.nodes.length);
      for (const node of document.nodes) {
        const point = result.get(node.id);
        expect(point).toBeDefined();
        expect(Number.isInteger(point!.x)).toBe(true);
        expect(Number.isInteger(point!.y)).toBe(true);
      }
    });

    it(`${algorithm}: no two nodes overlap`, () => {
      const result = layoutDocument(document, algorithm);
      const boxes = [...result.values()].map((p) => ({ x: p.x, y: p.y }));
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i]!;
          const b = boxes[j]!;
          const overlap = Math.abs(a.x - b.x) < 200 && Math.abs(a.y - b.y) < 62;
          expect(overlap, `${algorithm}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`).toBe(false);
        }
      }
    });

    it(`${algorithm}: is deterministic`, () => {
      const a = layoutDocument(document, algorithm);
      const b = layoutDocument(document, algorithm);
      expect([...a.entries()]).toEqual([...b.entries()]);
    });
  }

  it("layered keeps a group in one column, ordered by dependency", () => {
    const result = layoutDocument(document, "layered");
    // Same group => same column
    expect(result.get("web")!.x).toBe(result.get("gw")!.x);
    expect(result.get("order")!.x).toBe(result.get("pay")!.x);
    // Groups follow dependency depth
    expect(result.get("gw")!.x).toBeLessThan(result.get("order")!.x);
    expect(result.get("order")!.x).toBeLessThan(result.get("pg")!.x);
  });

  it("pipeline follows group declaration order", () => {
    const result = layoutDocument(document, "pipeline");
    expect(result.get("web")!.x).toBeLessThan(result.get("order")!.x);
    expect(result.get("order")!.x).toBeLessThan(result.get("pg")!.x);
  });

  it("snowflake puts the most connected node at the centre of the rings", () => {
    const result = layoutDocument(document, "snowflake");
    const xs = [...result.values()].map((p) => p.x);
    const ys = [...result.values()].map((p) => p.y);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const distance = (id: string) => {
      const p = result.get(id)!;
      return Math.hypot(p.x + 100 - cx, p.y + 31 - cy); // box centres, not corners
    };
    // order has the highest degree in this graph, so it owns the centre.
    for (const node of document.nodes) {
      if (node.id === "order") continue;
      expect(distance("order")).toBeLessThan(distance(node.id));
    }
    // Normalisation keeps every coordinate at or past the origin.
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(80);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(80);
  });

  it("compact fills a roughly square grid", () => {
    const result = layoutDocument(document, "compact");
    const xs = new Set([...result.values()].map((p) => p.x));
    const ys = new Set([...result.values()].map((p) => p.y));
    expect(xs.size * ys.size).toBeGreaterThanOrEqual(document.nodes.length);
  });

  it("survives cycles", () => {
    const cyclic = parse(`node a "A"\nnode b "B"\nedge a -> b\nedge b -> a`).document;
    const result = layoutDocument(cyclic, "layered");
    expect(result.size).toBe(2);
  });
});

describe("defaultLayout", () => {
  it("uses the layered algorithm when no node has a position", () => {
    const result = defaultLayout(document);
    expect(result.get("web")!.x).toBe(result.get("gw")!.x);
    expect(result.get("gw")!.x).toBeLessThan(result.get("order")!.x);
    expect(result.get("order")!.x).toBeLessThan(result.get("pg")!.x);
    expect(result.get("web")!.x).toBeGreaterThanOrEqual(80);
  });

  it("keeps hand-written coordinates and only fills the gaps", () => {
    const doc = parse(`group core "核心" { }
node fixed "fixed" { group: core, at: 5000, 5000 }
node loose "loose" { group: core }
node other "other" { group: core }
edge loose -> other "x"
`).document;
    const result = defaultLayout(doc);
    expect(result.get("fixed")).toEqual({ x: 5000, y: 5000 });
    expect(result.get("loose")).toBeDefined();
    expect(result.get("other")).toBeDefined();
  });

  it("is deterministic", () => {
    expect([...defaultLayout(document).entries()]).toEqual([...defaultLayout(document).entries()]);
  });

  it("keeps every other node still after one node is dragged", () => {
    const doc = parse(source).document;
    const before = defaultLayout(doc);
    const moved = before.get("gw")!;
    doc.nodes.find((node) => node.id === "gw")!.at = { x: moved.x + 120, y: moved.y + 40 };
    const after = defaultLayout(doc);
    expect(after.get("gw")).toEqual({ x: moved.x + 120, y: moved.y + 40 });
    for (const node of doc.nodes) {
      if (node.id === "gw") continue;
      expect(after.get(node.id)).toEqual(before.get(node.id));
    }
  });
});

describe("highlight helpers", () => {
  it("collects edges touching a node", () => {
    const set = relatedEdges(document, "order");
    expect(set.size).toBe(4);
  });

  it("collects the node and its neighbours", () => {
    const set = relatedNodes(document, "order");
    expect([...set].sort()).toEqual(["gw", "order", "pay", "pg", "stock"]);
  });

  it("returns empty for null", () => {
    expect(relatedEdges(document, null).size).toBe(0);
  });
});
