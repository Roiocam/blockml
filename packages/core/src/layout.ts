import type { BlockDocument, NodeDecl, Point } from "./ast.js";
import { DEFAULT_BOX, type BoxOptions } from "./geometry.js";

export type LayoutAlgorithm = "layered" | "pipeline" | "snowflake" | "compact";

export const LAYOUT_ALGORITHMS: LayoutAlgorithm[] = ["layered", "pipeline", "snowflake", "compact"];

export const LAYOUT_LABELS: Record<LayoutAlgorithm, string> = {
  layered: "从左到右",
  pipeline: "Pipeline",
  snowflake: "雪花形",
  compact: "紧凑型",
};

export interface LayoutOptions extends BoxOptions {
  origin?: Point;
  gapX?: number;
  gapY?: number;
  /** Extra vertical space inserted when the group changes (keeps group frames apart). */
  groupGap?: number;
}

const DEFAULTS: Required<LayoutOptions> = {
  ...DEFAULT_BOX,
  origin: { x: 80, y: 80 },
  gapX: 110,
  gapY: 56,
  groupGap: 74,
};

function resolve(options?: LayoutOptions): Required<LayoutOptions> {
  return {
    width: options?.width ?? DEFAULTS.width,
    height: options?.height ?? DEFAULTS.height,
    origin: options?.origin ?? DEFAULTS.origin,
    gapX: options?.gapX ?? DEFAULTS.gapX,
    gapY: options?.gapY ?? DEFAULTS.gapY,
    groupGap: options?.groupGap ?? DEFAULTS.groupGap,
  };
}

interface Graph {
  nodes: NodeDecl[];
  outgoing: Map<string, string[]>;
  incoming: Map<string, string[]>;
  degree: Map<string, number>;
  /** Declaration order, used as the tie-breaker so hand-written intent survives. */
  order: Map<string, number>;
}

function buildGraph(document: BlockDocument): Graph {
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  const degree = new Map<string, number>();
  const order = new Map<string, number>();
  document.nodes.forEach((node, index) => {
    outgoing.set(node.id, []);
    incoming.set(node.id, []);
    degree.set(node.id, 0);
    order.set(node.id, index);
  });
  for (const edge of document.edges) {
    if (!outgoing.has(edge.from) || !outgoing.has(edge.to)) continue;
    outgoing.get(edge.from)!.push(edge.to);
    incoming.get(edge.to)!.push(edge.from);
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
  }
  return { nodes: document.nodes, outgoing, incoming, degree, order };
}

