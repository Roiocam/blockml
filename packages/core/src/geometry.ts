import type { BlockDocument, EdgeDecl, NodeDecl, Point } from "./ast.js";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface NodeBox extends Rect {
  cx: number;
  cy: number;
}

export interface BoxOptions {
  width: number;
  height: number;
}

export const DEFAULT_BOX: BoxOptions = { width: 200, height: 62 };
export const GROUP_PAD = 30;
export const GROUP_HEAD = 34;
export const PAIR_SPREAD = 54;

export function boxOf(node: NodeDecl, options: BoxOptions = DEFAULT_BOX): NodeBox {
  const x = node.at?.x ?? 0;
  const y = node.at?.y ?? 0;
  return { x, y, w: options.width, h: options.height, cx: x + options.width / 2, cy: y + options.height / 2 };
}

export function anchorPoint(node: NodeDecl, towards: Point, options: BoxOptions = DEFAULT_BOX): Point {
  const box = boxOf(node, options);
  const dx = towards.x - box.cx;
  const dy = towards.y - box.cy;
  if (dx === 0 && dy === 0) return { x: box.cx, y: box.cy };
  const sx = box.w / 2 / Math.abs(dx || 1e-9);
  const sy = box.h / 2 / Math.abs(dy || 1e-9);
  const s = Math.min(sx, sy);
  return { x: box.cx + dx * s, y: box.cy + dy * s };
}

export interface LineEdgeSegment {
  type: "line";
  a: Point;
  b: Point;
}

export interface CubicEdgeSegment {
  type: "cubic";
  a: Point;
  c1: Point;
  c2: Point;
  b: Point;
}

export type EdgeSegment = LineEdgeSegment | CubicEdgeSegment;

export interface EdgeGeometry {
  p1: Point;
  p2: Point;
  /**
   * A point the curve passes through: the `via` apex for a plain curve, or the
   * shared branch point for a bundled edge. This is also the bend handle.
   */
  control: Point;
  mid: Point;
  offset: number;
  /** Straight normal stubs plus cubic runs, in drawing order. */
  segments?: EdgeSegment[];
  /**
   * Fallback when no smooth curve can clear the node boxes: a rounded
   * orthogonal polyline with the same normal exits.
   */
  detour?: Point[];
}

export function bezierAt(p1: Point, c: Point, p2: Point, t: number): Point {
  const mt = 1 - t;
  return {
    x: mt * mt * p1.x + 2 * mt * t * c.x + t * t * p2.x,
    y: mt * mt * p1.y + 2 * mt * t * c.y + t * t * p2.y,
  };
}

export function cubicAt(segment: CubicEdgeSegment, t: number): Point {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return {
    x: a * segment.a.x + b * segment.c1.x + c * segment.c2.x + d * segment.b.x,
    y: a * segment.a.y + b * segment.c1.y + c * segment.c2.y + d * segment.b.y,
  };
}

export interface GeometryContext {
  byId: Map<string, NodeDecl>;
  /** Edge groups keyed by the unordered node pair, used to spread parallel edges. */
  pairs: Map<string, EdgeDecl[]>;
  box?: BoxOptions;
  /** Node boxes (with ids) that routes should avoid. */
  obstacles?: { id: string; rect: Rect }[];
  /** Areas routes prefer to avoid (group headers) but may cross when cheaper. */
  soft?: Rect[];
  /** Endpoints pinned to a chosen side and point (side ports or bundles). */
  anchors?: Map<string, { from?: ForcedAnchor; to?: ForcedAnchor }>;
  /** Fixed trunk coordinate so bundled orthogonal edges share one line into the node. */
  trunks?: Map<string, { x?: number; y?: number }>;
  /**
   * Fixed branch point for a bundled curve, pinned to the shared end. Every
   * edge in the bundle runs along the same normal to this point before
   * branching, which makes that run read as one trunk.
   */
  junctions?: Map<string, CurveJunction>;
}

export interface ForcedAnchor {
  point: Point;
  side: EdgeSide;
}

/** A bundle's shared branch point, anchored to the end that the bundle shares. */
export interface CurveJunction extends ForcedAnchor {
  end: "from" | "to";
}

const ANCHOR_MARGIN = 14;

/** Smallest comfortable distance between two attachment points on one border. */
export const PORT_GAP = 18;

