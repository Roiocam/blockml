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
  const p1 = anchorPoint(from, { x: toBox.cx, y: toBox.cy }, options);
  const p2 = anchorPoint(to, { x: fromBox.cx, y: fromBox.cy }, options);

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
