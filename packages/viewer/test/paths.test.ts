import { describe, expect, it } from "vitest";
import {
  boxOf,
  edgeGeometry,
  indexPairs,
  parse,
  sideMidpoint,
  type EdgeDecl,
  type EdgeGeometry,
} from "@block-ml/core";
import { computeHops, edgePath } from "../src/paths.js";

function crossing(): { geos: Map<string, EdgeGeometry>; edges: EdgeDecl[] } {
  const doc = parse(`node a "a" { at: 0, 0 }
node b "b" { at: 0, 200 }
node c "c" { at: 400, 0 }
node d "d" { at: 400, 200 }
edge a -> d "down"
edge b -> c "up"
`).document;
  const nodes = new Map(doc.nodes.map((node) => [node.id, node]));
  const anchors = new Map(
    doc.edges.map((edge) => {
      const from = nodes.get(edge.from)!;
      const to = nodes.get(edge.to)!;
      return [edge.id, {
        from: { point: sideMidpoint(boxOf(from), "right"), side: "right" as const },
        to: { point: sideMidpoint(boxOf(to), "left"), side: "left" as const },
      }];
    }),
  );
  const geos = new Map<string, EdgeGeometry>();
  for (const edge of doc.edges) {
    const geo = edgeGeometry(edge, { byId: nodes, pairs: indexPairs(doc), anchors });
    if (geo) geos.set(edge.id, geo);
  }
  return { geos, edges: doc.edges };
}

describe("curve hops", () => {
  it("puts a hop on the edge drawn above a crossing", () => {
    const { geos, edges } = crossing();
    const result = computeHops(edges, geos);
    const top = edges[1]!;
    expect(result.get(top.id)?.length).toBeGreaterThan(0);
    const path = edgePath(geos.get(top.id)!, result.get(top.id));
    expect(path).toContain("A");
  });

  it("keeps a clean curve as an exact cubic path", () => {
    const doc = parse(`node a "a" { at: 0, 0 }
node b "b" { at: 500, 0 }
edge a -> b "go"
`).document;
    const nodes = new Map(doc.nodes.map((node) => [node.id, node]));
    const edge = doc.edges[0]!;
    const anchors = new Map([
      [edge.id, {
        from: { point: sideMidpoint(boxOf(nodes.get("a")!), "right"), side: "right" as const },
        to: { point: sideMidpoint(boxOf(nodes.get("b")!), "left"), side: "left" as const },
      }],
    ]);
    const geo = edgeGeometry(edge, { byId: nodes, pairs: indexPairs(doc), anchors })!;
    const path = edgePath(geo);
    expect(path).toContain("C");
    expect(path).not.toContain("A");
  });
});
