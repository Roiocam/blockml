import { describe, expect, it } from "vitest";
import {
  boxOf,
  edgeGeometry,
  indexPairs,
  orthogonalRoute,
  parse,
  serialize,
  sideRange,
} from "../src/index.js";

const source = `node hub "hub" { at: 0, 0 }
node a "a" { at: 400, 100 }
node b "b" { at: 400, 40 }

edge hub -> a "one"
edge hub -> b "two"
`;

const document = parse(source).document;
const byId = new Map(document.nodes.map((node) => [node.id, node]));
const pairs = indexPairs(document);
const [first, second] = document.edges;
const fans = new Map([
  [first!.id, { from: 6 }],
  [second!.id, { from: -6 }],
]);

describe("edge anchors", () => {
  it("fans edges that leave the same node along its border", () => {
    const a = edgeGeometry(first!, { byId, pairs, fans })!;
    const b = edgeGeometry(second!, { byId, pairs, fans })!;
    expect(a.p1.x).toBe(200);
    expect(b.p1.x).toBe(200);
    expect(a.p1.y).not.toBe(b.p1.y);
  });

  it("clamps fanned anchors inside the node border", () => {
    const geo = edgeGeometry(first!, { byId, pairs, fans: new Map([[first!.id, { from: 500 }]]) })!;
    expect(geo.p1.y).toBe(48);
  });

  it("leaves the far anchor untouched", () => {
    const plain = edgeGeometry(first!, { byId, pairs })!;
    const fanned = edgeGeometry(first!, { byId, pairs, fans })!;
    expect(plain.p2).toEqual(fanned.p2);
    expect(plain.p1.y).toBe(56);
    expect(fanned.p1.y).toBe(48);
  });
});

const routed = parse(`diagram { route: orthogonal }
node hub "hub" { at: 0, 0 }
node right "right" { at: 500, 60 }
node below "below" { at: 140, 420 }

edge hub -> right "1"
edge hub -> below "2"
`).document;

describe("orthogonalRoute", () => {
  const byId = new Map(routed.nodes.map((node) => [node.id, node]));
  const pairs = indexPairs(routed);
  const ctx = { byId, pairs };

  it("only uses axis-aligned segments", () => {
    for (const edge of routed.edges) {
      const route = orthogonalRoute(edge, ctx)!;
      for (let i = 1; i < route.points.length; i++) {
        const a = route.points[i - 1]!;
        const b = route.points[i]!;
        expect(a.x === b.x || a.y === b.y).toBe(true);
      }
    }
  });

  it("leaves the source perpendicular to the border it touches", () => {
    const route = orthogonalRoute(routed.edges[0]!, ctx)!;
    const first = route.points[0]!;
    const second = route.points[1]!;
    // hub's right border: the edge must leave horizontally.
    expect(first.x).toBe(200);
    expect(second.y).toBe(first.y);
  });

  it("connects the two node borders and never starts inside a node", () => {
    for (const edge of routed.edges) {
      const route = orthogonalRoute(edge, ctx)!;
      const start = route.points[0]!;
      const end = route.points[route.points.length - 1]!;
      const from = byId.get(edge.from)!;
      const to = byId.get(edge.to)!;
      expect(start.x === from.at!.x || start.x === from.at!.x + 200 || start.y === from.at!.y || start.y === from.at!.y + 62).toBe(true);
      expect(end.x === to.at!.x || end.x === to.at!.x + 200 || end.y === to.at!.y || end.y === to.at!.y + 62).toBe(true);
    }
  });

  it("parses and serializes the route attribute", () => {
    expect(routed.diagram?.route).toBe("orthogonal");
    expect(serialize(routed)).toContain("route: orthogonal");
    expect(parse("diagram { title: \"x\" }").document.diagram?.route).toBe("curve");
  });
});