/** Usable stretch of a border that anchors may slide along. */
export function sideRange(box: Rect, side: EdgeSide): { min: number; max: number } {
  if (side === "left" || side === "right") {
    return { min: box.y + ANCHOR_MARGIN, max: box.y + box.h - ANCHOR_MARGIN };
  }
  return { min: box.x + 18, max: box.x + box.w - 18 };
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function pairKey(a: string, b: string): string {
  return [a, b].sort().join("\u0000");
}

/** Group edges by unordered node pair. Pure: builds a new map each call. */
export function indexPairs(document: BlockDocument): Map<string, EdgeDecl[]> {
  const map = new Map<string, EdgeDecl[]>();
  for (const edge of document.edges) {
    const key = pairKey(edge.from, edge.to);
    const list = map.get(key);
    if (list) list.push(edge);
    else map.set(key, [edge]);
  }
  return map;
}

function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function addScaled(point: Point, direction: Point, amount: number): Point {
  return { x: point.x + direction.x * amount, y: point.y + direction.y * amount };
}

function unitVector(from: Point, to: Point): Point {
  const length = distance(from, to) || 1;
  return { x: (to.x - from.x) / length, y: (to.y - from.y) / length };
}

/** A border point that pins an edge end, including the side it leaves from. */
export function sideNormal(side: EdgeSide): Point {
  const out = SIDE_OUT[side];
  return { x: out.x, y: out.y };
}

function lineSegment(a: Point, b: Point): LineEdgeSegment {
  return { type: "line", a, b };
}

function cubicSegment(a: Point, c1: Point, c2: Point, b: Point): CubicEdgeSegment {
  return { type: "cubic", a, c1, c2, b };
}

const CURVE_STUB_MIN = 8;
const CURVE_STUB_MAX = 24;
const CURVE_SAMPLES = 48;
const CURVE_SAMPLES_MAX = 160;
const CURVE_PAD = 3;

/** Leave the border straight for 8–24px before the line starts to bend. */
function stubLength(p1: Point, p2: Point): number {
  return clampNumber(distance(p1, p2) * 0.18, CURVE_STUB_MIN, CURVE_STUB_MAX);
}

function controlDistance(length: number): number {
  return Math.max(2, Math.min(80, length * 0.42));
}

/**
 * A curve leaves each port along its border normal, runs a short straight stub,
 * then follows two cubic halves through `control`. The control point is on the
 * path, so `via` is a true midpoint offset rather than a hidden handle.
 */
function curveSegments(
  p1: Point,
  side1: EdgeSide,
  p2: Point,
  side2: EdgeSide,
  control: Point,
  junction?: CurveJunction,
): EdgeSegment[] {
  const n1 = SIDE_OUT[side1];
  const n2 = SIDE_OUT[side2];
  const stub = stubLength(p1, p2);
  const a1 = addScaled(p1, n1, stub);
  const a2 = addScaled(p2, n2, stub);

  if (junction) {
    // The port-to-junction run is the bundle's shared trunk. The branch keeps
    // the trunk normal at the junction and bends into the other port normal.
    if (junction.end === "from") {
      const branch = cubicSegment(
        junction.point,
        addScaled(junction.point, n1, controlDistance(distance(junction.point, a2))),
        addScaled(a2, n2, controlDistance(distance(junction.point, a2))),
        a2,
      );
      return [lineSegment(p1, junction.point), branch, lineSegment(a2, p2)];
    }
    const branch = cubicSegment(
      a1,
      addScaled(a1, n1, controlDistance(distance(a1, junction.point))),
      addScaled(junction.point, n2, controlDistance(distance(a1, junction.point))),
      junction.point,
    );
    return [lineSegment(p1, a1), branch, lineSegment(junction.point, p2)];
  }

  const axis = unitVector(a1, a2);
  const firstLength = distance(a1, control);
  const secondLength = distance(control, a2);
  return [
    lineSegment(p1, a1),
    cubicSegment(
      a1,
      addScaled(a1, n1, controlDistance(firstLength)),
      addScaled(control, axis, -controlDistance(firstLength)),
      control,
    ),
    cubicSegment(
      control,
      addScaled(control, axis, controlDistance(secondLength)),
      addScaled(a2, n2, controlDistance(secondLength)),
      a2,
    ),
    lineSegment(a2, p2),
  ];
}

function segmentLength(segment: EdgeSegment): number {
  if (segment.type === "line") return distance(segment.a, segment.b);
  let total = 0;
  let previous = segment.a;
  for (let i = 1; i <= 16; i++) {
    const point = cubicAt(segment, i / 16);
    total += distance(previous, point);
    previous = point;
  }
  return total;
}

function dedupe(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const point of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - point.x) < 0.01 && Math.abs(last.y - point.y) < 0.01) continue;
    out.push(point);
  }
  return out;
}

/** Evenly sample a route for hit testing, labels and hop detection. */
export function sampleEdgePath(geo: EdgeGeometry, steps = 48): Point[] {
  if (geo.detour?.length) {
    const points = geo.detour;
    if (points.length < 2) return points.slice();
    const lengths: number[] = [];
    let total = 0;
    for (let i = 1; i < points.length; i++) {
      const length = distance(points[i - 1]!, points[i]!);
      lengths.push(length);
      total += length;
    }
    const out: Point[] = [points[0]!];
    for (let i = 1; i < points.length; i++) {
      const count = Math.max(1, Math.round((steps * lengths[i - 1]!) / Math.max(total, 1)));
      for (let k = 1; k <= count; k++) {
        const t = k / count;
        const a = points[i - 1]!;
        const b = points[i]!;
        out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      }
    }
    return dedupe(out);
  }
  if (!geo.segments?.length) return [geo.p1, geo.p2];
  const lengths = geo.segments.map(segmentLength);
  const total = lengths.reduce((sum, length) => sum + length, 0);
  const out: Point[] = [geo.segments[0]!.a];
  geo.segments.forEach((segment, index) => {
    const count = Math.max(1, Math.round((steps * lengths[index]!) / Math.max(total, 1)));
    for (let k = 1; k <= count; k++) {
      const t = k / count;
      if (segment.type === "line") {
        out.push({
          x: segment.a.x + (segment.b.x - segment.a.x) * t,
          y: segment.a.y + (segment.b.y - segment.a.y) * t,
        });
      } else {
        out.push(cubicAt(segment, t));
      }
    }
  });
  return dedupe(out);
}

function curveSampleCount(p1: Point, p2: Point): number {
  const span = distance(p1, p2);
  return Math.max(CURVE_SAMPLES, Math.min(CURVE_SAMPLES_MAX, Math.ceil(span / 4)));
}

/** How far outside the node envelope a curve may bow before it counts as a loop. */
const CURVE_ESCAPE = 96;

function curveBounds(rects: Rect[]): Rect | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const rect of rects) {
    x0 = Math.min(x0, rect.x);
    y0 = Math.min(y0, rect.y);
    x1 = Math.max(x1, rect.x + rect.w);
    y1 = Math.max(y1, rect.y + rect.h);
  }
  if (!Number.isFinite(x0)) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function curveWithinBounds(geo: EdgeGeometry, bounds: Rect | null): boolean {
  if (!bounds) return true;
  for (const point of sampleEdgePath(geo, 48)) {
    if (
      point.x < bounds.x - CURVE_ESCAPE ||
      point.x > bounds.x + bounds.w + CURVE_ESCAPE ||
      point.y < bounds.y - CURVE_ESCAPE ||
      point.y > bounds.y + bounds.h + CURVE_ESCAPE
    ) return false;
  }
  return true;
}

/** Number of sampled curve positions that sit inside a node box. */
function curveCrossings(geo: EdgeGeometry, obstacles: Rect[]): number {
  let hits = 0;
  for (const point of sampleEdgePath(geo, curveSampleCount(geo.p1, geo.p2))) {
    for (const rect of obstacles) {
      if (
        point.x > rect.x - CURVE_PAD &&
        point.x < rect.x + rect.w + CURVE_PAD &&
        point.y > rect.y - CURVE_PAD &&
        point.y < rect.y + rect.h + CURVE_PAD
      ) {
        hits++;
        break;
      }
    }
  }
  return hits;
}

function buildCurve(
  p1: Point,
  side1: EdgeSide,
  p2: Point,
  side2: EdgeSide,
  control: Point,
  spread: number,
  junction?: CurveJunction,
): EdgeGeometry {
  const segments = curveSegments(p1, side1, p2, side2, control, junction);
  return {
    p1,
    p2,
    control,
    mid: polylineMidpoint(sampleEdgePath({ p1, p2, control, mid: control, offset: spread, segments }, 40)),
    offset: spread,
    segments,
  };
}