/** Longest-path depth, cycle-safe (nodes stuck in a cycle fall back to depth 0). */
function depths(graph: Graph): Map<string, number> {
  const depth = new Map<string, number>();
  for (const node of graph.nodes) depth.set(node.id, 0);

  const limit = graph.nodes.length;
  for (let round = 0; round < limit; round++) {
    let changed = false;
    for (const node of graph.nodes) {
      const d = depth.get(node.id)!;
      for (const next of graph.outgoing.get(node.id) ?? []) {
        if (depth.get(next)! < d + 1) {
          depth.set(next, d + 1);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }

  // Cycles inflate depths without bound; clamp so a cycle does not push
  // everything into a single far-right column.
  const maxDepth = Math.max(0, limit - 1);
  for (const [id, d] of depth) depth.set(id, Math.min(d, maxDepth));
  return depth;
}

function sortByGroup(nodes: NodeDecl[], document: BlockDocument, index: Map<string, number>): NodeDecl[] {
  const groupOrder = new Map(document.groups.map((g, i) => [g.id, i]));
  return [...nodes].sort((a, b) => {
    const ga = a.group ? groupOrder.get(a.group) ?? 999 : 999;
    const gb = b.group ? groupOrder.get(b.group) ?? 999 : 999;
    if (ga !== gb) return ga - gb;
    return (index.get(a.id) ?? 0) - (index.get(b.id) ?? 0);
  });
}

function roundPoint(p: Point): Point {
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

/* ------------------------------------------------------------------ layered */

/**
 * Columns are owned by groups: every member of a group lands in the same column,
 * placed at the group's shallowest depth. This keeps group frames narrow and
 * non-overlapping — at the cost of pulling deep members one column left.
 */
function layered(document: BlockDocument, options: Required<LayoutOptions>): Map<string, Point> {
  const graph = buildGraph(document);
  const nodeDepth = depths(graph);

  const groupDepth = new Map<string, number>();
  const groupOrder = new Map(document.groups.map((g, i) => [g.id, i]));
  for (const node of document.nodes) {
    if (!node.group) continue;
    const d = nodeDepth.get(node.id) ?? 0;
    const current = groupDepth.get(node.group);
    groupDepth.set(node.group, current === undefined ? d : Math.min(current, d));
  }

  interface Column {
    key: string;
    depth: number;
    order: number;
    nodes: NodeDecl[];
  }
  const columns = new Map<string, Column>();

  for (const node of document.nodes) {
    const key = node.group ? `g:${node.group}` : `d:${nodeDepth.get(node.id) ?? 0}`;
    const depth = node.group ? groupDepth.get(node.group) ?? 0 : nodeDepth.get(node.id) ?? 0;
    const order = node.group ? groupOrder.get(node.group) ?? 999 : 999;
    let column = columns.get(key);
    if (!column) {
      column = { key, depth, order, nodes: [] };
      columns.set(key, column);
    }
    column.nodes.push(node);
  }

  const ordered = [...columns.values()].sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    return a.order - b.order;
  });

  const result = new Map<string, Point>();
  ordered.forEach((column, columnIndex) => {
    const x = options.origin.x + columnIndex * (options.width + options.gapX);
    const nodes = [...column.nodes].sort(
      (a, b) => (graph.order.get(a.id) ?? 0) - (graph.order.get(b.id) ?? 0),
    );
    let y = options.origin.y;
    for (const node of nodes) {
      result.set(node.id, roundPoint({ x, y }));
      y += options.height + options.gapY;
    }
  });
  return result;
}

/* ----------------------------------------------------------------- pipeline */

function pipeline(document: BlockDocument, options: Required<LayoutOptions>): Map<string, Point> {
  const buckets: NodeDecl[][] = document.groups.map(() => []);
  const loose: NodeDecl[] = [];
  const index = new Map(document.groups.map((g, i) => [g.id, i]));

  for (const node of document.nodes) {
    const at = node.group ? index.get(node.group) : undefined;
    if (at === undefined) loose.push(node);
    else buckets[at]!.push(node);
  }
  if (loose.length) buckets.push(loose);

  const result = new Map<string, Point>();
  buckets.forEach((nodes, columnIndex) => {
    const x = options.origin.x + columnIndex * (options.width + options.gapX);
    nodes.forEach((node, rowIndex) => {
      result.set(node.id, roundPoint({
        x,
        y: options.origin.y + rowIndex * (options.height + options.gapY),
      }));
    });
  });
  return result;
}

/* ---------------------------------------------------------------- snowflake */

function snowflake(document: BlockDocument, options: Required<LayoutOptions>): Map<string, Point> {
  const graph = buildGraph(document);
  if (!graph.nodes.length) return new Map();

  const sorted = [...graph.nodes].sort((a, b) => {
    const diff = (graph.degree.get(b.id) ?? 0) - (graph.degree.get(a.id) ?? 0);
    return diff !== 0 ? diff : a.id.localeCompare(b.id);
  });

  const center = sorted[0]!;
  const rest = sortByGroup(sorted.slice(1), document, graph.order);

  const stepX = options.width + options.gapX;
  const stepY = options.height + options.gapY;
  const baseRadius = Math.max(stepX, stepY) * 0.9;

  const result = new Map<string, Point>();
  result.set(center.id, roundPoint({ x: options.origin.x, y: options.origin.y }));

  let cursor = 0;
  let ring = 1;
  while (cursor < rest.length) {
    const capacity = 6 * ring;
    const slice = rest.slice(cursor, cursor + capacity);
    const radius = baseRadius * ring;
    slice.forEach((node, i) => {
      const angle = (Math.PI * 2 * i) / slice.length - Math.PI / 2;
      result.set(node.id, roundPoint({
        x: options.origin.x + Math.cos(angle) * radius,
        y: options.origin.y + Math.sin(angle) * radius,
      }));
    });
    cursor += slice.length;
    ring++;
  }

  // Normalise so nothing lands at negative coordinates.
  let minX = Infinity;
  let minY = Infinity;
  for (const p of result.values()) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
  }
  const dx = options.origin.x - minX;
  const dy = options.origin.y - minY;
  for (const [id, p] of result) result.set(id, roundPoint({ x: p.x + dx, y: p.y + dy }));
  return result;
}

/* ------------------------------------------------------------------ compact */

function compact(document: BlockDocument, options: Required<LayoutOptions>): Map<string, Point> {
  const graph = buildGraph(document);
  const sorted = [...graph.nodes].sort((a, b) => {
    const diff = (graph.degree.get(b.id) ?? 0) - (graph.degree.get(a.id) ?? 0);
    return diff !== 0 ? diff : a.id.localeCompare(b.id);
  });

  const columns = Math.max(1, Math.ceil(Math.sqrt(sorted.length)));
  const result = new Map<string, Point>();
  sorted.forEach((node, i) => {
    result.set(node.id, roundPoint({
      x: options.origin.x + (i % columns) * (options.width + options.gapX),
      y: options.origin.y + Math.floor(i / columns) * (options.height + options.gapY),
    }));
  });
  return result;
}

/* --------------------------------------------------------------------- api  */

/**
 * Deterministic layout for every node in the document.
 * Custom `at` values are intentionally ignored — this is an explicit re-layout.
 */
export function layoutDocument(
  document: BlockDocument,
  algorithm: LayoutAlgorithm,
  options?: LayoutOptions,
): Map<string, Point> {
  const resolved = resolve(options);
  switch (algorithm) {
    case "pipeline":
      return pipeline(document, resolved);
    case "snowflake":
      return snowflake(document, resolved);
    case "compact":
      return compact(document, resolved);
    case "layered":
    default:
      return layered(document, resolved);
  }
}

/** Nodes reachable from or into `id`, used for hover/selection highlighting. */
export function relatedEdges(document: BlockDocument, id: string | null): Set<string> {
  const set = new Set<string>();
  if (!id) return set;
  for (const edge of document.edges) {
    if (edge.from === id || edge.to === id) set.add(edge.id);
  }
  return set;
}

export function relatedNodes(document: BlockDocument, id: string | null): Set<string> {
  const set = new Set<string>();
  if (!id) return set;
  set.add(id);
  for (const edge of document.edges) {
    if (edge.from === id) set.add(edge.to);
    if (edge.to === id) set.add(edge.from);
  }
  return set;
}