describe("lane shifts", () => {
  // `kh` blocks the direct run, pushing the router onto the aligned mixed-side
  // template — the case that used to ignore the lane and draw two edges 1px apart.
  const aligned = parse(`node eval "eval" { at: 1181, 363 }
node app "app" { at: 340, 280 }
node kh "kh" { at: 924, 361 }
edge eval -> app "rpc"
`).document;
  const byId = new Map(aligned.nodes.map((node) => [node.id, node]));
  const edge = aligned.edges[0]!;
  const ctx = {
    byId,
    pairs: indexPairs(aligned),
    obstacles: aligned.nodes.map((node) => ({ id: node.id, rect: boxOf(node) })),
  };

  it("moves aligned mixed-side routes to a different lane", () => {
    const lane0 = orthogonalRoute(edge, ctx, 0)!;
    const lane1 = orthogonalRoute(edge, ctx, 1)!;
    const runY = (route: typeof lane0) => route.points[1]!.y;
    expect(Math.abs(runY(lane0) - runY(lane1))).toBeGreaterThanOrEqual(8);
  });

  it("keeps an aligned route honest about its lane", () => {
    const route = orthogonalRoute(edge, ctx, 2)!;
    for (let i = 1; i < route.points.length; i++) {
      const a = route.points[i - 1]!;
      const b = route.points[i]!;
      expect(a.x === b.x || a.y === b.y).toBe(true);
    }
  });
});

describe("edge bundles", () => {
  const doc = parse(`node app "app" { at: 0, 0 }
node wecom "wecom" { at: 400, -40 }
node feishu "feishu" { at: 400, 60 }
edge app -> wecom "one" { bundle: channels }
edge app -> feishu "two" { bundle: channels }
`).document;
  const byId = new Map(doc.nodes.map((node) => [node.id, node]));
  const [first, second] = doc.edges;
  const anchor = { point: { x: 200, y: 31 }, side: "right" as const };
  const anchors = new Map([
    [first!.id, { from: anchor }],
    [second!.id, { from: anchor }],
  ]);
  const trunks = new Map([
    [first!.id, { x: 300 }],
    [second!.id, { x: 300 }],
  ]);
  const ctx = { byId, pairs: indexPairs(doc), anchors, trunks };

  it("shares the endpoint and trunk before branching", () => {
    const a = orthogonalRoute(first!, ctx, 0)!;
    const b = orthogonalRoute(second!, ctx, 0)!;
    // Points 0..1 are the shared run (the stub merges into it), then they split.
    expect(a.points[0]).toEqual(anchor.point);
    expect(a.points[1]).toEqual(b.points[1]);
    expect(a.points[1]!.x).toBe(300);
    expect(a.points[2]!.y).not.toBe(b.points[2]!.y);
  });

  it("keeps bundled routes axis-aligned", () => {
    for (const edge of doc.edges) {
      const route = orthogonalRoute(edge, ctx, 0)!;
      for (let i = 1; i < route.points.length; i++) {
        const p = route.points[i - 1]!;
        const q = route.points[i]!;
        expect(p.x === q.x || p.y === q.y).toBe(true);
      }
    }
  });

  it("round-trips the bundle attribute", () => {
    expect(first!.bundle).toBe("channels");
    expect(serialize(doc)).toContain("bundle: channels");
    expect(parse("node a \"a\" { at: 0, 0 }\nnode b \"b\" { at: 200, 0 }\nedge a -> b").document.edges[0]!.bundle).toBeNull();
  });
});

describe("sideRange", () => {
  it("measures the usable stretch of each border", () => {
    const box = { x: 0, y: 0, w: 200, h: 62 };
    expect(sideRange(box, "right")).toEqual({ min: 14, max: 48 });
    expect(sideRange(box, "left")).toEqual({ min: 14, max: 48 });
    expect(sideRange(box, "top")).toEqual({ min: 18, max: 182 });
    expect(sideRange(box, "bottom")).toEqual({ min: 18, max: 182 });
  });
});