function detourGeometry(
  edge: EdgeDecl,
  ctx: GeometryContext,
  obstacles: Rect[],
  control: Point,
  spread: number,
): EdgeGeometry | null {
  let best: { points: Point[]; crossings: number } | null = null;
  for (const lane of [0, 1, -1, 2, -2, 3, -3, 4, -4]) {
    const route = orthogonalRoute(edge, ctx, lane);
    if (!route) continue;
    const crossings = segmentCrossings(route.points, obstacles);
    if (!best || crossings < best.crossings) {
      best = { points: route.points, crossings };
    }
    if (crossings === 0) break;
  }
  if (!best) return null;
  const points = best.points;
  return {
    p1: points[0]!,
    p2: points[points.length - 1]!,
    control,
    mid: polylineMidpoint(points),
    offset: spread,
    detour: points,
  };
}

export function edgeGeometry(edge: EdgeDecl, ctx: GeometryContext): EdgeGeometry | null {
  const options = ctx.box ?? DEFAULT_BOX;
  const from = ctx.byId.get(edge.from);
  const to = ctx.byId.get(edge.to);
  if (!from || !to) return null;

  const fromBox = boxOf(from, options);
  const toBox = boxOf(to, options);
  const forcedFrom = ctx.anchors?.get(edge.id)?.from;
  const forcedTo = ctx.anchors?.get(edge.id)?.to;
  let p1: Point;
  let p2: Point;
  let side1: EdgeSide;
  let side2: EdgeSide;
  if (forcedFrom) {
    p1 = forcedFrom.point;
    side1 = forcedFrom.side;
  } else {
    p1 = anchorPoint(from, { x: toBox.cx, y: toBox.cy }, options);
    side1 = edgeSide(p1, fromBox);
  }
  if (forcedTo) {
    p2 = forcedTo.point;
    side2 = forcedTo.side;
  } else {
    p2 = anchorPoint(to, { x: fromBox.cx, y: fromBox.cy }, options);
    side2 = edgeSide(p2, toBox);
  }

  const mx = (p1.x + p2.x) / 2;
  const my = (p1.y + p2.y) / 2;
  const vx = p2.x - p1.x;
  const vy = p2.y - p1.y;
  const len = Math.hypot(vx, vy) || 1;
  const px = -vy / len;
  const py = vx / len;

  const siblings = ctx.pairs.get(pairKey(edge.from, edge.to)) ?? [edge];
  const index = Math.max(0, siblings.indexOf(edge));
  const count = siblings.length;
  const reversed = edge.from > edge.to;
  const spread = count > 1 ? (index - (count - 1) / 2) * PAIR_SPREAD * (reversed ? -1 : 1) : 0;

  const via = edge.via ?? { x: 0, y: 0 };
  const base = {
    x: mx + via.x + px * spread,
    y: my + via.y + py * spread,
  };
  const junction = ctx.junctions?.get(edge.id);
  const control = junction?.point ?? base;
  const obstacles = (ctx.obstacles ?? [])
    .filter((item) => item.id !== edge.from && item.id !== edge.to)
    .map((item) => item.rect);
  const bounds = curveBounds([...obstacles, fromBox, toBox]);
  const fits = (geo: EdgeGeometry): boolean =>
    curveCrossings(geo, obstacles) === 0 && curveWithinBounds(geo, bounds);

  const first = buildCurve(p1, side1, p2, side2, control, spread, junction);
  if (!obstacles.length || fits(first)) return first;

  // A shared bundle trunk must not move per edge; either it clears or the
  // bundle falls back to a normal port-to-port curve.
  if (!junction) {
    const candidates: { point: Point; distance: number }[] = [];
    for (const along of [0, 70, -70, 140, -140]) {
      for (const perp of [0, 40, -40, 80, -80, 120, -120, 160, -160, 200, -200, 260, -260, 320, -320]) {
        if (!along && !perp) continue;
        candidates.push({
          point: {
            x: base.x + px * perp + (vx / len) * along,
            y: base.y + py * perp + (vy / len) * along,
          },
          distance: Math.hypot(perp, along),
        });
      }
    }
    candidates.sort((a, b) => a.distance - b.distance);
    for (const candidate of candidates) {
      const geo = buildCurve(p1, side1, p2, side2, candidate.point, spread);
      if (fits(geo)) return geo;
    }
  }

  return detourGeometry(edge, ctx, obstacles, control, spread) ?? first;
}

export function groupBoundingBox(
  nodes: NodeDecl[],
  options: BoxOptions = DEFAULT_BOX,
): Rect | null {
  if (!nodes.length) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const node of nodes) {
    const box = boxOf(node, options);
    x0 = Math.min(x0, box.x);
    y0 = Math.min(y0, box.y);
    x1 = Math.max(x1, box.x + box.w);
    y1 = Math.max(y1, box.y + box.h);
  }
  return {
    x: x0 - GROUP_PAD,
    y: y0 - GROUP_PAD - GROUP_HEAD,
    w: x1 - x0 + GROUP_PAD * 2,
    h: y1 - y0 + GROUP_PAD * 2 + GROUP_HEAD,
  };
}

export function contentBounds(
  document: BlockDocument,
  options: BoxOptions = DEFAULT_BOX,
): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;

  for (const group of document.groups) {
    const members = document.nodes.filter((n) => n.group === group.id);
    const box = groupBoundingBox(members, options);
    if (!box) continue;
    x0 = Math.min(x0, box.x);
    y0 = Math.min(y0, box.y);
    x1 = Math.max(x1, box.x + box.w);
    y1 = Math.max(y1, box.y + box.h);
  }

  for (const node of document.nodes) {
    const box = boxOf(node, options);
    x0 = Math.min(x0, box.x);
    y0 = Math.min(y0, box.y);
    x1 = Math.max(x1, box.x + box.w);
    y1 = Math.max(y1, box.y + box.h);
  }

  if (!Number.isFinite(x0)) return { x: 0, y: 0, w: 800, h: 600 };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export interface LayoutOptions extends BoxOptions {
  columnGap?: number;
  rowHeight?: number;
  origin?: Point;
  perRow?: number;
}

