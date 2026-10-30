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
  pathMetrics,
  placeLabelOnPath,
  planPorts,
  planSidePorts,
  portPositions,
  routeCrosses,
  sampleEdgePath,
  serialize,
  sideAlong,
  sideMidpoint,
  sidePoint,
  sideRange,
  snapAlignment,
  planCurveSides,
  type EdgeDecl,
  type EdgeSide,
  type Point,
  type SideUse,
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

const SIDE_OUT: Record<EdgeSide, Point> = {
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
};

function angle(a: Point, b: Point): number {
  const dot = a.x * b.x + a.y * b.y;
  const la = Math.hypot(a.x, a.y);
  const lb = Math.hypot(b.x, b.y);
  if (!la || !lb) return 90;
  return (Math.acos(Math.max(-1, Math.min(1, dot / la / lb))) * 180) / Math.PI;
}

function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function curveBetween(
  fromAt: Point,
  toAt: Point,
  fromSide: EdgeSide,
  toSide: EdgeSide,
  via?: Point,
) {
  const doc = parse(`node a "a" { at: ${fromAt.x}, ${fromAt.y} }
node b "b" { at: ${toAt.x}, ${toAt.y} }
edge a -> b "go"${via ? ` { via: ${via.x}, ${via.y} }` : ""}
`).document;
  const edge = doc.edges[0]!;
  const nodes = new Map(doc.nodes.map((node) => [node.id, node]));
  const from = nodes.get("a")!;
  const to = nodes.get("b")!;
  const anchors = new Map([
    [edge.id, {
      from: { point: sideMidpoint(boxOf(from), fromSide), side: fromSide },
      to: { point: sideMidpoint(boxOf(to), toSide), side: toSide },
    }],
  ]);
  return edgeGeometry(edge, { byId: nodes, pairs: indexPairs(doc), anchors })!;
}

describe("shared side ports", () => {
  const portDoc = parse(`node hub "hub" { at: 0, 0 }
node a "a" { at: 400, -200 }
node b "b" { at: 400, -100 }
node c "c" { at: 400, 0 }
node d "d" { at: 400, 100 }
node e "e" { at: 400, 200 }

edge a -> hub "in-a"
edge b -> hub "in-b"
edge hub -> c "out-c"
edge hub -> d "out-d"
edge hub -> e "out-e"
`).document;
  const hub = boxOf(portDoc.nodes[0]!);
  const edges = new Map(portDoc.edges.map((edge) => [edge.id, edge]));
  const use = (keys: string[]): SideUse => ({
    box: hub,
    side: "right",
    ins: ["e1", "e2"].filter((id) => keys.includes(id)).map((id) => ({ edge: edges.get(id)!, desired: 31 })),
    outs: ["e3", "e4", "e5"].filter((id) => keys.includes(id)).map((id) => ({ edge: edges.get(id)!, desired: 31 })),
    bundles: [],
  });

  it("gives every same-direction edge one shared port", () => {
    const assignments = planPorts([use(["e3", "e4", "e5"])]);
    expect(assignments).toHaveLength(3);
    expect(new Set(assignments.map((item) => `${item.point.x},${item.point.y}`)).size).toBe(1);
  });

  it("keeps inbound and outbound groups on separate ports (<= 2 for 5 edges)", () => {
    const assignments = planPorts([use(["e1", "e2", "e3", "e4", "e5"])]);
    const points = new Set(assignments.map((item) => `${item.point.x},${item.point.y}`));
    expect(points.size).toBe(2);
    const inbound = assignments.filter((item) => item.end === "to");
    const outbound = assignments.filter((item) => item.end === "from");
    expect(new Set(inbound.map((item) => `${item.point.x},${item.point.y}`)).size).toBe(1);
    expect(new Set(outbound.map((item) => `${item.point.x},${item.point.y}`)).size).toBe(1);
    expect(inbound[0]!.point).not.toEqual(outbound[0]!.point);
  });

  it("gives every bundle its own port beside in/out", () => {
    const bundleEdges = ["e3", "e4"].map((id) => edges.get(id)!);
    const assignments = planPorts([
      {
        ...use(["e1", "e5"]),
        bundles: [{ key: "bundle:http", desired: 31, edges: bundleEdges, end: "from" }],
      },
    ]);
    const bundlePoints = new Set(
      assignments.filter((item) => item.end === "from" && bundleEdges.some((edge) => edge.id === item.edgeId))
        .map((item) => `${item.point.x},${item.point.y}`),
    );
    expect(bundlePoints.size).toBe(1);
    const all = new Set(assignments.map((item) => `${item.point.x},${item.point.y}`));
    expect(all.size).toBe(3);
  });
});

