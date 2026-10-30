import { describe, expect, it } from "vitest";
import {
  alignBoxes,
  bezierAt,
  boxOf,
  distributeBoxes,
  edgeGeometry,
  indexPairs,
  orthogonalRoute,
  parse,
  planSidePorts,
  portPositions,
  routeCrosses,
  serialize,
  sidePoint,
  sideRange,
  snapAlignment,
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

  it("bends around a node instead of taking an aligned shortcut through it", () => {
    const doc = parse(`node a "a" { at: 0, 0 }
node wall "wall" { at: 420, 0 }
node b "b" { at: 400, 200 }
edge a -> b "go"
`).document;
    const docById = new Map(doc.nodes.map((node) => [node.id, node]));
    const edge = doc.edges[0]!;
    const anchors = new Map([
      [edge.id, {
        from: { point: { x: 200, y: 31 }, side: "right" as const },
        to: { point: { x: 500, y: 200 }, side: "top" as const },
      }],
    ]);
    const obstacles = doc.nodes.map((node) => ({ id: node.id, rect: boxOf(node) }));
    const route = orthogonalRoute(edge, { byId: docById, pairs: indexPairs(doc), obstacles, anchors }, 0)!;
    expect(routeCrosses(route.points, [boxOf(docById.get("wall")!)], 0)).toBe(false);
    expect(route.points.some((point) => Math.abs(point.x - 250) < 0.5 && Math.abs(point.y - 150) < 0.5)).toBe(true);
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

describe("side ports", () => {
  const box = { x: 300, y: 130, w: 200, h: 62, cx: 400, cy: 161 };

  it("separates inbound and outbound groups on the same border", () => {
    const ports = planSidePorts(box, "left", [
      { key: "out", desired: 161 },
      { key: "in", desired: 161 },
    ]);
    const inbound = ports.find((port) => port.key === "in")!;
    const outbound = ports.find((port) => port.key === "out")!;

    expect(inbound.point.x).toBe(300);
    expect(outbound.side).toBe("left");
    // The inbound arrow and the outbound start must not sit on one point.
    expect(outbound.point).not.toEqual(inbound.point);
    expect(Math.abs(outbound.point.y - inbound.point.y)).toBeGreaterThanOrEqual(14);
    expect(inbound.point.y).toBeLessThan(outbound.point.y);
  });

  it("gives every bundle on a crowded border its own point", () => {
    const ports = planSidePorts(box, "left", [
      { key: "in", desired: 161 },
      { key: "out", desired: 161 },
      { key: "bundle:http", desired: 161 },
      { key: "bundle:db", desired: 161 },
    ]);
    const range = sideRange(box, "left");
    expect(new Set(ports.map((port) => port.point.y)).size).toBe(4);
    for (const port of ports) {
      expect(port.point.y).toBeGreaterThanOrEqual(range.min - 0.01);
      expect(port.point.y).toBeLessThanOrEqual(range.max + 0.01);
    }
  });

  it("orders groups by their preferred position along the border", () => {
    const ports = planSidePorts(box, "left", [
      { key: "out", desired: 178 },
      { key: "in", desired: 144 },
    ]);
    expect(ports.map((port) => port.key)).toEqual(["in", "out"]);
    expect(ports[0]!.point.y).toBeLessThan(ports[1]!.point.y);
  });

  it("centers a lone port and spreads wider borders", () => {
    expect(portPositions(box, "right", 1)).toEqual([161]);
    const positions = portPositions(box, "bottom", 3);
    expect(positions).toHaveLength(3);
    expect(positions[1]).toBe(400);
    expect(positions[0]!).toBeLessThan(positions[1]!);
    expect(positions[2]!).toBeGreaterThan(positions[1]!);
    expect(positions[0]!).toBeGreaterThanOrEqual(318);
    expect(positions[2]!).toBeLessThanOrEqual(482);
  });

  it("keeps a point on the border", () => {
    expect(sidePoint(box, "left", 0)).toEqual({ x: 300, y: 144 });
    expect(sidePoint(box, "right", 999)).toEqual({ x: 500, y: 178 });
    expect(sidePoint(box, "top", 0)).toEqual({ x: 318, y: 130 });
  });
});

describe("snapAlignment", () => {
  const moving = [{ x: 100, y: 100, w: 200, h: 62 }];

  it("pulls a border onto a nearby target border and spans every box on the line", () => {
    const targets = [
      { x: 320, y: 300, w: 200, h: 62 },
      { x: 320, y: 500, w: 200, h: 62 },
    ];
    const result = snapAlignment(moving, targets, 216, 40, 6);
    expect(result.dx).toBe(220);
    expect(result.dy).toBe(40);
    const guide = result.guides.find((item) => item.axis === "x")!;
    expect(guide.at).toBe(320);
    // one rule covers the dragged box (already shifted 40px down) and both
    // boxes sharing the border
    expect(guide.from).toBe(130);
    expect(guide.to).toBe(572);
  });

  it("aligns centres when that line is closer than any border", () => {
    const target = { x: 340, y: 300, w: 120, h: 62 };
    const result = snapAlignment(moving, [target], 200, 0, 6);
    expect(result.dx).toBe(200);
    expect(result.guides[0]).toMatchObject({ axis: "x", at: 400 });
  });

  it("leaves the drag alone when nothing is within reach", () => {
    const target = { x: 340, y: 300, w: 120, h: 62 };
    expect(snapAlignment(moving, [target], 210, 100, 6)).toEqual({ dx: 210, dy: 100, guides: [] });
  });

  it("snaps each axis on its own", () => {
    const target = { x: 320, y: 300, w: 200, h: 62 };
    const result = snapAlignment(moving, [target], 216, 196, 6);
    expect(result.dx).toBe(220);
    expect(result.dy).toBe(200);
    expect(result.guides.map((item) => item.axis).sort()).toEqual(["x", "y"]);
  });

  it("uses the union bounds for a multi-selection", () => {
    const pair = [
      { x: 100, y: 100, w: 200, h: 62 },
      { x: 100, y: 300, w: 200, h: 62 },
    ];
    // the pair's joint centre is y = 231; the target's centre is 3px away
    const target = { x: 400, y: 200, w: 200, h: 62 };
    const result = snapAlignment(pair, [target], 0, 3, 6);
    expect(result.dy).toBe(0);
    const guide = result.guides.find((item) => item.axis === "y")!;
    expect(guide.at).toBe(231);
    expect(guide.from).toBe(90);
  });

  it("never moves boxes when there is no target or no threshold", () => {
    expect(snapAlignment(moving, [], 7, 9, 6)).toEqual({ dx: 7, dy: 9, guides: [] });
    expect(snapAlignment(moving, [{ x: 104, y: 100, w: 200, h: 62 }], 0, 0, 0))
      .toEqual({ dx: 0, dy: 0, guides: [] });
  });
});

describe("curve obstacle avoidance", () => {
  it("bows around a node sitting on the straight run", () => {
    const doc = parse(`node a "a" { at: 0, 0 }
node mid "mid" { at: 250, 0 }
node b "b" { at: 500, 0 }
edge a -> b "go"
`).document;
    const byId = new Map(doc.nodes.map((node) => [node.id, node]));
    const pairs = indexPairs(doc);
    const obstacles = doc.nodes.map((node) => ({ id: node.id, rect: boxOf(node) }));
    const [edge] = doc.edges;
    const geo = edgeGeometry(edge!, { byId, pairs, obstacles })!;
    const mid = boxOf(byId.get("mid")!);
    let inside = 0;
    for (let i = 1; i < 80; i++) {
      const point = bezierAt(geo.p1, geo.control, geo.p2, i / 80);
      if (
        point.x > mid.x + 1 && point.x < mid.x + mid.w - 1 &&
        point.y > mid.y + 1 && point.y < mid.y + mid.h - 1
      ) inside++;
    }
    expect(inside).toBe(0);
  });

  it("keeps the via control when nothing blocks the curve", () => {
    const doc = parse(`node a "a" { at: 0, 0 }
node b "b" { at: 500, 0 }
edge a -> b "go" { via: 0, -40 }
`).document;
    const byId = new Map(doc.nodes.map((node) => [node.id, node]));
    const pairs = indexPairs(doc);
    const obstacles = doc.nodes.map((node) => ({ id: node.id, rect: boxOf(node) }));
    const geo = edgeGeometry(doc.edges[0]!, { byId, pairs, obstacles })!;
    expect(geo.control).toEqual({ x: 350, y: -9 });
  });

  it("never crosses a node in a dense grid, re-anchoring or detouring", () => {
    const doc = parse(`node order "order" { at: 890, 80 }
node console "console" { at: 620, 80 }
node analytics "analytics" { at: 890, 252 }
node worker "worker" { at: 620, 252 }
node payment "payment" { at: 350, 252 }
node inventory "inventory" { at: 80, 252 }
node pg "pg" { at: 80, 424 }
node redis "redis" { at: 350, 424 }
node stripe "stripe" { at: 620, 424 }
node mailer "mailer" { at: 890, 424 }
edge order -> pg "go"
`).document;
    const byId = new Map(doc.nodes.map((node) => [node.id, node]));
    const pairs = indexPairs(doc);
    const obstacles = doc.nodes.map((node) => ({ id: node.id, rect: boxOf(node) }));
    const edge = doc.edges[0]!;
    const geo = edgeGeometry(edge, { byId, pairs, obstacles })!;
    const blockers = obstacles
      .filter((item) => item.id !== edge.from && item.id !== edge.to)
      .map((item) => item.rect);
    if (geo.detour) {
      expect(routeCrosses(geo.detour, blockers, 0)).toBe(false);
      return;
    }
    for (let i = 1; i < 400; i++) {
      const point = bezierAt(geo.p1, geo.control, geo.p2, i / 400);
      for (const rect of blockers) {
        expect(
          point.x > rect.x && point.x < rect.x + rect.w &&
          point.y > rect.y && point.y < rect.y + rect.h,
        ).toBe(false);
      }
    }
  });
});

describe("routeCrosses", () => {
  it("detects a polyline entering a box and ignores clean or border runs", () => {
    const box = { x: 100, y: -10, w: 60, h: 20 };
    expect(routeCrosses([{ x: 0, y: 0 }, { x: 300, y: 0 }], [box])).toBe(true);
    expect(routeCrosses([{ x: 0, y: 40 }, { x: 300, y: 40 }], [box])).toBe(false);
    // A line running along the border has not entered the box.
    expect(routeCrosses([{ x: 100, y: -30 }, { x: 100, y: 30 }], [box])).toBe(false);
  });
});

describe("alignBoxes", () => {
  const items = [
    { id: "a", rect: { x: 80, y: 80, w: 200, h: 62 } },
    { id: "b", rect: { x: 390, y: 198, w: 200, h: 62 } },
    { id: "c", rect: { x: 700, y: 316, w: 200, h: 62 } },
  ];

  it("centres every box on one column and keeps rows", () => {
    const result = alignBoxes(items, "x");
    expect(result.get("a")).toEqual({ x: 390, y: 80 });
    expect(result.get("b")).toEqual({ x: 390, y: 198 });
    expect(result.get("c")).toEqual({ x: 390, y: 316 });
  });

  it("centres every box on one row and keeps columns", () => {
    const result = alignBoxes(items, "y");
    expect(result.get("a")).toEqual({ x: 80, y: 198 });
    expect(result.get("b")).toEqual({ x: 390, y: 198 });
    expect(result.get("c")).toEqual({ x: 700, y: 198 });
  });

  it("does nothing for a single box", () => {
    expect(alignBoxes(items.slice(0, 1), "x").size).toBe(0);
  });
});

describe("distributeBoxes", () => {
  const items = [
    { id: "low", rect: { x: 0, y: 0, w: 200, h: 62 } },
    { id: "near", rect: { x: 100, y: 0, w: 200, h: 62 } },
    { id: "far", rect: { x: 400, y: 0, w: 200, h: 62 } },
    { id: "end", rect: { x: 600, y: 0, w: 200, h: 62 } },
  ];

  it("spreads the middle boxes evenly and leaves the extremes", () => {
    const result = distributeBoxes(items, "x");
    expect(result.has("low")).toBe(false);
    expect(result.has("end")).toBe(false);
    expect(result.get("near")).toEqual({ x: 200, y: 0 });
    expect(result.get("far")).toEqual({ x: 400, y: 0 });
  });

  it("uses row positions for vertical distribution", () => {
    const column = items.map(({ id, rect }, index) => ({
      id,
      rect: { ...rect, x: 0, y: [0, 100, 400, 600][index]! },
    }));
    const result = distributeBoxes(column, "y");
    expect(result.get("near")).toEqual({ x: 0, y: 200 });
    expect(result.get("far")).toEqual({ x: 0, y: 400 });
    expect(result.has("low")).toBe(false);
    expect(result.has("end")).toBe(false);
  });

  it("needs at least three boxes", () => {
    expect(distributeBoxes(items.slice(0, 2), "x").size).toBe(0);
  });
});