/** Assign positions to nodes that have no `at`. Never mutates the document. */
export function autoLayout(
  document: BlockDocument,
  options: LayoutOptions = DEFAULT_BOX,
): Map<string, Point> {
  const width = options.width ?? DEFAULT_BOX.width;
  const height = options.height ?? DEFAULT_BOX.height;
  const gapX = options.columnGap ?? 70;
  const rowHeight = options.rowHeight ?? height + 110;
  const origin = options.origin ?? { x: 80, y: 80 };
  const perRow = options.perRow ?? Math.max(3, Math.ceil(Math.sqrt(Math.max(1, document.nodes.length))));

  const result = new Map<string, Point>();
  let index = 0;
  for (const node of document.nodes) {
    if (node.at) {
      // Reserve the grid slot so adding or removing a position never shuffles
      // the auto-placed nodes around it.
      result.set(node.id, node.at);
      index++;
      continue;
    }
    const col = index % perRow;
    const row = Math.floor(index / perRow);
    result.set(node.id, { x: origin.x + col * (width + gapX), y: origin.y + row * rowHeight });
    index++;
  }
  return result;
}

export function pathOf(geo: EdgeGeometry): string {
  const f = (n: number) => Number(n.toFixed(2));
  if (geo.detour?.length) {
    const [first, ...rest] = geo.detour;
    return `M ${f(first!.x)} ${f(first!.y)}${rest.map((point) => ` L ${f(point.x)} ${f(point.y)}`).join("")}`;
  }
  if (!geo.segments?.length) {
    return `M ${f(geo.p1.x)} ${f(geo.p1.y)} Q ${f(geo.control.x)} ${f(geo.control.y)} ${f(geo.p2.x)} ${f(geo.p2.y)}`;
  }
  let d = `M ${f(geo.segments[0]!.a.x)} ${f(geo.segments[0]!.a.y)}`;
  for (const segment of geo.segments) {
    if (segment.type === "line") {
      d += ` L ${f(segment.b.x)} ${f(segment.b.y)}`;
    } else {
      d += ` C ${f(segment.c1.x)} ${f(segment.c1.y)} ${f(segment.c2.x)} ${f(segment.c2.y)} ${f(segment.b.x)} ${f(segment.b.y)}`;
    }
  }
  return d;
}

/* -------------------------------------------------------- orthogonal routing */

const ROUTE_STUB = 24;
const LANE_SPACING = 12;

export type EdgeSide = "left" | "right" | "top" | "bottom";

const SIDE_OUT: Record<EdgeSide, Point> = {
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
};

export function edgeSide(point: Point, box: Rect): EdgeSide {
  if (Math.abs(point.x - box.x) < 0.75) return "left";
  if (Math.abs(point.x - (box.x + box.w)) < 0.75) return "right";
  if (Math.abs(point.y - box.y) < 0.75) return "top";
  return "bottom";
}

export interface OrthogonalRoute {
  /** Axis-aligned polyline from the source anchor to the target anchor. */
  points: Point[];
  /** Corner used for the bend handle and as the label anchor region. */
  junction: Point;
}

function cleanPoints(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 0.01 && Math.abs(last.y - p.y) < 0.01) continue;
    out.push(p);
  }
  for (let i = out.length - 1; i >= 2; i--) {
    const a = out[i - 2]!;
    const b = out[i - 1]!;
    const c = out[i]!;
    if ((a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y)) out.splice(i - 1, 1);
  }
  return out;
}

const SIDES: EdgeSide[] = ["left", "right", "top", "bottom"];

/** Midpoint of a side, used when a caller has no explicit port to honor. */
export function sideMidpoint(box: Rect, side: EdgeSide): Point {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  if (side === "left") return { x: box.x, y: cy };
  if (side === "right") return { x: box.x + box.w, y: cy };
  if (side === "top") return { x: cx, y: box.y };
  return { x: cx, y: box.y + box.h };
}

/** A border point at `along` (y for left/right, x for top/bottom), kept on the border. */
export function sidePoint(box: Rect, side: EdgeSide, along: number): Point {
  const range = sideRange(box, side);
  const value = clampNumber(along, range.min, range.max);
  if (side === "left") return { x: box.x, y: value };
  if (side === "right") return { x: box.x + box.w, y: value };
  if (side === "top") return { x: value, y: box.y };
  return { x: value, y: box.y + box.h };
}

/** Where a point projects onto a border, clamped into its usable stretch. */
export function sideAlong(box: Rect, side: EdgeSide, point: Point): number {
  const range = sideRange(box, side);
  return clampNumber(side === "left" || side === "right" ? point.y : point.x, range.min, range.max);
}

/**
 * Attachment positions for `count` groups sharing one border. They sit
 * symmetrically around the side midpoint and shrink their step when the border
 * is crowded, so every group keeps its own point inside the usable stretch.
 */
export function portPositions(box: Rect, side: EdgeSide, count: number, gap = PORT_GAP): number[] {
  if (count <= 0) return [];
  const range = sideRange(box, side);
  const mid = (range.min + range.max) / 2;
  if (count === 1) return [mid];
  const step = Math.min(gap, (range.max - range.min) / (count - 1));
  const start = mid - (step * (count - 1)) / 2;
  return Array.from({ length: count }, (_, index) => start + index * step);
}

export interface PortGroup {
  key: string;
  /** Preferred coordinate along the border; orders groups on the rail. */
  desired?: number;
}

export interface SidePort {
  key: string;
  side: EdgeSide;
  point: Point;
}

/**
 * Give every group on a border its own attachment point. Callers put inbound
 * and outbound edges in different groups, so a line entering a node can never
 * sit on top of a line leaving it.
 */