describe("curve geometry", () => {
  it("leaves and enters every border along its normal with a straight stub", () => {
    const cases: { from: Point; to: Point; fromSide: EdgeSide; toSide: EdgeSide }[] = [
      { from: { x: 0, y: 0 }, to: { x: 500, y: 200 }, fromSide: "right", toSide: "left" },
      { from: { x: 0, y: 0 }, to: { x: 500, y: 200 }, fromSide: "bottom", toSide: "top" },
      { from: { x: 0, y: 0 }, to: { x: 500, y: 200 }, fromSide: "right", toSide: "top" },
      { from: { x: 0, y: 0 }, to: { x: 500, y: 200 }, fromSide: "left", toSide: "bottom" },
    ];
    for (const item of cases) {
      const geo = curveBetween(item.from, item.to, item.fromSide, item.toSide);
      const firstSegment = geo.segments![0]!;
      const lastSegment = geo.segments![geo.segments!.length - 1]!;
      expect(firstSegment.type).toBe("line");
      expect(lastSegment.type).toBe("line");
      const startAngle = angle(
        { x: firstSegment.b.x - firstSegment.a.x, y: firstSegment.b.y - firstSegment.a.y },
        SIDE_OUT[item.fromSide],
      );
      const endAngle = angle(
        { x: lastSegment.b.x - lastSegment.a.x, y: lastSegment.b.y - lastSegment.a.y },
        { x: -SIDE_OUT[item.toSide].x, y: -SIDE_OUT[item.toSide].y },
      );
      expect(startAngle).toBeLessThanOrEqual(0.5);
      expect(endAngle).toBeLessThanOrEqual(0.5);
      const fromStub = distance(geo.p1, firstSegment.b);
      const toStub = distance(lastSegment.a, geo.p2);
      expect(fromStub).toBeGreaterThanOrEqual(8);
      expect(fromStub).toBeLessThanOrEqual(24);
      expect(toStub).toBeGreaterThanOrEqual(8);
      expect(toStub).toBeLessThanOrEqual(24);
    }
  });

  it("keeps an unobstructed straight edge flat", () => {
    const geo = curveBetween({ x: 0, y: 0 }, { x: 500, y: 0 }, "right", "left");
    for (const point of sampleEdgePath(geo, 32)) {
      expect(Math.abs(point.y - 31)).toBeLessThan(0.001);
    }
  });

  it("bends through the via point", () => {
    const geo = curveBetween({ x: 0, y: 0 }, { x: 500, y: 0 }, "right", "left", { x: 0, y: -40 });
    expect(geo.control).toEqual({ x: 350, y: -9 });
    const samples = sampleEdgePath(geo, 80);
    expect(samples.some((point) => Math.abs(point.x - 350) < 1 && Math.abs(point.y + 9) < 1)).toBe(true);
  });

  it("uses the forced port as the exact endpoint", () => {
    const geo = curveBetween({ x: 0, y: 0 }, { x: 500, y: 0 }, "right", "left");
    expect(geo.p1).toEqual({ x: 200, y: 31 });
    expect(geo.p2).toEqual({ x: 500, y: 31 });
  });
});

