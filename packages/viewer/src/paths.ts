import {
  pathOf,
  pathMetrics,
  pointAtLength,
  sampleEdgePath,
  type EdgeDecl,
  type EdgeGeometry,
  type OrthogonalRoute,
  type PathMetrics,
  type Point,
} from "@block-ml/core";

const HOP_RADIUS = 7;
const HOP_MIN_T = 0.05;
const HOP_MAX_T = 0.95;

function segmentHit(a1: Point, a2: Point, b1: Point, b2: Point): number | null {
  const ax = a2.x - a1.x;
  const ay = a2.y - a1.y;
  const bx = b2.x - b1.x;
  const by = b2.y - b1.y;
  const denom = ax * by - ay * bx;
  if (Math.abs(denom) < 1e-9) return null;
  const ox = b1.x - a1.x;
  const oy = b1.y - a1.y;
  const ua = (ox * by - oy * bx) / denom;
  const ub = (ox * ay - oy * ax) / denom;
  // A crossing can land exactly on a sampled vertex; keep the endpoints so it
  // is not missed when both paths bend through the same point.
  if (ua < 0 || ua > 1 || ub < 0 || ub > 1) return null;
  return ub;
}

function boundsOf(points: Point[]): { x: number; y: number; w: number; h: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const point of points) {
    x0 = Math.min(x0, point.x);
    y0 = Math.min(y0, point.y);
    x1 = Math.max(x1, point.x);
    y1 = Math.max(y1, point.y);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function shareNode(a: EdgeDecl, b: EdgeDecl): boolean {
  return a.from === b.from || a.from === b.to || a.to === b.from || a.to === b.to;
}

/**
 * Hop slots for every crossing between two routes. The later edge is the one
 * drawn on top, so it gets the hop; the lower edge stays straight.
 */
function hopsBetween(
  edges: EdgeDecl[],
  paths: Map<string, PathMetrics>,
): Map<string, number[]> {
  const hops = new Map<string, number[]>();
  for (let i = 0; i < edges.length; i++) {
    const first = edges[i]!;
    const a = paths.get(first.id);
    if (!a) continue;
    const aBox = boundsOf(a.points);
    for (let j = i + 1; j < edges.length; j++) {
      const second = edges[j]!;
      const b = paths.get(second.id);
      if (!b) continue;
      const bBox = boundsOf(b.points);
      if (
        aBox.x + aBox.w < bBox.x || bBox.x + bBox.w < aBox.x ||
        aBox.y + aBox.h < bBox.y || bBox.y + bBox.h < aBox.y
      ) continue;
      const shares = shareNode(first, second);
      const found: number[] = [];
      for (let s = 0; s < a.points.length - 1; s++) {
        for (let k = 0; k < b.points.length - 1; k++) {
          const ub = segmentHit(a.points[s]!, a.points[s + 1]!, b.points[k]!, b.points[k + 1]!);
          if (ub === null) continue;
          const distance = b.lengths[k]! + ub * (b.lengths[k + 1]! - b.lengths[k]!);
          const t = b.total ? distance / b.total : 0;
          if (t < HOP_MIN_T || t > HOP_MAX_T) continue;
          if (shares && (t < 0.12 || t > 0.88)) continue;
          found.push(t);
        }
      }
      if (found.length) hops.set(second.id, [...(hops.get(second.id) ?? []), ...found]);
    }
  }
  return hops;
}

/** Crossings for smooth curves, sampled densely enough to catch shallow cuts. */
export function computeHops(
  edges: EdgeDecl[],
  geos: Map<string, EdgeGeometry>,
): Map<string, number[]> {
  const paths = new Map<string, PathMetrics>();
  for (const edge of edges) {
    const geo = geos.get(edge.id);
    if (geo) paths.set(edge.id, pathMetrics(sampleEdgePath(geo, 96)));
  }
  return hopsBetween(edges, paths);
}

/** Crossings for axis-aligned routes, which already carry their own polylines. */
export function computePolylineHops(
  edges: EdgeDecl[],
  routes: Map<string, OrthogonalRoute>,
): Map<string, number[]> {
  const paths = new Map<string, PathMetrics>();
  for (const edge of edges) {
    const route = routes.get(edge.id);
    if (route) paths.set(edge.id, pathMetrics(route.points));
  }
  return hopsBetween(edges, paths);
}

// Lane rails sit 12px apart. A large radius makes two rounded corners overlap
// when edges swap rows in one gap, which reads as an unhopped crossing; 4px
// leaves a visible gap between adjacent rails while staying rounded.
const CORNER_RADIUS = 4;

/** Rounded polyline, optionally with small arcs where it crosses another edge. */
export function polylinePath(points: Point[], hops?: number[]): string {
  const f = (n: number) => Number(n.toFixed(2));
  if (points.length < 2) return "";
  const path = pathMetrics(points);
  const radiusAt = (index: number): number => {
    if (index <= 0 || index >= points.length - 1) return 0;
    const prev = path.lengths[index]! - path.lengths[index - 1]!;
    const next = path.lengths[index + 1]! - path.lengths[index]!;
    if (prev < 2 || next < 2) return 0;
    return Math.min(CORNER_RADIUS, prev / 2, next / 2);
  };
  const at = (distance: number): Point => pointAtLength(path, distance);

  const cuts: number[] = [];
  if (hops?.length) {
    for (const t of [...hops].sort((a, b) => a - b)) {
      const s = t * path.total;
      if (s < 22 || s > path.total - 22) continue;
      if (cuts.length && s - cuts[cuts.length - 1]! < 18) continue;
      cuts.push(s);
    }
  }

  let d = `M ${f(points[0]!.x)} ${f(points[0]!.y)}`;
  let cut = 0;
  for (let i = 1; i < points.length; i++) {
    const segStart = path.lengths[i - 1]!;
    const segEnd = path.lengths[i]!;
    const endR = radiusAt(i);
    while (cut < cuts.length && cuts[cut]! <= segEnd) {
      const s = cuts[cut]!;
      if (s >= segStart + radiusAt(i - 1) + 9 && s <= segEnd - endR - 9) {
        const from = at(s - HOP_RADIUS);
        const to = at(s + HOP_RADIUS);
        d += ` L ${f(from.x)} ${f(from.y)} A ${HOP_RADIUS} ${HOP_RADIUS} 0 0 1 ${f(to.x)} ${f(to.y)}`;
      }
      cut++;
    }
    const end = at(segEnd - endR);
    d += ` L ${f(end.x)} ${f(end.y)}`;
    if (endR > 0) {
      const corner = points[i]!;
      const after = at(segEnd + endR);
      d += ` Q ${f(corner.x)} ${f(corner.y)} ${f(after.x)} ${f(after.y)}`;
    }
  }
  return d;
}

/** A smooth curve rendered as a dense polyline with hop arcs, used at crossings. */
function polylineWithHops(points: Point[], hops: number[]): string {
  const f = (n: number) => Number(n.toFixed(2));
  const path = pathMetrics(points);
  if (!hops.length || points.length < 2) return polylinePath(points);
  const cuts: number[] = [];
  for (const t of [...hops].sort((a, b) => a - b)) {
    const s = t * path.total;
    if (s < 22 || s > path.total - 22) continue;
    if (cuts.length && s - cuts[cuts.length - 1]! < 18) continue;
    cuts.push(s);
  }
  if (!cuts.length) return polylinePath(points);

  const at = (distance: number): Point => pointAtLength(path, distance);
  let d = `M ${f(points[0]!.x)} ${f(points[0]!.y)}`;
  let index = 1;
  let cursor = 0;
  const emitTo = (target: number) => {
    while (index < points.length && path.lengths[index]! <= target) {
      d += ` L ${f(points[index]!.x)} ${f(points[index]!.y)}`;
      index++;
    }
    if (target > cursor && target < path.total) {
      const point = at(target);
      d += ` L ${f(point.x)} ${f(point.y)}`;
    }
    cursor = target;
  };
  for (const s of cuts) {
    const from = s - HOP_RADIUS;
    const to = s + HOP_RADIUS;
    if (from <= cursor + 1) continue;
    emitTo(from);
    const end = at(to);
    d += ` A ${HOP_RADIUS} ${HOP_RADIUS} 0 0 1 ${f(end.x)} ${f(end.y)}`;
    cursor = to;
    while (index < points.length && path.lengths[index]! <= to) index++;
  }
  emitTo(path.total);
  return d;
}

/** SVG path for a curve geometry: exact cubics, or a hopped polyline at crossings. */
export function edgePath(geo: EdgeGeometry, hops?: number[]): string {
  if (geo.detour?.length) return polylinePath(geo.detour, hops);
  if (!hops?.length) return pathOf(geo);
  return polylineWithHops(sampleEdgePath(geo, 96), hops);
}
