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

export interface EdgeGeometry {
  p1: Point;
  p2: Point;
  control: Point;
  mid: Point;
  offset: number;
}

export function bezierAt(p1: Point, c: Point, p2: Point, t: number): Point {
  const mt = 1 - t;
  return {
    x: mt * mt * p1.x + 2 * mt * t * c.x + t * t * p2.x,
    y: mt * mt * p1.y + 2 * mt * t * c.y + t * t * p2.y,
  };
}

export interface GeometryContext {
  byId: Map<string, NodeDecl>;
  /** Edge groups keyed by the unordered node pair, used to spread parallel edges. */
  pairs: Map<string, EdgeDecl[]>;
  box?: BoxOptions;
  /**
   * Per-edge anchor offsets (px) along the node border. Edges that share a node
   * fan out instead of stacking on the same anchor point.
   */
  fans?: Map<string, { from?: number; to?: number }>;
  /** Node boxes (with ids) that orthogonal routes should route around. */
  obstacles?: { id: string; rect: Rect }[];
  /** Areas routes prefer to avoid (group headers) but may cross when cheaper. */
  soft?: Rect[];
  /** Endpoints pinned by edge bundling; overrides the natural anchor and fan. */
  anchors?: Map<string, { from?: ForcedAnchor; to?: ForcedAnchor }>;
  /** Fixed trunk coordinate so bundled edges share one line into the node. */
  trunks?: Map<string, { x?: number; y?: number }>;
}

export interface ForcedAnchor {
  point: Point;
  side: EdgeSide;
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

/** Slide an anchor along the side of the box it sits on, keeping it on the border. */
export function slideAnchor(point: Point, box: Rect, amount: number): Point {
  const onVerticalSide =
    Math.abs(point.x - box.x) < 0.75 || Math.abs(point.x - (box.x + box.w)) < 0.75;
  if (onVerticalSide) {
    return {
      x: point.x,
      y: clampNumber(point.y + amount, box.y + ANCHOR_MARGIN, box.y + box.h - ANCHOR_MARGIN),
    };
  }
  return {
    x: clampNumber(point.x + amount, box.x + 18, box.x + box.w - 18),
    y: point.y,
  };
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

export function edgeGeometry(edge: EdgeDecl, ctx: GeometryContext): EdgeGeometry | null {
  const options = ctx.box ?? DEFAULT_BOX;
  const from = ctx.byId.get(edge.from);
  const to = ctx.byId.get(edge.to);
  if (!from || !to) return null;

  const fromBox = boxOf(from, options);
  const toBox = boxOf(to, options);
  const fan = ctx.fans?.get(edge.id);
  let p1 = anchorPoint(from, { x: toBox.cx, y: toBox.cy }, options);
  let p2 = anchorPoint(to, { x: fromBox.cx, y: fromBox.cy }, options);
  if (fan?.from) p1 = slideAnchor(p1, fromBox, fan.from);
  if (fan?.to) p2 = slideAnchor(p2, toBox, fan.to);

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
  const control = {
    x: mx + via.x + px * spread,
    y: my + via.y + py * spread,
  };

  return {
    p1,
    p2,
    control,
    mid: bezierAt(p1, control, p2, 0.5),
    offset: spread,
  };
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
  return `M ${f(geo.p1.x)} ${f(geo.p1.y)} Q ${f(geo.control.x)} ${f(geo.control.y)} ${f(geo.p2.x)} ${f(geo.p2.y)}`;
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

/** The single attachment point of a side: every edge meets the node there. */
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

export function primarySide(box: NodeBox, other: NodeBox): EdgeSide {
  const dx = other.cx - box.cx;
  const dy = other.cy - box.cy;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "bottom" : "top";
}

function segmentHitsRect(a: Point, b: Point, rect: Rect, pad: number): boolean {
  const x0 = Math.min(a.x, b.x);
  const x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const y1 = Math.max(a.y, b.y);
  return x1 > rect.x - pad && x0 < rect.x + rect.w + pad && y1 > rect.y - pad && y0 < rect.y + rect.h + pad;
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

/** Route between two chosen anchors; both stubs leave perpendicular to their border. */
function routeBetween(
  p1: Point,
  side1: EdgeSide,
  p2: Point,
  side2: EdgeSide,
  lane: number,
  trunk?: { x?: number; y?: number },
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
      return { points: cleanPoints([p1, a1, corner, a2, p2]), junction: corner };
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
    return { points: cleanPoints([p1, a1, corner, a2, p2]), junction: corner };
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