describe("curve bundles", () => {
  function bundleGeometries(sharedEnd: "from" | "to") {
    const doc = sharedEnd === "from"
      ? parse(`node hub "hub" { at: 0, 0 }
node a "a" { at: 500, -160 }
node b "b" { at: 500, 160 }
edge hub -> a "one" { bundle: channels }
edge hub -> b "two" { bundle: channels }
`).document
      : parse(`node hub "hub" { at: 500, 0 }
node a "a" { at: 0, -160 }
node b "b" { at: 0, 160 }
edge a -> hub "one" { bundle: channels }
edge b -> hub "two" { bundle: channels }
`).document;
    const nodes = new Map(doc.nodes.map((node) => [node.id, node]));
    const hub = boxOf(nodes.get("hub")!);
    const port = sideMidpoint(hub, sharedEnd === "from" ? "right" : "left");
    const normal = sharedEnd === "from" ? 1 : -1;
    const junction = {
      point: { x: port.x + normal * 30, y: port.y },
      side: sharedEnd === "from" ? ("right" as const) : ("left" as const),
      end: sharedEnd,
    };
    const anchors = new Map(
      doc.edges.map((edge) => {
        const from = nodes.get(edge.from)!;
        const target = nodes.get(edge.to)!;
        return [edge.id, {
          from: { point: sideMidpoint(boxOf(from), "right"), side: "right" as const },
          to: { point: sideMidpoint(boxOf(target), "left"), side: "left" as const },
        }];
      }),
    );
    const junctions = new Map(doc.edges.map((edge) => [edge.id, junction]));
    const geos = doc.edges.map((edge) => edgeGeometry(edge, {
      byId: nodes,
      pairs: indexPairs(doc),
      anchors,
      junctions,
    })!);
    return { geos, port, junction };
  }

  it("shares one straight trunk before branching when the source end is shared", () => {
    const { geos, junction } = bundleGeometries("from");
    for (const geo of geos) {
      const first = geo.segments![0]!;
      expect(first.type).toBe("line");
      expect(first.a).toEqual(geo.p1);
      expect(first.b).toEqual(junction.point);
    }
    // Branches reach different targets, so their sampled midpoints differ.
    const a = sampleEdgePath(geos[0]!, 80);
    const b = sampleEdgePath(geos[1]!, 80);
    expect(a[Math.floor(a.length / 2)]).not.toEqual(b[Math.floor(b.length / 2)]);
  });

  it("shares one trunk into the target when the target end is shared", () => {
    const { geos, junction } = bundleGeometries("to");
    for (const geo of geos) {
      const last = geo.segments![geo.segments!.length - 1]!;
      expect(last.type).toBe("line");
      expect(last.a).toEqual(junction.point);
      expect(last.b).toEqual(geo.p2);
      expect(geo.control).toEqual(junction.point);
    }
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
    for (const point of sampleEdgePath(geo, 120)) {
      if (
        point.x > mid.x + 1 && point.x < mid.x + mid.w - 1 &&
        point.y > mid.y + 1 && point.y < mid.y + mid.h - 1
      ) inside++;
    }
    expect(inside).toBe(0);
  });

  it("keeps the via apex when nothing blocks the curve", () => {
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

  it("keeps a long edge near the node envelope instead of looping above it", () => {
    const doc = parse(`node profile "Profile" { at: 390, 80 }
node session "Session" { at: 700, 80 }
node projection "Projection" { at: 1010, 80 }
node cmd "Command" { at: 1320, 80 }
node pg "PostgreSQL" { at: 1630, 80 }
node wecom "WeCom" { at: 1320, 198 }
edge wecom -> profile "binding" { via: 0, -70 }
`).document;
    const byId = new Map(doc.nodes.map((node) => [node.id, node]));
    const pairs = indexPairs(doc);
    const obstacles = doc.nodes.map((node) => ({ id: node.id, rect: boxOf(node) }));
    const edge = doc.edges[0]!;
    const geo = edgeGeometry(edge, { byId, pairs, obstacles })!;
    const points = geo.detour ?? sampleEdgePath(geo, 240);
    // The node envelope is y 80..260; a loop may bow at most 96px past it.
    for (const point of points) {
      expect(point.y).toBeGreaterThanOrEqual(80 - 96 - 1);
      expect(point.y).toBeLessThanOrEqual(260 + 96 + 1);
    }
    for (const point of points) {
      for (const obstacle of obstacles) {
        if (obstacle.id === edge.from || obstacle.id === edge.to) continue;
        expect(
          point.x > obstacle.rect.x + 1 && point.x < obstacle.rect.x + obstacle.rect.w - 1 &&
          point.y > obstacle.rect.y + 1 && point.y < obstacle.rect.y + obstacle.rect.h - 1,
        ).toBe(false);
      }
    }
  });

  it("keeps a long horizontal edge compact across a row of blockers", () => {
    const doc = parse(`node profile "Profile" { at: 390, 80 }
node session "Session" { at: 700, 80 }
node projection "Projection" { at: 1010, 80 }
node cmd "Command" { at: 1320, 80 }
node pg "PostgreSQL" { at: 1630, 80 }
edge profile -> pg "write"
`).document;
    const byId = new Map(doc.nodes.map((node) => [node.id, node]));
    const pairs = indexPairs(doc);
    const obstacles = doc.nodes.map((node) => ({ id: node.id, rect: boxOf(node) }));
    const edge = doc.edges[0]!;
    const geo = edgeGeometry(edge, { byId, pairs, obstacles })!;
    const points = geo.detour ?? sampleEdgePath(geo, 240);
    for (const point of points) expect(point.y).toBeGreaterThanOrEqual(80 - 96 - 1);
    for (const point of points) {
      for (const obstacle of obstacles) {
        if (obstacle.id === edge.from || obstacle.id === edge.to) continue;
        expect(
          point.x > obstacle.rect.x + 1 && point.x < obstacle.rect.x + obstacle.rect.w - 1 &&
          point.y > obstacle.rect.y + 1 && point.y < obstacle.rect.y + obstacle.rect.h - 1,
        ).toBe(false);
      }
    }
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
    for (const point of sampleEdgePath(geo, 400)) {
      for (const rect of blockers) {
        expect(
          point.x > rect.x && point.x < rect.x + rect.w &&
          point.y > rect.y && point.y < rect.y + rect.h,
        ).toBe(false);
      }
    }
  });
});

describe("curve side planning", () => {
  function geometryFor(
    doc: ReturnType<typeof parse>["document"],
    edge: EdgeDecl,
    sides: { from: EdgeSide; to: EdgeSide },
  ) {
    const byId = new Map(doc.nodes.map((node) => [node.id, node]));
    const pairs = indexPairs(doc);
    const obstacles = doc.nodes.map((node) => ({ id: node.id, rect: boxOf(node) }));
    const fromBox = boxOf(byId.get(edge.from)!);
    const toBox = boxOf(byId.get(edge.to)!);
    const anchors = new Map([[
      edge.id,
      {
        from: {
          side: sides.from,
          point: sidePoint(fromBox, sides.from, sideAlong(fromBox, sides.from, { x: toBox.cx, y: toBox.cy })),
        },
        to: {
          side: sides.to,
          point: sidePoint(toBox, sides.to, sideAlong(toBox, sides.to, { x: fromBox.cx, y: fromBox.cy })),
        },
      },
    ]]);
    return edgeGeometry(edge, { byId, pairs, obstacles, anchors })!;
  }

  it("keeps the direct pair instead of looping above the drawing", () => {
    const doc = parse(`node payment "payment" { at: 390, 316 }
node stripe "stripe" { at: 1010, 80 }
node redis "redis" { at: 700, 198 }
edge payment -> stripe "PaymentIntent"
`).document;
    const sides = planCurveSides(doc);
    expect(sides.get(doc.edges[0]!.id)).toEqual({ from: "right", to: "left" });
    const geo = geometryFor(doc, doc.edges[0]!, sides.get(doc.edges[0]!.id)!);
    const highest = Math.min(...doc.nodes.map((node) => boxOf(node).y));
    for (const point of sampleEdgePath(geo, 160)) {
      // A direct pair may bow, but only within the drawing's own margin.
      expect(point.y).toBeGreaterThan(highest - 120);
      expect(
        point.x > 700 + 1 && point.x < 900 - 1 && point.y > 198 + 1 && point.y < 260 - 1,
      ).toBe(false);
    }
  });

  it("leaves the straight pair when another node sits between both ends", () => {
    const doc = parse(`node order "order" { at: 390, 80 }
node inventory "inventory" { at: 390, 198 }
node payment "payment" { at: 390, 316 }
edge order -> payment "gRPC"
`).document;
    const sides = planCurveSides(doc).get(doc.edges[0]!.id)!;
    expect(sides.from === "bottom" && sides.to === "top").toBe(false);
    const geo = geometryFor(doc, doc.edges[0]!, sides);
    const inventory = boxOf(doc.nodes.find((node) => node.id === "inventory")!);
    for (const point of sampleEdgePath(geo, 160)) {
      expect(
        point.x > inventory.x + 1 && point.x < inventory.x + inventory.w - 1 &&
        point.y > inventory.y + 1 && point.y < inventory.y + inventory.h - 1,
      ).toBe(false);
    }
  });

  it("keeps long edges on a layered layout inside the node envelope", () => {
    const doc = parse(`node shell "app" { at: 80, 80 }
node profile "Profile" { at: 390, 80 }
node material "Material" { at: 390, 198 }
node mcpkb "MCP" { at: 390, 316 }
node session "Session" { at: 700, 80 }
node ingest "Ingest" { at: 700, 198 }
node rtSandbox "Sandbox" { at: 700, 316 }
node rtCloud "Cloud" { at: 700, 434 }
node projection "Projection" { at: 1010, 80 }
node cmd "Command" { at: 1320, 80 }
node wecom "WeCom" { at: 1320, 198 }
node feishu "Feishu" { at: 1320, 316 }
node pg "PostgreSQL" { at: 1630, 80 }
node cloud "cloud-agent" { at: 1912, 186 }
node sandbox "sandbox-agent" { at: 1940, 80 }
edge wecom -> profile "binding" { via: 0, -70 }
edge feishu -> profile "binding" { via: 0, 70 }
edge profile -> pg "write"
edge session -> pg "Session + EventLog"
edge projection -> pg "read"
`).document;
    const boxes = new Map(doc.nodes.map((node) => [node.id, boxOf(node)]));
    const obstacles = doc.nodes.map((node) => ({ id: node.id, rect: boxOf(node) }));
    const sides = planCurveSides(doc);
    const uses = new Map<string, SideUse>();
    const useOf = (nodeId: string, side: EdgeSide): SideUse => {
      const key = `${nodeId}\u0000${side}`;
      let use = uses.get(key);
      if (!use) {
        use = { box: boxes.get(nodeId)!, side, ins: [], outs: [], bundles: [] };
        uses.set(key, use);
      }
      return use;
    };
    for (const edge of doc.edges) {
      const fromBox = boxes.get(edge.from)!;
      const toBox = boxes.get(edge.to)!;
      const fromSide = sides.get(edge.id)!.from;
      const toSide = sides.get(edge.id)!.to;
      useOf(edge.from, fromSide).outs.push({
        edge,
        desired: sideAlong(fromBox, fromSide, { x: toBox.cx, y: toBox.cy }),
      });
      useOf(edge.to, toSide).ins.push({
        edge,
        desired: sideAlong(toBox, toSide, { x: fromBox.cx, y: fromBox.cy }),
      });
    }
    // Same anchors the viewer hands to edgeGeometry after planPorts.
    const anchors = new Map<string, { from?: { point: Point; side: EdgeSide }; to?: { point: Point; side: EdgeSide } }>();
    for (const assignment of planPorts([...uses.values()])) {
      const forced = anchors.get(assignment.edgeId) ?? {};
      forced[assignment.end] = { point: assignment.point, side: assignment.side };
      anchors.set(assignment.edgeId, forced);
    }
    const byId = new Map(doc.nodes.map((node) => [node.id, node]));
    const pairs = indexPairs(doc);
    const rects = [...boxes.values()];
    // Long edges may bow, but only within the drawing's own margin.
    const left = Math.min(...rects.map((box) => box.x)) - 120;
    const top = Math.min(...rects.map((box) => box.y)) - 120;
    const right = Math.max(...rects.map((box) => box.x + box.w)) + 120;
    const bottom = Math.max(...rects.map((box) => box.y + box.h)) + 120;
    for (const edge of doc.edges) {
      const geo = edgeGeometry(edge, { byId, pairs, obstacles, anchors })!;
      for (const point of sampleEdgePath(geo, 480)) {
        expect(point.x).toBeGreaterThanOrEqual(left);
        expect(point.x).toBeLessThanOrEqual(right);
        expect(point.y).toBeGreaterThanOrEqual(top);
        expect(point.y).toBeLessThanOrEqual(bottom);
        for (const node of doc.nodes) {
          if (node.id === edge.from || node.id === edge.to) continue;
          const rect = boxOf(node);
          expect(
            point.x > rect.x + 1 && point.x < rect.x + rect.w - 1 &&
            point.y > rect.y + 1 && point.y < rect.y + rect.h - 1,
          ).toBe(false);
        }
      }
    }
  });
});

describe("label placement", () => {
  const path = pathMetrics([{ x: 0, y: 0 }, { x: 400, y: 0 }]);

  it("keeps the label centre within 8px of its own path", () => {
    const placed = placeLabelOnPath(path, 80, 17, [], []);
    expect(Math.abs(placed.y)).toBeLessThanOrEqual(8);
    expect(Math.abs(placed.offset)).toBeLessThanOrEqual(8);
  });

  it("slides along the path instead of covering a node", () => {
    const obstacle = { x: 150, y: -30, w: 100, h: 60 };
    const placed = placeLabelOnPath(path, 80, 17, [obstacle], []);
    const rect = placed.rect;
    const overlap =
      Math.max(0, Math.min(rect.x + rect.w, obstacle.x + obstacle.w) - Math.max(rect.x, obstacle.x)) *
      Math.max(0, Math.min(rect.y + rect.h, obstacle.y + obstacle.h) - Math.max(rect.y, obstacle.y));
    expect(overlap).toBe(0);
    expect(Math.abs(placed.offset)).toBeLessThanOrEqual(8);
  });

  it("does not stack two labels on the same spot", () => {
    const first = placeLabelOnPath(path, 80, 17, [], []);
    const second = placeLabelOnPath(path, 80, 17, [], [first.rect]);
    const overlap =
      Math.max(0, Math.min(first.rect.x + first.rect.w, second.rect.x + second.rect.w) - Math.max(first.rect.x, second.rect.x)) *
      Math.max(0, Math.min(first.rect.y + first.rect.h, second.rect.y + second.rect.h) - Math.max(first.rect.y, second.rect.y));
    expect(overlap).toBe(0);
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