export function planSidePorts(
  box: Rect,
  side: EdgeSide,
  groups: PortGroup[],
  gap = PORT_GAP,
): SidePort[] {
  const ordered = [...groups].sort((a, b) => {
    const delta = (a.desired ?? 0) - (b.desired ?? 0);
    if (delta) return delta;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  const positions = portPositions(box, side, ordered.length, gap);
  return ordered.map((group, index) => ({
    key: group.key,
    side,
    point: sidePoint(box, side, positions[index]!),
  }));
}

/** A smart-guide line drawn while a drag is snapped into alignment. */
/** One node border's worth of edges, before ports are assigned. */
export interface SideUse {
  box: Rect;
  side: EdgeSide;
  ins: { edge: EdgeDecl; desired: number }[];
  outs: { edge: EdgeDecl; desired: number }[];
  /** Bundle groups get their own point on the same rail. */
  bundles: { key: string; desired: number; edges: EdgeDecl[]; end: "from" | "to" }[];
}

export interface PortAssignment {
  edgeId: string;
  end: "from" | "to";
  side: EdgeSide;
  point: Point;
  /** Present when the assignment belongs to a bundle group. */
  bundle?: string;
}

/**
 * The shared port rail for both route styles: one point per inbound group, one
 * per outbound group, and one per bundle. Edges sharing a group share a point;
 * a line entering a node can never sit on a line leaving it.
 */
export function planPorts(uses: SideUse[], gap = PORT_GAP): PortAssignment[] {
  const assignments: PortAssignment[] = [];
  for (const use of uses) {
    const groups: PortGroup[] = use.bundles.map((bundle) => ({
      key: bundle.key,
      desired: bundle.desired,
    }));
    const bundles = new Map(use.bundles.map((bundle) => [bundle.key, bundle]));
    const average = (items: { desired: number }[]) =>
      items.reduce((sum, item) => sum + item.desired, 0) / Math.max(1, items.length);
    if (use.ins.length) groups.push({ key: "in", desired: average(use.ins) });
    if (use.outs.length) groups.push({ key: "out", desired: average(use.outs) });
    if (!groups.length) continue;

    for (const port of planSidePorts(use.box, use.side, groups, gap)) {
      const bundle = bundles.get(port.key);
      if (bundle) {
        for (const edge of bundle.edges) {
          assignments.push({
            edgeId: edge.id,
            end: bundle.end,
            side: use.side,
            point: port.point,
            bundle: port.key,
          });
        }
        continue;
      }
      if (port.key !== "in" && port.key !== "out") continue;
      const end = port.key === "in" ? "to" : "from";
      const list = port.key === "in" ? use.ins : use.outs;
      for (const item of list) {
        assignments.push({
          edgeId: item.edge.id,
          end,
          side: use.side,
          point: port.point,
        });
      }
    }
  }
  return assignments;
}

/** A smart-guide line drawn while a drag is snapped into alignment. */
export interface AlignmentGuide {
  /** A vertical line when `x`, a horizontal one when `y`. */
  axis: "x" | "y";
  /** Where the line sits on its axis (world coordinates). */
  at: number;
  /** Extent of the line along the other axis, already padded past both boxes. */
  from: number;
  to: number;
}

export interface SnapResult {
  dx: number;
  dy: number;
  guides: AlignmentGuide[];
}

const GUIDE_PAD = 10;
/** Slack used when deciding which boxes a guide line spans. */
const GUIDE_EPSILON = 0.5;

function unionOf(rects: Rect[]): Rect | null {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const rect of rects) {
    left = Math.min(left, rect.x);
    top = Math.min(top, rect.y);
    right = Math.max(right, rect.x + rect.w);
    bottom = Math.max(bottom, rect.y + rect.h);
  }
  if (!Number.isFinite(left)) return null;
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/** The three lines of a box that other boxes may align to. */
function anchorsOf(box: Rect, axis: "x" | "y"): number[] {
  if (axis === "x") return [box.x, box.x + box.w / 2, box.x + box.w];
  return [box.y, box.y + box.h / 2, box.y + box.h];
}

/**
 * Smart guides for dragging. `moving` are the pre-drag boxes, `targets` the
 * boxes that stay put; the drag delta is nudged (at most `threshold` on each
 * axis, independently) so a border or centre of the moving set lands exactly on
 * a matching line of another box. The returned guides span every box sharing
 * that line, so the UI can draw one continuous rule.
 */
export function snapAlignment(
  moving: Rect[],
  targets: Rect[],
  dx: number,
  dy: number,
  threshold: number,
): SnapResult {
  if (!moving.length || !targets.length || !(threshold > 0)) return { dx, dy, guides: [] };
  const moved = moving.map((rect): Rect => ({ ...rect, x: rect.x + dx, y: rect.y + dy }));
  const group = unionOf(moved);
  if (!group) return { dx, dy, guides: [] };

  const closest = (axis: "x" | "y"): { delta: number; at: number } | null => {
    // Candidate lines come from every moved box plus the group's own bounds, so
    // a multi-selection can also align its joint centre to another box.
    const sources = [...moved.flatMap((box) => anchorsOf(box, axis)), ...anchorsOf(group, axis)];
    let best: { delta: number; at: number } | null = null;
    for (const target of targets) {
      for (const at of anchorsOf(target, axis)) {
        for (const source of sources) {
          const delta = at - source;
          if (Math.abs(delta) > threshold) continue;
          if (!best || Math.abs(delta) < Math.abs(best.delta)) best = { delta, at };
        }
      }
    }
    return best;
  };

  const snapX = closest("x");
  const snapY = closest("y");
  const snapped = {
    x: group.x + (snapX?.delta ?? 0),
    y: group.y + (snapY?.delta ?? 0),
    w: group.w,
    h: group.h,
  };

  const span = (axis: "x" | "y", at: number): { from: number; to: number } | null => {
    let from = Infinity;
    let to = -Infinity;
    for (const box of [...moved, ...targets]) {
      if (!anchorsOf(box, axis).some((value) => Math.abs(value - at) < GUIDE_EPSILON)) continue;
      if (axis === "x") {
        from = Math.min(from, box.y);
        to = Math.max(to, box.y + box.h);
      } else {
        from = Math.min(from, box.x);
        to = Math.max(to, box.x + box.w);
      }
    }
    return Number.isFinite(from) ? { from, to } : null;
  };

  const guides: AlignmentGuide[] = [];
  if (snapX) {
    const line = span("x", snapX.at);
    if (line) guides.push({
      axis: "x",
      at: snapX.at,
      from: Math.min(line.from, snapped.y) - GUIDE_PAD,
      to: Math.max(line.to, snapped.y + snapped.h) + GUIDE_PAD,
    });
  }
  if (snapY) {
    const line = span("y", snapY.at);
    if (line) guides.push({
      axis: "y",
      at: snapY.at,
      from: Math.min(line.from, snapped.x) - GUIDE_PAD,
      to: Math.max(line.to, snapped.x + snapped.w) + GUIDE_PAD,
    });
  }

  return { dx: dx + (snapX?.delta ?? 0), dy: dy + (snapY?.delta ?? 0), guides };
}

/** A box taking part in an align / distribute command. */
export interface AlignItem {
  id: string;
  rect: Rect;
}

function axisCenter(rect: Rect, axis: "x" | "y"): number {
  return axis === "x" ? rect.x + rect.w / 2 : rect.y + rect.h / 2;
}

/**
 * Centre every box on the selection's bounding-box centre for `axis`, keeping
 * the other coordinate. Node boxes all share one size, so this one command
 * covers left, right and centre alignment at once.
 */
export function alignBoxes(items: AlignItem[], axis: "x" | "y"): Map<string, Point> {
  const result = new Map<string, Point>();
  if (items.length < 2) return result;
  const bounds = unionOf(items.map((item) => item.rect));
  if (!bounds) return result;
  const center = axisCenter(bounds, axis);
  for (const { id, rect } of items) {
    result.set(id, {
      x: axis === "x" ? Math.round(center - rect.w / 2) : rect.x,
      y: axis === "y" ? Math.round(center - rect.h / 2) : rect.y,
    });
  }
  return result;
}

/**
 * Spread the boxes strictly between the two extremes so their centres are
 * evenly spaced; the extremes stay put. Needs at least three boxes to mean
 * anything, and returns only the boxes that move.
 */
export function distributeBoxes(items: AlignItem[], axis: "x" | "y"): Map<string, Point> {
  const result = new Map<string, Point>();
  if (items.length < 3) return result;
  const ordered = [...items].sort((a, b) => axisCenter(a.rect, axis) - axisCenter(b.rect, axis));
  const first = axisCenter(ordered[0]!.rect, axis);
  const last = axisCenter(ordered[ordered.length - 1]!.rect, axis);
  const step = (last - first) / (ordered.length - 1);
  ordered.forEach((item, index) => {
    if (index === 0 || index === ordered.length - 1) return;
    const center = first + step * index;
    result.set(item.id, {
      x: axis === "x" ? Math.round(center - item.rect.w / 2) : item.rect.x,
      y: axis === "y" ? Math.round(center - item.rect.h / 2) : item.rect.y,
    });
  });
  return result;
}

export function primarySide(box: NodeBox, other: NodeBox): EdgeSide {
  const dx = other.cx - box.cx;
  const dy = other.cy - box.cy;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "bottom" : "top";
}

const EDGE_SIDES: EdgeSide[] = ["left", "right", "top", "bottom"];

function sidePenalty(side: EdgeSide, box: NodeBox, other: NodeBox): number {
  const wanted = primarySide(box, other);
  if (side === wanted) return 0;
  const opposite =
    wanted === "left" ? "right" :
    wanted === "right" ? "left" :
    wanted === "top" ? "bottom" : "top";
  return side === opposite ? 60 : 20;
}

export interface CurveSides {
  from: EdgeSide;
  to: EdgeSide;
}

export interface CurveSideOptions {
  /** Node boxes to avoid; defaults to every node in the document. */
  obstacles?: { id: string; rect: Rect }[];
  /** Areas to avoid when cheap (group headers). */
  soft?: Rect[];
  /** Bundle anchors. A bundled end keeps the side chosen by the bundle. */
  anchors?: Map<string, { from?: ForcedAnchor; to?: ForcedAnchor }>;
  box?: BoxOptions;
  /** How far outside the node bounds a direct pair may bow. */
  margin?: number;
}

/**
 * Choose the border each curve end leaves from. The dominant-direction pair is
 * used whenever it produces a compact curve that clears every node; otherwise
 * every side pair is tried and the shortest clean curve wins (with a penalty
 * for leaving away from the other node). The orthogonal router is the last
 * resort for bundles or a fully blocked pair. Ports are shared later per side
 * in `planPorts`, so this only chooses directions, not attachment points.
 */
export function planCurveSides(
  document: BlockDocument,
  options: CurveSideOptions = {},
): Map<string, CurveSides> {
  const box = options.box ?? DEFAULT_BOX;
  const result = new Map<string, CurveSides>();
  const byId = new Map(document.nodes.map((node) => [node.id, node]));
  const boxes = new Map(document.nodes.map((node) => [node.id, boxOf(node, box)]));
  const pairs = indexPairs(document);
  const obstacles = options.obstacles ?? document.nodes.map((node) => ({ id: node.id, rect: boxOf(node, box) }));
  const soft = options.soft ?? [];
  const anchors = options.anchors;
  const margin = options.margin ?? 120;
  const bounds = obstacles.reduce<Rect | null>((acc, item) => {
    const r = item.rect;
    if (!acc) return { ...r };
    const x = Math.min(acc.x, r.x);
    const y = Math.min(acc.y, r.y);
    return {
      x,
      y,
      w: Math.max(acc.x + acc.w, r.x + r.w) - x,
      h: Math.max(acc.y + acc.h, r.y + r.h) - y,
    };
  }, null);
  const blockers = obstacles.map((item) => item.rect);

  const trial = (edge: EdgeDecl, fromSide: EdgeSide, toSide: EdgeSide): number | null => {
    const fromBox = boxes.get(edge.from);
    const toBox = boxes.get(edge.to);
    if (!fromBox || !toBox) return null;
    const fromPoint = sidePoint(fromBox, fromSide, sideAlong(fromBox, fromSide, { x: toBox.cx, y: toBox.cy }));
    const toPoint = sidePoint(toBox, toSide, sideAlong(toBox, toSide, { x: fromBox.cx, y: fromBox.cy }));
    const geo = edgeGeometry(edge, {
      byId,
      pairs,
      box,
      obstacles,
      soft,
      anchors: new Map([[edge.id, {
        from: { side: fromSide, point: fromPoint },
        to: { side: toSide, point: toPoint },
      }]]),
    });
    if (!geo || geo.detour) return null;
    const points = sampleEdgePath(geo, 96);
    let pathLength = 0;
    for (let i = 1; i < points.length; i++) {
      pathLength += distance(points[i - 1]!, points[i]!);
    }
    const direct = distance(fromPoint, toPoint);
    if (pathLength > Math.max(direct * 2.2, direct + 260)) return null;
    const own = new Set([edge.from, edge.to]);
    for (const point of points) {
      if (
        bounds &&
        (point.x < bounds.x - margin || point.x > bounds.x + bounds.w + margin ||
         point.y < bounds.y - margin || point.y > bounds.y + bounds.h + margin)
      ) return null;
      for (let i = 0; i < blockers.length; i++) {
        if (own.has(obstacles[i]!.id)) continue;
        const rect = blockers[i]!;
        if (
          point.x > rect.x + 1 && point.x < rect.x + rect.w - 1 &&
          point.y > rect.y + 1 && point.y < rect.y + rect.h - 1
        ) return null;
      }
    }
    return pathLength;
  };

  for (const edge of document.edges) {
    const fromBox = boxes.get(edge.from);
    const toBox = boxes.get(edge.to);
    if (!fromBox || !toBox) continue;
    const forced = anchors?.get(edge.id);
    const primary: CurveSides = {
      from: primarySide(fromBox, toBox),
      to: primarySide(toBox, fromBox),
    };
    if (!forced?.from && !forced?.to) {
      if (trial(edge, primary.from, primary.to) !== null) {
        result.set(edge.id, primary);
        continue;
      }
      let best: { sides: CurveSides; score: number } | null = null;
      for (const fromSide of EDGE_SIDES) {
        for (const toSide of EDGE_SIDES) {
          if (fromSide === primary.from && toSide === primary.to) continue;
          const length = trial(edge, fromSide, toSide);
          if (length === null) continue;
          const score =
            sidePenalty(fromSide, fromBox, toBox) +
            sidePenalty(toSide, toBox, fromBox) +
            length * 0.03;
          if (!best || score < best.score) best = { sides: { from: fromSide, to: toSide }, score };
        }
      }
      if (best) {
        result.set(edge.id, best.sides);
        continue;
      }
    }
    const route = orthogonalRoute(edge, {
      byId,
      pairs,
      box,
      obstacles,
      soft,
      anchors,
    }, 0);
    if (!route) {
      result.set(edge.id, primary);
      continue;
    }
    const last = route.points[route.points.length - 1]!;
    result.set(edge.id, {
      from: forced?.from?.side ?? edgeSide(route.points[0]!, fromBox),
      to: forced?.to?.side ?? edgeSide(last, toBox),
    });
  }
  return result;
}

function segmentHitsRect(a: Point, b: Point, rect: Rect, pad: number): boolean {
  const x0 = Math.min(a.x, b.x);
  const x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const y1 = Math.max(a.y, b.y);
  return x1 > rect.x - pad && x0 < rect.x + rect.w + pad && y1 > rect.y - pad && y0 < rect.y + rect.h + pad;
}

/** True when any segment of an axis-aligned polyline enters one of the rects. */
export function routeCrosses(points: Point[], obstacles: Rect[], pad = 0): boolean {
  for (let i = 1; i < points.length; i++) {
    for (const rect of obstacles) {
      if (segmentHitsRect(points[i - 1]!, points[i]!, rect, pad)) return true;
    }
  }
  return false;
}

/** Point halfway along a polyline, by arc length. */
export function polylineMidpoint(points: Point[]): Point {
  if (!points.length) return { x: 0, y: 0 };
  if (points.length === 1) return points[0]!;
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
  }
  let walked = 0;
  const half = total / 2;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (walked + len >= half) {
      const k = len < 1e-6 ? 0 : (half - walked) / len;
      return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
    }
    walked += len;
  }
  return points[points.length - 1]!;
}

