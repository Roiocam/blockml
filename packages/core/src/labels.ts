import type { Point } from "./ast.js";
import type { Rect } from "./geometry.js";

export interface PathMetrics {
  points: Point[];
  lengths: number[];
  total: number;
}

/** Cumulative arc lengths for a polyline. */
export function pathMetrics(points: Point[]): PathMetrics {
  const lengths = [0];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    total += Math.hypot(b.x - a.x, b.y - a.y);
    lengths.push(total);
  }
  return { points, lengths, total };
}

export function pointAtLength(path: PathMetrics, distance: number): Point {
  const s = Math.max(0, Math.min(path.total, distance));
  for (let i = 1; i < path.points.length; i++) {
    if (path.lengths[i]! >= s) {
      const segStart = path.lengths[i - 1]!;
      const k = (s - segStart) / Math.max(path.lengths[i]! - segStart, 1e-6);
      const a = path.points[i - 1]!;
      const b = path.points[i]!;
      return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
    }
  }
  return path.points[path.points.length - 1]!;
}

export interface LabelPlacement {
  x: number;
  y: number;
  /** Position along the path as an arc-length fraction. */
  t: number;
  /** Vertical offset from the path point (at most `maxOffset`). */
  offset: number;
  rect: Rect;
}

export interface LabelOptions {
  /** Restrict the label to this stretch of the path (arc-length fractions). */
  range?: [number, number];
  /** Slots occupied by another edge; a label there would name the wrong line. */
  avoid?: boolean[];
  /** Hard cap for the label centre's distance from the path. Default 8px. */
  maxOffset?: number;
}

function rectOverlapArea(a: Rect, b: Rect, pad: number): number {
  const x0 = Math.max(a.x, b.x - pad);
  const y0 = Math.max(a.y, b.y - pad);
  const x1 = Math.min(a.x + a.w, b.x + b.w + pad);
  const y1 = Math.min(a.y + a.h, b.y + b.h + pad);
  return Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
}

function labelPenalty(rect: Rect, obstacles: Rect[], placed: Rect[]): number {
  let penalty = 0;
  for (const obstacle of obstacles) penalty += rectOverlapArea(rect, obstacle, 1) * 4;
  for (const other of placed) penalty += rectOverlapArea(rect, other, 4);
  return penalty;
}

/**
 * Place a label on its own line: the centre stays within `maxOffset` of the
 * path, the pill is searched along the line so it never covers a node, a group
 * header or another label. The background pill masks the line underneath, so
 * offset 0 reads as a label sitting *on* the wire.
 */
export function placeLabelOnPath(
  path: PathMetrics,
  width: number,
  height: number,
  obstacles: Rect[],
  placed: Rect[],
  options: LabelOptions = {},
): LabelPlacement {
  const maxOffset = Math.max(0, options.maxOffset ?? 8);
  const offsets = [0, 6, -6, 8, -8].filter((offset) => Math.abs(offset) <= maxOffset);
  if (!offsets.length) offsets.push(0);
  const seen = new Set<string>();
  const candidates: { t: number; offset: number }[] = [];
  const push = (t: number, offset: number) => {
    if (!t || t <= 0 || t >= 1) return;
    const key = `${t.toFixed(3)}:${offset}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ t, offset });
  };
  const range = options.range;
  const inRange = (t: number) => !range || (t >= range[0] && t <= range[1]);
  // A pill as wide as the text hides the line under its whole span, so foreign
  // marks under the pill count as a soft collision. They never veto a spot by
  // themselves: covering another wire is better than covering a node.
  const pad = (width / 2 + 6) / Math.max(1, path.total);
  const foreignCount = (t: number): number => {
    if (!options.avoid) return 0;
    const last = options.avoid.length - 1;
    const lo = Math.max(0, Math.round((t - pad) * last));
    const hi = Math.min(last, Math.round((t + pad) * last));
    let count = 0;
    for (let i = lo; i <= hi; i++) if (options.avoid[i]) count++;
    return count;
  };

  const ts: number[] = [];
  for (let i = 1; i < 50; i++) ts.push(i / 50);
  for (let i = 0; i < path.points.length - 1; i++) {
    const length = path.lengths[i + 1]! - path.lengths[i]!;
    if (length < 24) continue;
    ts.push((path.lengths[i]! + length / 2) / Math.max(1, path.total));
  }
  const ordered = [...new Set(ts.map((t) => Number(t.toFixed(4))))]
    .filter(inRange)
    .sort((a, b) => Math.abs(a - 0.5) - Math.abs(b - 0.5));
  for (const offset of offsets) {
    for (const t of ordered) push(t, offset);
  }
  if (!candidates.length) {
    for (const offset of offsets) {
      for (let i = 1; i < 50; i++) push(i / 50, offset);
    }
  }

  let best: LabelPlacement | null = null;
  let bestPenalty = Infinity;
  for (const { t, offset } of candidates) {
    const point = pointAtLength(path, t * path.total);
    const rect: Rect = {
      x: point.x - width / 2 - 5,
      y: point.y - height / 2 + offset,
      w: width + 10,
      h: height,
    };
    const penalty = labelPenalty(rect, obstacles, placed) + foreignCount(t) * 30;
    if (penalty === 0) return { x: point.x, y: point.y + offset, t, offset, rect };
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      best = { x: point.x, y: point.y + offset, t, offset, rect };
    }
  }
  if (best) return best;
  const point = pointAtLength(path, path.total * 0.5);
  return {
    x: point.x,
    y: point.y,
    t: 0.5,
    offset: 0,
    rect: { x: point.x - width / 2 - 5, y: point.y - height / 2, w: width + 10, h: height },
  };
}