function routeScore(points: Point[], obstacles: Rect[], soft: Rect[]): number {
  let score = 0;
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    length += Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
    for (const rect of obstacles) {
      if (segmentHitsRect(a, b, rect, 6)) score += 500;
    }
    for (const rect of soft) {
      if (segmentHitsRect(a, b, rect, 2)) score += 14;
    }
  }
  return score + length * 0.05 + Math.max(0, points.length - 3) * 8;
}

/** Number of polyline segments that cut through a node box. */
function segmentCrossings(points: Point[], obstacles: Rect[]): number {
  let hits = 0;
  for (let i = 1; i < points.length; i++) {
    for (const rect of obstacles) {
      if (segmentHitsRect(points[i - 1]!, points[i]!, rect, 6)) hits++;
    }
  }
  return hits;
}

/** Route between two chosen anchors; both stubs leave perpendicular to their border. */
function routeBetween(
  p1: Point,
  side1: EdgeSide,
  p2: Point,
  side2: EdgeSide,
  lane: number,
  trunk?: { x?: number; y?: number },
  obstacles: Rect[] = [],
): OrthogonalRoute {
  const o1 = SIDE_OUT[side1];
  const o2 = SIDE_OUT[side2];
  const stub = Math.max(14, ROUTE_STUB + lane * 10);
  const a1 = { x: p1.x + o1.x * stub, y: p1.y + o1.y * stub };
  const a2 = { x: p2.x + o2.x * stub, y: p2.y + o2.y * stub };
  const shift = lane * LANE_SPACING;
  const h1 = o1.x !== 0;
  const h2 = o2.x !== 0;
  const dir = (value: number) => (value > 0 ? 1 : value < 0 ? -1 : 0);

  if (h1 && h2) {
    let x: number;
    if (trunk?.x !== undefined) {
      x = trunk.x;
      return {
        points: cleanPoints([p1, a1, { x, y: a1.y }, { x, y: a2.y }, a2, p2]),
        junction: { x, y: Math.round((a1.y + a2.y) / 2) },
      };
    }
    // A couple of pixels between the two ports would otherwise turn into a
    // mid-run jog; keep the step next to the target stub instead.
    const step = Math.abs(a1.y - a2.y);
    if (step > 0.5 && step <= 6) {
      x = a2.x + shift;
      return {
        points: cleanPoints([p1, a1, { x, y: a1.y }, a2, p2]),
        junction: { x, y: a1.y },
      };
    }
    if (o1.x === o2.x) {
      x = (o1.x > 0 ? Math.max(a1.x, a2.x) : Math.min(a1.x, a2.x)) + o1.x * 22;
    } else {
      x = (a1.x + a2.x) / 2;
    }
    x = Math.round(x + shift);
    if (o1.x > 0) x = Math.max(x, a1.x + 6);
    else x = Math.min(x, a1.x - 6);
    if (o2.x > 0) x = Math.max(x, a2.x + 6);
    else x = Math.min(x, a2.x - 6);
    return {
      points: cleanPoints([p1, a1, { x, y: a1.y }, { x, y: a2.y }, a2, p2]),
      junction: { x, y: Math.round((a1.y + a2.y) / 2) },
    };
  }

  if (!h1 && !h2) {
    let y: number;
    if (trunk?.y !== undefined) {
      y = trunk.y;
      return {
        points: cleanPoints([p1, a1, { x: a1.x, y }, { x: a2.x, y }, a2, p2]),
        junction: { x: Math.round((a1.x + a2.x) / 2), y },
      };
    }
    const step = Math.abs(a1.x - a2.x);
    if (step > 0.5 && step <= 6) {
      y = a2.y + shift;
      return {
        points: cleanPoints([p1, a1, { x: a1.x, y }, a2, p2]),
        junction: { x: a1.x, y },
      };
    }
    if (o1.y === o2.y) {
      y = (o1.y > 0 ? Math.max(a1.y, a2.y) : Math.min(a1.y, a2.y)) + o1.y * 22;
    } else {
      y = (a1.y + a2.y) / 2;
    }
    y = Math.round(y + shift);
    if (o1.y > 0) y = Math.max(y, a1.y + 6);
    else y = Math.min(y, a1.y - 6);
    if (o2.y > 0) y = Math.max(y, a2.y + 6);
    else y = Math.min(y, a2.y - 6);
    return {
      points: cleanPoints([p1, a1, { x: a1.x, y }, { x: a2.x, y }, a2, p2]),
      junction: { x: Math.round((a1.x + a2.x) / 2), y },
    };
  }

  if (h1) {
    const aligned =
      (a2.x === a1.x || dir(a2.x - a1.x) === o1.x) &&
      (a2.y === a1.y || dir(a2.y - a1.y) === -o2.y);
    if (aligned) {
      if (shift) {
        // Nonzero lane: keep the single-corner shape but thread the vertical
        // leg through a shifted x, so the lane actually moves the line.
        const x = a2.x + shift;
        return {
          points: cleanPoints([p1, a1, { x, y: a1.y }, { x, y: a2.y }, a2, p2]),
          junction: { x, y: a1.y },
        };
      }
      const corner = { x: a2.x, y: a1.y };
      const direct = cleanPoints([p1, a1, corner, a2, p2]);
      const bendX = a1.x + o1.x * 26;
      const bendY = a2.y + o2.y * 26;
      const bent = cleanPoints([p1, a1, { x: bendX, y: a1.y }, { x: bendX, y: bendY }, { x: a2.x, y: bendY }, a2, p2]);
      // A one-corner shortcut can graze a node that a two-corner step clears.
      if (segmentCrossings(direct, obstacles) > segmentCrossings(bent, obstacles)) {
        return { points: bent, junction: { x: bendX, y: bendY } };
      }
      return { points: direct, junction: corner };
    }
    const x = a1.x + o1.x * 26;
    const y = a2.y + o2.y * 26;
    return {
      points: cleanPoints([p1, a1, { x, y: a1.y }, { x, y }, { x: a2.x, y }, a2, p2]),
      junction: { x, y },
    };
  }
  const aligned =
    (a2.y === a1.y || dir(a2.y - a1.y) === o1.y) &&
    (a2.x === a1.x || dir(a2.x - a1.x) === -o2.x);
  if (aligned) {
    if (shift) {
      const y = a2.y + shift;
      return {
        points: cleanPoints([p1, a1, { x: a1.x, y }, { x: a2.x, y }, a2, p2]),
        junction: { x: a1.x, y },
      };
    }
    const corner = { x: a1.x, y: a2.y };
    const direct = cleanPoints([p1, a1, corner, a2, p2]);
    const bendY = a1.y + o1.y * 26;
    const bendX = a2.x + o2.x * 26;
    const bent = cleanPoints([p1, a1, { x: a1.x, y: bendY }, { x: bendX, y: bendY }, { x: bendX, y: a2.y }, a2, p2]);
    if (segmentCrossings(direct, obstacles) > segmentCrossings(bent, obstacles)) {
      return { points: bent, junction: { x: bendX, y: bendY } };
    }
    return { points: direct, junction: corner };
  }
  const y = a1.y + o1.y * 26;
  const x = a2.x + o2.x * 26;
  return {
    points: cleanPoints([p1, a1, { x: a1.x, y }, { x, y }, { x, y: a2.y }, a2, p2]),
    junction: { x, y },
  };
}

export function orthogonalRoute(edge: EdgeDecl, ctx: GeometryContext, lane = 0): OrthogonalRoute | null {
  const from = ctx.byId.get(edge.from);
  const to = ctx.byId.get(edge.to);
  if (!from || !to) return null;
  const options = ctx.box ?? DEFAULT_BOX;
  const fromBox = boxOf(from, options);
  const toBox = boxOf(to, options);
  const forcedFrom = ctx.anchors?.get(edge.id)?.from;
  const forcedTo = ctx.anchors?.get(edge.id)?.to;
  const trunk = ctx.trunks?.get(edge.id);
  const natural1 = forcedFrom?.side ?? primarySide(fromBox, toBox);
  const natural2 = forcedTo?.side ?? primarySide(toBox, fromBox);
  const obstacles = (ctx.obstacles ?? [])
    .filter((item) => item.id !== edge.from && item.id !== edge.to)
    .map((item) => item.rect);
  const soft = ctx.soft ?? [];

  const sides1: EdgeSide[] = forcedFrom ? [forcedFrom.side] : SIDES;
  const sides2: EdgeSide[] = forcedTo ? [forcedTo.side] : SIDES;
  let best: { route: OrthogonalRoute; score: number } | null = null;
  for (const side1 of sides1) {
    for (const side2 of sides2) {
      const route = routeBetween(
        forcedFrom ? forcedFrom.point : sideMidpoint(fromBox, side1),
        side1,
        forcedTo ? forcedTo.point : sideMidpoint(toBox, side2),
        side2,
        lane,
        trunk,
        obstacles,
      );
      let score = routeScore(route.points, obstacles, soft);
      if (side1 !== natural1) score += 8;
      if (side2 !== natural2) score += 8;
      // Stubs should face away from the other end; a stub pointing back at it
      // means the line has to wrap around its own node.
      const dx = toBox.cx - fromBox.cx;
      const dy = toBox.cy - fromBox.cy;
      const out1 = SIDE_OUT[side1];
      const out2 = SIDE_OUT[side2];
      // Leave toward the target; enter from the side that faces the source.
      if (out1.x * dx + out1.y * dy < 0) score += 30;
      if (out2.x * -dx + out2.y * -dy < 0) score += 30;
      // Both stubs on the same side make a U-turn around both nodes.
      const sameAxis = (out1.x !== 0) === (out2.x !== 0);
      if (sameAxis && (out1.x === out2.x && out1.y === out2.y)) score += 30;
      if (!best || score < best.score) best = { route, score };
    }
  }
  return best?.route ?? null;
}
