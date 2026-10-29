import {
  applyLayout,
  anchorPoint,
  parse,
  DEFAULT_BOX,
  autoLayout,
  bezierAt,
  boxOf,
  contentBounds,
  edgeDisplayName,
  edgeGeometry,
  edgeKindStyle,
  edgeSide,
  groupBoundingBox,
  groupEdgeCount,
  indexPairs,
  orthogonalRoute,
  hasErrors,
  isNodeVisible,
  layoutDocument,
  nodeDisplayName,
  relatedEdges,
  relatedNodes,
  nodeKindStyle,
  pathOf,
  primarySide,
  resolveVisibility,
  serialize,
  sideMidpoint,
  sideRange,
  visibleEdges,
  visibleGroups,
  visibleNodes,
  GROUP_HEAD,
  GROUP_PAD,
  type BlockDocument,
  type Diagnostic,
  type EdgeDecl,
  type EdgeSide,
  type EdgeGeometry,
  type ForcedAnchor,
  type GroupDecl,
  type NodeDecl,
  type NodeBox,
  type LayoutAlgorithm,
  type OrthogonalRoute,
  type ParseResult,
  type Point,
  type Rect,
  type RouteStyle,
  type Visibility,
} from "@block-ml/core";
import { VIEWER_CSS } from "./styles.js";

const SVGNS = "http://www.w3.org/2000/svg";

export interface ViewerOptions {
  source: string;
  readOnly?: boolean;
  theme?: "light" | "dark";
  showLegend?: boolean;
  showInspector?: boolean;
  onSourceChange?: (source: string) => void;
  onDiagnostics?: (diagnostics: Diagnostic[]) => void;
  /** Fired whenever a group is collapsed or a group/node is hidden. */
  onVisibilityChange?: (state: ViewerVisibility) => void;
}

export interface ViewerVisibility {
  hiddenNodes: string[];
  hiddenGroups: string[];
  collapsedGroups: string[];
}

export interface ViewerHandle {
  update(source: string): void;
  getSource(): string;
  setReadOnly(readOnly: boolean): void;
  fit(): void;
  zoomTo(scale: number): void;
  layout(algorithm: LayoutAlgorithm): void;
  toggleLayers(open?: boolean): void;
  toggleGroupCollapsed(id: string): void;
  setHiddenNodes(ids: string[]): void;
  setHiddenGroups(ids: string[]): void;
  setCollapsedGroups(ids: string[]): void;
  showAll(): void;
  getVisibility(): ViewerVisibility;
  toSVG(): string;
  getView(): { x: number; y: number; k: number };
  getDocument(): BlockDocument | null;
  getDiagnostics(): Diagnostic[];
  destroy(): void;
}

let stylesInjected = false;
function injectStyles(): void {
  if (stylesInjected) return;
  if (typeof document === "undefined") return;
  const style = document.createElement("style");
  style.setAttribute("data-blockml", "");
  style.textContent = VIEWER_CSS;
  document.head.appendChild(style);
  stylesInjected = true;
}

function el<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string | number | undefined>,
  parent?: Element,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVGNS, tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value !== undefined) node.setAttribute(key, String(value));
    }
  }
  if (parent) parent.appendChild(node);
  return node;
}

const measureCanvas = typeof document !== "undefined" ? document.createElement("canvas") : null;
const measureCtx = measureCanvas?.getContext("2d") ?? null;
const measureCache = new Map<string, number>();

function textWidth(text: string, font: string): number {
  const key = `${font}\u0000${text}`;
  const hit = measureCache.get(key);
  if (hit !== undefined) return hit;
  let width = text.length * 7;
  if (measureCtx) {
    measureCtx.font = font;
    width = measureCtx.measureText(text).width;
  }
  if (measureCache.size > 4000) measureCache.clear();
  measureCache.set(key, width);
  return width;
}

function truncate(text: string, font: string, maxWidth: number): string {
  if (textWidth(text, font) <= maxWidth) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (textWidth(text.slice(0, mid) + "…", font) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + "…";
}

class Viewer implements ViewerHandle {
  private root: HTMLElement;
  private svg: SVGSVGElement;
  private viewport: SVGGElement;
  private groupLayer: SVGGElement;
  private edgeLayer: SVGGElement;
  private nodeLayer: SVGGElement;
  private headerLayer: SVGGElement;
  private labelLayer: SVGGElement;
  private uiLayer: SVGGElement;
  private overlayLayer: SVGGElement;
  private defs: SVGDefsElement;
  private legend: HTMLElement;
  private inspector: HTMLElement;
  private layersPanel: HTMLElement;
  private errorBox: HTMLElement;

  private options: ViewerOptions;
  private source: string;
  private doc: BlockDocument | null = null;
  /** `doc` filtered by the current visibility; nodes are the same objects. */
  private viewDoc: BlockDocument | null = null;
  private diagnostics: Diagnostic[] = [];
  private view = { x: 40, y: 20, k: 1 };
  private routeStyle: RouteStyle = "curve";
  private selectedNode: string | null = null;
  private selectedNodes = new Set<string>();
  private selectedEdge: string | null = null;
  private pointerSelected = false;
  private fans = new Map<string, { from?: number; to?: number }>();
  private bundleOf = new Map<string, string>();
  private bundleInfo = new Map<
    string,
    { end: "from" | "to"; trunk?: { x?: number; y?: number }; sharedX: number; sharedY: number }
  >();
  private forcedAnchors = new Map<string, { from?: ForcedAnchor; to?: ForcedAnchor }>();
  private trunks = new Map<string, { x?: number; y?: number }>();
  private hoveredNode: string | null = null;
  private hiddenNodes = new Set<string>();
  private hiddenGroups = new Set<string>();
  private collapsedGroups = new Set<string>();
  private layersOpen = false;
  private nodeEls = new Map<string, SVGGElement>();
  private edgeEls = new Map<string, { line: SVGPathElement; hit: SVGPathElement; labelLayer: SVGGElement }>();
  private groupEls = new Map<
    string,
    { rect: SVGRectElement; text: SVGTextElement; toggle: SVGGElement; sign: SVGTextElement }
  >();
  private placedLabels: Rect[] = [];
  private fitted = false;
  private destroyed = false;
  private suppressClick = false;

  constructor(target: HTMLElement, options: ViewerOptions) {
    injectStyles();
    this.options = options;
    this.source = options.source;

    this.root = document.createElement("div");
    this.root.className = "bml-root";
    this.root.dataset.bmlTheme = options.theme ?? "light";
    if (options.readOnly) this.root.classList.add("bml-readonly");
    target.appendChild(this.root);

    this.svg = el("svg", { class: "bml-svg" }) as SVGSVGElement;
    this.defs = el("defs") as SVGDefsElement;
    this.viewport = el("g", { class: "bml-viewport" });
    this.groupLayer = el("g", { class: "bml-groups" });
    this.edgeLayer = el("g", { class: "bml-edges" });
    this.headerLayer = el("g", { class: "bml-group-heads" });
    this.nodeLayer = el("g", { class: "bml-nodes" });
    this.labelLayer = el("g", { class: "bml-labels" });
    this.uiLayer = el("g", { class: "bml-ui" });
    this.overlayLayer = el("g", { class: "bml-overlay" });

    this.svg.appendChild(this.defs);
    this.viewport.appendChild(this.groupLayer);
    this.viewport.appendChild(this.edgeLayer);
    this.viewport.appendChild(this.headerLayer);
    this.viewport.appendChild(this.nodeLayer);
    this.viewport.appendChild(this.labelLayer);
    this.viewport.appendChild(this.uiLayer);
    this.viewport.appendChild(this.overlayLayer);
    this.svg.appendChild(this.viewport);
    this.root.appendChild(this.svg);

    this.legend = document.createElement("div");
    this.legend.className = "bml-legend";
    this.root.appendChild(this.legend);

    this.errorBox = document.createElement("div");
    this.errorBox.className = "bml-error";
    this.errorBox.style.display = "none";
    this.root.appendChild(this.errorBox);

    this.inspector = document.createElement("aside");
    this.inspector.className = "bml-inspector";
    this.root.appendChild(this.inspector);

    this.layersPanel = document.createElement("section");
    this.layersPanel.className = "bml-layers";
    this.root.appendChild(this.layersPanel);
    this.bindLayersPanel();

    this.buildDefs();
    this.bindCanvas();
  }

  /* ---------------------------------------------------------------- data */

  private parse(source: string): void {
    const result: ParseResult = parse(source);
    this.diagnostics = result.diagnostics;
    this.options.onDiagnostics?.(result.diagnostics);

    if (hasErrors(result.diagnostics)) {
      this.showErrors(result.diagnostics);
      return;
    }
    this.hideErrors();

    const doc = result.document;
    // Fill missing positions in memory only; the source file stays untouched.
    const layout = autoLayout(doc);
    for (const node of doc.nodes) {
      if (!node.at) node.at = layout.get(node.id) ?? { x: 0, y: 0 };
    }
    this.doc = doc;
    this.rebuildView();
  }

  /* ---------------------------------------------------------- visibility */

  private visibility(): Visibility {
    return resolveVisibility({
      hiddenNodes: this.hiddenNodes,
      hiddenGroups: this.hiddenGroups,
      collapsedGroups: this.collapsedGroups,
    });
  }

  private rebuildView(): void {
    if (!this.doc) {
      this.viewDoc = null;
      return;
    }
    const visibility = this.visibility();
    this.viewDoc = {
      ...this.doc,
      nodes: visibleNodes(this.doc, visibility),
      edges: visibleEdges(this.doc, visibility),
      groups: visibleGroups(this.doc, visibility),
    };
  }

  /** Full bounding box of a group, including members that are hidden or folded away. */
  private fullGroupBox(group: GroupDecl): Rect | null {
    if (!this.doc) return null;
    return groupBoundingBox(this.doc.nodes.filter((node) => node.group === group.id));
  }

  /** A collapsed group shrinks to a compact chip anchored at its frame origin. */
  private collapseChip(full: Rect): Rect {
    return { x: full.x, y: full.y, w: Math.max(180, Math.min(full.w, 300)), h: 40 };
  }

  private viewBounds(): Rect {
    const base = contentBounds(this.viewDoc ?? this.doc!);
    let { x, y } = base;
    let x1 = base.x + base.w;
    let y1 = base.y + base.h;
    for (const group of this.doc?.groups ?? []) {
      if (!this.collapsedGroups.has(group.id) || this.hiddenGroups.has(group.id)) continue;
      const full = this.fullGroupBox(group);
      if (!full) continue;
      const chip = this.collapseChip(full);
      x = Math.min(x, chip.x);
      y = Math.min(y, chip.y);
      x1 = Math.max(x1, chip.x + chip.w);
      y1 = Math.max(y1, chip.y + chip.h);
    }
    return { x, y, w: x1 - x, h: y1 - y };
  }

  private showErrors(diagnostics: Diagnostic[]): void {
    const first = diagnostics.find((d) => d.severity === "error");
    if (!first) return;
    this.errorBox.style.display = "block";
    this.errorBox.innerHTML =
      `<b>第 ${first.line} 行</b> · ${escape(first.message)}` +
      (first.hint ? `<br><code>${escape(first.hint)}</code>` : "");
  }

  private hideErrors(): void {
    this.errorBox.style.display = "none";
  }

  /* -------------------------------------------------------------- render */

  private buildDefs(): void {
    const shadow = el("filter", {
      id: "bml-node-shadow", x: "-20%", y: "-20%", width: "140%", height: "140%",
    });
    el("feDropShadow", {
      dx: 0, dy: 1, stdDeviation: 1.6, "flood-color": "#0f172a", "flood-opacity": 0.07,
    }, shadow);
    this.defs.appendChild(shadow);

    const shadowSel = el("filter", {
      id: "bml-node-shadow-sel", x: "-20%", y: "-20%", width: "140%", height: "140%",
    });
    el("feDropShadow", {
      dx: 0, dy: 4, stdDeviation: 7, "flood-color": "#4f46e5", "flood-opacity": 0.22,
    }, shadowSel);
    this.defs.appendChild(shadowSel);

    const pattern = el("pattern", {
      id: "bml-grid", width: 24, height: 24, patternUnits: "userSpaceOnUse",
    });
    el("circle", { cx: 1.2, cy: 1.2, r: 1.05, class: "bml-grid-dot" }, pattern);
    this.defs.appendChild(pattern);

    const kinds = new Set<string>();
    if (this.doc) for (const edge of this.doc.edges) kinds.add(edge.kind);
    for (const kind of ["rest", "acp", "sse", "sql", "rpc", "oidc", "llm", "mcp", "ws", "gate", "opt"]) {
      kinds.add(kind);
    }
    for (const kind of kinds) {
      const marker = el("marker", {
        id: `bml-arrow-${kind}`,
        viewBox: "0 0 10 10",
        refX: 8.4,
        refY: 5,
        markerWidth: 6.6,
        markerHeight: 6.6,
        orient: "auto-start-reverse",
      });
      el("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: edgeKindStyle(kind).color }, marker);
      this.defs.appendChild(marker);
    }
  }

  private render(): void {
    if (!this.doc || !this.viewDoc) return;
    this.routeStyle = this.doc.diagram?.route ?? "curve";
    this.nodeEls.clear();
    this.edgeEls.clear();
    this.groupEls.clear();
    this.placedLabels = [];
    this.groupLayer.innerHTML = "";
    this.edgeLayer.innerHTML = "";
    this.nodeLayer.innerHTML = "";
    this.headerLayer.innerHTML = "";
    this.labelLayer.innerHTML = "";
    this.uiLayer.innerHTML = "";
    this.overlayLayer.innerHTML = "";

    const grid = el("rect", {
      x: -8000, y: -8000, width: 16000, height: 16000, fill: "url(#bml-grid)",
    });
    this.groupLayer.appendChild(grid);

    this.renderGroups();
    this.renderEdges();
    this.renderNodes();
    this.renderLegend();
    this.applySelection();
    this.renderLayersPanel();
  }

  private renderGroups(): void {
    if (!this.doc || !this.viewDoc) return;
    for (const group of this.viewDoc.groups) {
      const members = this.doc.nodes.filter((node) => node.group === group.id);
      const full = groupBoundingBox(members);
      if (!full) continue;

      const collapsed = this.collapsedGroups.has(group.id);
      const shown = members.filter((node) => isNodeVisible(node, this.visibility()));
      if (!collapsed && !shown.length) continue;

      const box = collapsed ? this.collapseChip(full) : groupBoundingBox(shown)!;
      const color = group.color ?? "#64748b";
      const label = group.label ?? group.title;

      const rect = el("rect", {
        x: box.x, y: box.y, width: box.w, height: box.h, rx: 16,
        fill: color, stroke: color,
        class: collapsed ? "bml-group-box bml-collapsed" : "bml-group-box",
      }) as SVGRectElement;
      this.groupLayer.appendChild(rect);

      const family = getComputedStyle(this.root).fontFamily;
      const text = el("text", {
        x: box.x + 16, y: box.y + (collapsed ? 24 : 21),
        class: "bml-group-label", fill: color,
      }) as SVGTextElement;
      text.textContent = collapsed
        ? truncate(
            `${label} · ${members.length} 节点 / ${groupEdgeCount(this.doc, group.id)} 连线`,
            `600 10.5px ${family}`,
            box.w - 42,
          )
        : label;
      // The header sits above the edge layer, with a pill masking any line that
      // passes behind it, so routes never slice through the title text.
      const head = el("g", { class: "bml-group-head", "data-id": group.id });
      const headWidth = textWidth(text.textContent, `600 10.5px ${family}`) + 16;
      el("rect", {
        x: box.x + 10, y: box.y + (collapsed ? 11 : 8), width: headWidth, height: 17, rx: 4,
        class: "bml-group-label-bg",
        // Matches the tint the group box paints over the canvas, so the pill
        // is invisible against the group but still hides any line behind it.
        style: `fill:color-mix(in srgb, var(--bml-label-bg) ${collapsed ? 90 : 94}%, ${color} ${collapsed ? 10 : 6}%)`,
      }, head);
      head.appendChild(text);
      this.headerLayer.appendChild(head);

      const toggle = el("g", {
        class: "bml-group-toggle",
        "data-id": group.id,
        transform: `translate(${box.x + box.w - 16} ${box.y + (collapsed ? 20 : 19)})`,
      });
      el("title", {}, toggle).textContent = collapsed ? `展开 ${label}` : `折叠 ${label}`;
      el("circle", {
        r: 9, fill: "var(--bml-panel)", stroke: color, "stroke-opacity": 0.35,
      }, toggle);
      const sign = el("text", {
        y: 0.5, "text-anchor": "middle", "dominant-baseline": "central",
        fill: color, class: "bml-toggle-sign",
      }) as SVGTextElement;
      sign.textContent = collapsed ? "+" : "−";
      toggle.appendChild(sign);
      toggle.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        event.stopPropagation();
      });
      toggle.addEventListener("click", (event) => {
        event.stopPropagation();
        this.toggleGroupCollapsed(group.id);
      });
      this.uiLayer.appendChild(toggle);

      this.groupEls.set(group.id, { rect, text, toggle, sign });
    }
  }

  private edgeGeometryOf(edge: EdgeDecl): EdgeGeometry | null {
    if (!this.viewDoc) return null;
    return edgeGeometry(edge, {
      byId: this.nodeMap(),
      pairs: indexPairs(this.viewDoc),
      fans: this.fans,
    });
  }

  private nodeMap(): Map<string, NodeDecl> {
    return new Map(this.viewDoc?.nodes.map((n) => [n.id, n]) ?? []);
  }

  /**
   * Edges that meet at a node fan out along its border instead of leaving from
   * the same anchor point, so they never draw on top of each other. Offsets
   * follow the anchor's position along the border — sorting by target angle
   * would invert the order and cancel the spread.
   */
  private computeFans(): void {
    this.fans = new Map();
    if (!this.viewDoc) return;
    const nodes = this.nodeMap();
    type FanItem = { edge: EdgeDecl; end: "from" | "to"; side: EdgeSide; box: Rect; along: number };
    const groups = new Map<string, FanItem[]>();
    const push = (nodeId: string, item: FanItem) => {
      const key = `${nodeId}\u0000${item.side}`;
      const list = groups.get(key);
      if (list) list.push(item);
      else groups.set(key, [item]);
    };
    for (const edge of this.viewDoc.edges) {
      const from = nodes.get(edge.from);
      const to = nodes.get(edge.to);
      if (!from || !to) continue;
      const fc = boxOf(from);
      const tc = boxOf(to);
      const a1 = anchorPoint(from, { x: tc.cx, y: tc.cy });
      const a2 = anchorPoint(to, { x: fc.cx, y: fc.cy });
      const s1 = edgeSide(a1, fc);
      const s2 = edgeSide(a2, tc);
      const along = (point: Point, side: EdgeSide) => (side === "top" || side === "bottom" ? point.x : point.y);
      push(edge.from, { edge, end: "from", side: s1, box: fc, along: along(a1, s1) });
      push(edge.to, { edge, end: "to", side: s2, box: tc, along: along(a2, s2) });
    }
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      list.sort((a, b) => a.along - b.along);
      const box = list[0]!.box;
      const range = sideRange(box, list[0]!.side as EdgeSide);
      // Targets are laid out inside the usable border span, so the offsets
      // themselves never clamp at the ends and collapse two anchors together.
      const step = Math.min(14, (range.max - range.min) / (list.length - 1));
      const span = step * (list.length - 1);
      const midpoint = (list[0]!.along + list[list.length - 1]!.along) / 2;
      const start = clamp(midpoint - span / 2, range.min, range.max - span);
      list.forEach((item, index) => {
        const offset = Math.round(start + index * step - item.along);
        if (!offset) return;
        const slot = this.fans.get(item.edge.id) ?? {};
        slot[item.end] = offset;
        this.fans.set(item.edge.id, slot);
      });
    }
  }

  /**
   * Edges that declare the same `bundle:` share their common endpoint and a
   * trunk, so a node reaching several peers draws one line that branches out
   * instead of a stack of near-parallel ones.
   */
  private computeBundles(): void {
    this.bundleOf = new Map();
    this.bundleInfo = new Map();
    this.forcedAnchors = new Map();
    this.trunks = new Map();
    if (!this.viewDoc) return;
    const nodes = this.nodeMap();
    const boxes = new Map([...nodes].map(([id, node]) => [id, boxOf(node)]));
    const groups = new Map<string, EdgeDecl[]>();
    for (const edge of this.viewDoc.edges) {
      if (!edge.bundle) continue;
      const list = groups.get(edge.bundle);
      if (list) list.push(edge);
      else groups.set(edge.bundle, [edge]);
    }
    for (const [name, list] of groups) {
      if (list.length < 2) continue;
      let end: "from" | "to" | null = null;
      for (const candidate of ["from", "to"] as const) {
        const sharedId = list[0]![candidate];
        if (list.every((edge) => edge[candidate] === sharedId)) {
          end = candidate;
          break;
        }
      }
      if (!end) continue;
      const other = end === "from" ? "to" : "from";
      const sharedNode = nodes.get(list[0]![end]);
      const sharedBox = sharedNode ? boxes.get(sharedNode.id) : undefined;
      if (!sharedNode || !sharedBox) continue;
      const peers = list
        .map((edge) => ({ edge, node: nodes.get(edge[other]), box: boxes.get(edge[other]) }))
        .filter((item): item is { edge: EdgeDecl; node: NodeDecl; box: NodeBox } => !!item.node && !!item.box);
      if (peers.length < 2) continue;
      const centroid = {
        x: peers.reduce((sum, item) => sum + item.box.cx, 0) / peers.length,
        y: peers.reduce((sum, item) => sum + item.box.cy, 0) / peers.length,
      };
      const side = edgeSide(anchorPoint(sharedNode, centroid), sharedBox);
      const point = sideMidpoint(sharedBox, side);
      const horizontal = side === "left" || side === "right";
      const others = peers.map((item) => {
        const peerPoint = anchorPoint(item.node, { x: sharedBox.cx, y: sharedBox.cy });
        return { side: edgeSide(peerPoint, item.box), at: horizontal ? peerPoint.x : peerPoint.y };
      });
      let trunk: { x?: number; y?: number } | undefined;
      const sameAxis = others.every((peer) => (peer.side === "left" || peer.side === "right") === horizontal);
      if (sameAxis) {
        const border = horizontal
          ? side === "left"
            ? sharedBox.x
            : sharedBox.x + sharedBox.w
          : side === "top"
            ? sharedBox.y
            : sharedBox.y + sharedBox.h;
        const outward = side === "left" || side === "top" ? -1 : 1;
        const values = others.map((peer) => peer.at);
        const middle = (border + values.reduce((sum, value) => sum + value, 0) / values.length) / 2;
        const nearNode = border + outward * 30;
        const nearPeers = (outward > 0 ? Math.min(...values) : Math.max(...values)) - outward * 20;
        const low = Math.min(nearNode, nearPeers);
        const high = Math.max(nearNode, nearPeers);
        const at = Math.round(clamp(middle, low, high));
        const valid = outward > 0 ? at >= nearNode && at <= nearPeers : at <= nearNode && at >= nearPeers;
        if (valid) trunk = horizontal ? { x: at } : { y: at };
      }
      for (const item of peers) {
        this.bundleOf.set(item.edge.id, name);
        this.bundleInfo.set(item.edge.id, { end, trunk, sharedX: point.x, sharedY: point.y });
        const forced = this.forcedAnchors.get(item.edge.id) ?? {};
        forced[end] = { point, side };
        this.forcedAnchors.set(item.edge.id, forced);
        if (trunk) this.trunks.set(item.edge.id, trunk);
      }
    }
  }

  /**
   * Orthogonal routes for every edge. Lanes shift the trunk/stub of an edge so
   * no two edges draw on the same line; leftover conflicts are repaired by
   * re-laning the earlier edge while the total overlap keeps dropping.
   */
  private buildOrthogonalRoutes(
    nodeObstacles: { id: string; rect: Rect }[],
    soft: Rect[],
  ): Map<string, OrthogonalRoute> {
    const routes = new Map<string, OrthogonalRoute>();
    if (!this.viewDoc) return routes;
    this.computeBundles();
    const ctx = {
      byId: this.nodeMap(),
      pairs: indexPairs(this.viewDoc),
      fans: this.fans,
      obstacles: nodeObstacles,
      soft,
      anchors: this.forcedAnchors,
      trunks: this.trunks,
    };
    const edges = this.viewDoc.edges;
    const LANES = [0, 1, -1, 2, -2, 3, -3, 4, -4];
    // The router scores every side pair per lane, so compute the candidates
    // once up front; the greedy and repair passes only look them up.
    const candidates = new Map<string, Map<number, OrthogonalRoute>>();
    for (const edge of edges) {
      const perLane = new Map<number, OrthogonalRoute>();
      // Bundled edges share one trunk, so they must stay on the base lane.
      const lanesFor = this.bundleOf.has(edge.id) ? [0] : LANES;
      for (const lane of lanesFor) {
        const route = orthogonalRoute(edge, ctx, lane);
        if (route) perLane.set(lane, route);
      }
      candidates.set(edge.id, perLane);
    }
    const lanes = new Map<string, number>();
    const routeOf = (edge: EdgeDecl): OrthogonalRoute | undefined =>
      candidates.get(edge.id)?.get(lanes.get(edge.id) ?? 0);

    const sameBundle = (a: string, b: string): boolean => {
      const bundle = this.bundleOf.get(a);
      return bundle !== undefined && bundle === this.bundleOf.get(b);
    };
    // Two edges in the same color can share a line and still read as one
    // stroke, so their overlap is a soft cost; different colors must separate.
    const colorOf = new Map(edges.map((edge) => [edge.id, edgeKindStyle(edge.kind).color]));
    const weightOf = (a: string, b: string): number => (colorOf.get(a) === colorOf.get(b) ? 0.25 : 1);

    const accepted: { id: string; points: Point[] }[] = [];
    for (const edge of edges) {
      let chosen = 0;
      for (const lane of this.bundleOf.has(edge.id) ? [0] : LANES) {
        const route = candidates.get(edge.id)?.get(lane);
        if (!route) continue;
        const clash = accepted.some((item) => {
          if (sameBundle(item.id, edge.id)) return false;
          const shared = overlapLength(item.points, route.points, sharedPort(item.points, route.points)?.axis);
          return shared > (weightOf(item.id, edge.id) < 1 ? 40 : 1);
        });
        if (clash) continue;
        chosen = lane;
        break;
      }
      lanes.set(edge.id, chosen);
      const route = candidates.get(edge.id)?.get(chosen);
      if (route) accepted.push({ id: edge.id, points: route.points });
    }

    const totalOverlap = (): number => {
      const routed = edges
        .map((edge) => ({ id: edge.id, points: routeOf(edge)?.points }))
        .filter((item): item is { id: string; points: Point[] } => !!item.points);
      let total = 0;
      for (let i = 0; i < routed.length; i++) {
        for (let j = i + 1; j < routed.length; j++) {
          const a = routed[i]!;
          const b = routed[j]!;
          if (sameBundle(a.id, b.id)) continue;
          const shared = sharedPort(a.points, b.points)?.axis;
          total += overlapLength(a.points, b.points, shared) * weightOf(a.id, b.id);
          total += nearParallelLength(a.points, b.points, shared) * weightOf(a.id, b.id);
        }
      }
      return total;
    };
    let score = totalOverlap();
    for (let guard = 0; guard < 6 && score > 0; guard++) {
      let improved = false;
      for (const edge of edges) {
        const previous = lanes.get(edge.id) ?? 0;
        for (const lane of LANES) {
          if (lane === previous || !candidates.get(edge.id)?.has(lane)) continue;
          lanes.set(edge.id, lane);
          const trialScore = totalOverlap();
          if (trialScore < score - 0.5) {
            score = trialScore;
            improved = true;
            break;
          }
          lanes.set(edge.id, previous);
        }
        if (improved) break;
      }
      if (!improved) break;
    }
    for (const edge of edges) {
      const route = routeOf(edge);
      if (route) routes.set(edge.id, route);
    }
    return routes;
  }

  private collectObstacles(): {
    labels: Rect[];
    routes: { id: string; rect: Rect }[];
    soft: Rect[];
  } {
    const family = getComputedStyle(this.root).fontFamily;
    const view = this.viewDoc;
    if (!view) return { labels: [], routes: [], soft: [] };
    const doc = this.doc;
    const labels: Rect[] = view.nodes.map((n) => ({
      x: n.at!.x - 2, y: n.at!.y - 2, w: DEFAULT_BOX.width + 4, h: DEFAULT_BOX.height + 4,
    }));
    // Routes dodge node boxes and group labels/chips as well.
    const routes: { id: string; rect: Rect }[] = view.nodes.map((n) => ({ id: n.id, rect: boxOf(n) }));
    const soft: Rect[] = [];
    for (const group of view.groups) {
      const members = doc?.nodes.filter((n) => n.group === group.id) ?? [];
      const full = groupBoundingBox(members);
      if (!full) continue;
      if (this.collapsedGroups.has(group.id)) {
        const chip = this.collapseChip(full);
        const rect = { x: chip.x, y: chip.y, w: chip.w, h: chip.h };
        labels.push(rect);
        routes.push({ id: `group:${group.id}`, rect });
        continue;
      }
      const shown = members.filter((node) => isNodeVisible(node, this.visibility()));
      const box = groupBoundingBox(shown);
      if (!box) continue;
      const label = group.label ?? group.title;
      const width = textWidth(label, `600 10.5px ${family}`);
      const header = { x: box.x + 8, y: box.y + 5, w: width + 26, h: 24 };
      labels.push(header);
      soft.push(header);
    }
    return { labels, routes, soft };
  }

  /**
   * Positions along each route that sit on another edge. A label anchored there
   * would name a line that belongs to someone else.
   */
  private foreignMarks(paths: Map<string, PolyPath>): Map<string, boolean[]> {
    const out = new Map<string, boolean[]>();
    if (paths.size < 2) return out;
    const SAMPLES = 160;
    const routes = [...paths];
    const on = (point: Point, start: Point, end: Point): boolean => {
      const horizontal = Math.abs(start.y - end.y) < 0.5;
      if (horizontal) {
        if (Math.abs(point.y - start.y) > 1.5) return false;
        return point.x >= Math.min(start.x, end.x) - 1 && point.x <= Math.max(start.x, end.x) + 1;
      }
      if (Math.abs(point.x - start.x) > 1.5) return false;
      return point.y >= Math.min(start.y, end.y) - 1 && point.y <= Math.max(start.y, end.y) + 1;
    };
    for (const [id, path] of routes) {
      const marks: boolean[] = new Array(SAMPLES + 1).fill(false);
      for (let k = 0; k <= SAMPLES; k++) {
        const point = pointAtLength(path, (k / SAMPLES) * path.total);
        for (const [otherId, other] of routes) {
          if (otherId === id) continue;
          const points = other.points;
          for (let j = 0; j < points.length - 1; j++) {
            if (on(point, points[j]!, points[j + 1]!)) {
              marks[k] = true;
              break;
            }
          }
          if (marks[k]) break;
        }
      }
      out.set(id, marks);
    }
    return out;
  }

  /** Label window that keeps bundled labels off the shared trunk. */
  private bundleLabelRange(path: PolyPath, edgeId: string): [number, number] | undefined {
    const info = this.bundleInfo.get(edgeId);
    if (!info?.trunk) return undefined;
    const axis = info.trunk.x !== undefined ? "x" : "y";
    const shared = axis === "x" ? info.sharedY : info.sharedX;
    const points = path.points;
    const onShared = (index: number) => {
      const point = points[index];
      return !!point && Math.abs((axis === "x" ? point.y : point.x) - shared) < 0.5;
    };
    const margin = 10;
    if (info.end === "from") {
      let cut = 0;
      while (cut + 1 < points.length && onShared(cut + 1)) cut++;
      const start = (path.lengths[cut] ?? 0) + margin;
      return path.total ? [Math.min(1, start / path.total), 1] : undefined;
    }
    let cut = points.length - 1;
    while (cut - 1 >= 0 && onShared(cut - 1)) cut--;
    const end = (path.lengths[cut] ?? 0) - margin;
    return path.total ? [0, Math.max(0, end / path.total)] : undefined;
  }

  private renderEdges(): void {
    if (!this.doc || !this.viewDoc) return;
    this.computeFans();
    const { labels: obstacles, routes: routeObstacles, soft } = this.collectObstacles();

    const orthogonal = this.routeStyle === "orthogonal";
    const geos = new Map<string, EdgeGeometry>();
    const routePaths = new Map<string, PolyPath>();
    let routes: Map<string, OrthogonalRoute> | null = null;
    if (orthogonal) {
      routes = this.buildOrthogonalRoutes(routeObstacles, soft);
      for (const [id, route] of routes) routePaths.set(id, pathMetrics(route.points));
    } else {
      for (const edge of this.viewDoc.edges) {
        const geo = this.edgeGeometryOf(edge);
        if (geo) geos.set(edge.id, geo);
      }
    }
    const hops = orthogonal ? null : computeHops(this.viewDoc.edges, geos);
    const orthHops = routes ? computePolylineHops(this.viewDoc.edges, routes) : null;
    const foreign = this.foreignMarks(routePaths);

    for (const edge of this.viewDoc.edges) {
      const path = routePaths.get(edge.id);
      const geo = geos.get(edge.id);
      if (orthogonal ? !path : !geo) continue;
      const style = edgeKindStyle(edge.kind);
      const dash = edge.dash === null ? style.dash ?? "" : edge.dash ? "6 4" : "";
      const d = orthogonal
        ? polylinePath(path!.points, orthHops?.get(edge.id))
        : edgePath(geo!, hops!.get(edge.id));

      const group = el("g", { class: "bml-edge", "data-id": edge.id });
      const hit = el("path", { d, class: "bml-edge-hit" }, group);
      const line = el("path", {
        d,
        class: "bml-edge-line",
        stroke: style.color,
        "stroke-dasharray": dash || "none",
        "marker-end": `url(#bml-arrow-${edge.kind})`,
      }, group);
      this.edgeLayer.appendChild(group);

      const labelGroup = el("g", { class: "bml-edge-label-group", "data-id": edge.id });
      const labelText = edge.label ?? edge.title ?? "";
      const font = `500 10.5px ${getComputedStyle(this.root).fontFamily}`;
      const shown = truncate(labelText, font, 260);
      const width = shown ? textWidth(shown, font) : 0;
      const placed = path
        ? placeLabelOnPath(path, width, 17, obstacles, this.placedLabels, this.bundleLabelRange(path, edge.id), foreign.get(edge.id))
        : placeLabel(geo!, width, 17, obstacles, this.placedLabels);
      this.placedLabels.push(placed.rect);
      (edge as EdgeDecl & { __labelT?: number; __labelOff?: number }).__labelT = placed.t;
      (edge as EdgeDecl & { __labelOff?: number }).__labelOff = placed.offset;

      if (shown) {
        el("rect", {
          x: placed.x - width / 2 - 5, y: placed.y - 8.5, width: width + 10, height: 17, rx: 4,
          class: "bml-edge-label-bg",
        }, labelGroup);
        const text = el("text", {
          x: placed.x, y: placed.y + 3.6, "text-anchor": "middle", class: "bml-edge-label",
        }, labelGroup);
        text.textContent = shown;
      }
      this.labelLayer.appendChild(labelGroup);

      const onDown = (event: PointerEvent) => {
        if (event.button !== 0) return;
        event.stopPropagation();
        this.selectEdge(edge.id);
      };
      group.addEventListener("pointerdown", onDown);
      labelGroup.addEventListener("pointerdown", onDown);

      this.edgeEls.set(edge.id, { line, hit, labelLayer: labelGroup });
    }
  }

  private renderNodes(): void {
    if (!this.doc || !this.viewDoc) return;
    const family = getComputedStyle(this.root).fontFamily;
    for (const node of this.viewDoc.nodes) {
      const at = node.at!;
      const style = nodeKindStyle(node.kind);
      const group = el("g", {
        class: "bml-node",
        "data-id": node.id,
        transform: `translate(${at.x} ${at.y})`,
      });

      el("rect", { x: 0, y: 0, width: DEFAULT_BOX.width, height: DEFAULT_BOX.height, rx: 10, class: "bml-node-box" }, group);
      el("rect", { x: 0, y: 12, width: 3.5, height: DEFAULT_BOX.height - 24, rx: 2, fill: style.color }, group);

      const label = nodeDisplayName(node);
      const titleFont = `600 13px ${family}`;
      const title = el("text", { x: 16, y: 27, class: "bml-node-title" }, group);
      title.textContent = truncate(label, titleFont, 166);
      const tech = el("text", { x: 16, y: 45, class: "bml-node-tech" }, group);
      tech.textContent = truncate(node.tech ?? "", `400 10.5px ${family}`, 166);

      group.addEventListener("pointerdown", (event) => this.startNodeDrag(event, node));
      group.addEventListener("pointerenter", () => {
        this.hoveredNode = node.id;
        this.applyFocus();
      });
      group.addEventListener("pointerleave", () => {
        if (this.hoveredNode === node.id) {
          this.hoveredNode = null;
          this.applyFocus();
        }
      });
      group.addEventListener("click", (event) => {
        if (this.suppressClick) { this.suppressClick = false; this.pointerSelected = false; return; }
        if (this.pointerSelected) { this.pointerSelected = false; return; }
        this.selectNode(node.id, event.shiftKey || event.ctrlKey || event.metaKey);
      });

      this.nodeLayer.appendChild(group);
      this.nodeEls.set(node.id, group);
    }
  }

  private renderLegend(): void {
    if (this.options.showLegend === false || !this.viewDoc) {
      this.legend.style.display = "none";
      return;
    }
    const seen = new Set<string>();
    for (const node of this.viewDoc.nodes) seen.add(node.kind);
    const items = [...seen].map((kind) => {
      const style = nodeKindStyle(kind);
      return `<span class="bml-item"><span class="bml-swatch" style="background:${style.color}"></span>${escape(style.label)}</span>`;
    });
    this.legend.innerHTML = `<b>图例</b>${items.join("")}`;
  }

  /* --------------------------------------------------------- interaction */

  private applyView(): void {
    this.viewport.setAttribute(
      "transform",
      `translate(${this.view.x.toFixed(2)} ${this.view.y.toFixed(2)}) scale(${this.view.k.toFixed(4)})`,
    );
  }

  private toWorld(clientX: number, clientY: number): Point {
    const rect = this.svg.getBoundingClientRect();
    return {
      x: (clientX - rect.left - this.view.x) / this.view.k,
      y: (clientY - rect.top - this.view.y) / this.view.k,
    };
  }

  fit(): void {
    if (!this.doc || !this.viewDoc) return;
    const rect = this.svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const bounds = this.viewBounds();
    const pad = 56;
    // Keep the drawing clear of the floating layers panel while it is open.
    const inset = this.layersOpen ? 296 : 0;
    const width = Math.max(1, rect.width - inset);
    const k = clamp(Math.min((width - pad * 2) / Math.max(bounds.w, 1),
                             (rect.height - pad * 2) / Math.max(bounds.h, 1)), 0.15, 1.2);
    this.view = {
      k,
      x: inset + (width - bounds.w * k) / 2 - bounds.x * k,
      y: (rect.height - bounds.h * k) / 2 - bounds.y * k,
    };
    this.applyView();
  }

  zoomTo(scale: number): void {
    const rect = this.svg.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const k = clamp(scale, 0.15, 3);
    this.view.x = cx - (cx - this.view.x) * (k / this.view.k);
    this.view.y = cy - (cy - this.view.y) * (k / this.view.k);
    this.view.k = k;
    this.applyView();
  }

  private bindCanvas(): void {
    let pan: { sx: number; sy: number; vx: number; vy: number } | null = null;

    this.svg.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const target = event.target as Element;
      if (target.closest(".bml-node") || target.closest(".bml-edge")) return;
      this.selectNode(null);
      this.selectEdge(null);
      pan = { sx: event.clientX, sy: event.clientY, vx: this.view.x, vy: this.view.y };
      this.svg.style.cursor = "grabbing";
    });

    window.addEventListener("pointermove", (event) => {
      if (!pan) return;
      this.view.x = pan.vx + (event.clientX - pan.sx);
      this.view.y = pan.vy + (event.clientY - pan.sy);
      this.applyView();
    });

    window.addEventListener("pointerup", () => {
      if (pan) { pan = null; this.svg.style.cursor = "default"; }
    });

    this.svg.addEventListener("wheel", (event) => {
      event.preventDefault();
      const rect = this.svg.getBoundingClientRect();
      const sx = event.clientX - rect.left;
      const sy = event.clientY - rect.top;
      const k = clamp(this.view.k * Math.exp(-event.deltaY * 0.0016), 0.15, 3);
      this.view.x = sx - (sx - this.view.x) * (k / this.view.k);
      this.view.y = sy - (sy - this.view.y) * (k / this.view.k);
      this.view.k = k;
      this.applyView();
    }, { passive: false });

    window.addEventListener("keydown", this.onKeyDown);
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      if (this.layersOpen) this.toggleLayers(false);
      this.selectNode(null);
      this.selectEdge(null);
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "0") {
      event.preventDefault();
      this.fit();
    }
  };

  private startNodeDrag(event: PointerEvent, node: NodeDecl): void {
    if (event.button !== 0) return;
    if (this.options.readOnly) return;
    event.stopPropagation();

    const additive = event.shiftKey || event.ctrlKey || event.metaKey;
    if (!this.selectedNodes.has(node.id)) {
      this.selectNode(node.id, additive);
      this.pointerSelected = true;
    } else if (!additive && this.selectedNodes.size > 1) {
      // Keep the multi-selection so the whole group can be dragged at once.
      this.selectedNode = node.id;
      this.selectedEdge = null;
      this.applySelection();
    }

    const start = this.toWorld(event.clientX, event.clientY);
    const moving = this.viewDoc?.nodes.filter((n) => this.selectedNodes.has(n.id) && n.at) ?? [];
    if (!moving.length) return;
    const origins = new Map(moving.map((n) => [n.id, { x: n.at!.x, y: n.at!.y }]));
    const affected = this.viewDoc?.edges.filter(
      (e) => this.selectedNodes.has(e.from) || this.selectedNodes.has(e.to),
    ) ?? [];
    let moved = false;
    for (const n of moving) this.nodeEls.get(n.id)?.classList.add("bml-dragging");

    const onMove = (e: PointerEvent) => {
      const p = this.toWorld(e.clientX, e.clientY);
      const dx = Math.round(p.x - start.x);
      const dy = Math.round(p.y - start.y);
      if (!dx && !dy) return;
      for (const n of moving) {
        const origin = origins.get(n.id)!;
        const x = origin.x + dx;
        const y = origin.y + dy;
        if (n.at!.x === x && n.at!.y === y) continue;
        n.at = { x, y };
        moved = true;
        this.nodeEls.get(n.id)?.setAttribute("transform", `translate(${x} ${y})`);
      }
      if (!moved) return;
      if (this.routeStyle === "orthogonal") {
        this.refreshEdgePaths();
      } else {
        for (const edge of affected) this.refreshEdge(edge);
        this.refreshEdgePaths();
      }
      this.refreshGroups();
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      for (const n of moving) this.nodeEls.get(n.id)?.classList.remove("bml-dragging");
      if (!moved) return;
      this.suppressClick = true;
      setTimeout(() => { this.suppressClick = false; }, 250);
      this.commit({ nodes: new Map(moving.map((n) => [n.id, n.at!])) });
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  private startBendDrag(event: PointerEvent, edge: EdgeDecl): void {
    if (event.button !== 0 || this.options.readOnly) return;
    if (this.routeStyle === "orthogonal") return;
    event.stopPropagation();
    const start = this.toWorld(event.clientX, event.clientY);
    const base = edge.via ?? { x: 0, y: 0 };
    const origin = { ...base };

    const onMove = (e: PointerEvent) => {
      const p = this.toWorld(e.clientX, e.clientY);
      edge.via = {
        x: Math.round(origin.x + (p.x - start.x)),
        y: Math.round(origin.y + (p.y - start.y)),
      };
      this.refreshEdge(edge);
      this.refreshEdgePaths();
      this.refreshBendHandle();
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (!edge.via) return;
      this.commit({ edges: new Map([[edge.id, edge.via]]) });
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  /** Rebuild every edge path; hops depend on where edges cross each other. */
  private refreshEdgePaths(): void {
    if (!this.viewDoc) return;
    if (this.routeStyle === "orthogonal") {
      const obstacles = this.collectObstacles();
      const routes = this.buildOrthogonalRoutes(obstacles.routes, obstacles.soft);
      const hops = computePolylineHops(this.viewDoc.edges, routes);
      for (const edge of this.viewDoc.edges) {
        const els = this.edgeEls.get(edge.id);
        const route = routes.get(edge.id);
        if (!els || !route) continue;
        const d = polylinePath(route.points, hops.get(edge.id));
        els.line.setAttribute("d", d);
        els.hit.setAttribute("d", d);
        this.placeEdgeLabel(edge, pathMetrics(route.points));
      }
      return;
    }
    const geos = new Map<string, EdgeGeometry>();
    for (const edge of this.viewDoc.edges) {
      const geo = this.edgeGeometryOf(edge);
      if (geo) geos.set(edge.id, geo);
    }
    const hops = computeHops(this.viewDoc.edges, geos);
    for (const edge of this.viewDoc.edges) {
      const els = this.edgeEls.get(edge.id);
      const geo = geos.get(edge.id);
      if (!els || !geo) continue;
      const d = edgePath(geo, hops.get(edge.id));
      els.line.setAttribute("d", d);
      els.hit.setAttribute("d", d);
    }
  }

  private placeEdgeLabel(edge: EdgeDecl, path: PolyPath): void {
    const els = this.edgeEls.get(edge.id);
    if (!els) return;
    const family = getComputedStyle(this.root).fontFamily;
    const font = `500 10.5px ${family}`;
    const text = truncate(edge.label ?? edge.title ?? "", font, 260);
    if (!text) return;
    const width = textWidth(text, font);
    const t = (edge as EdgeDecl & { __labelT?: number }).__labelT ?? 0.5;
    const off = (edge as EdgeDecl & { __labelOff?: number }).__labelOff ?? 0;
    const point = pointAtLength(path, t * path.total);
    const bg = els.labelLayer.querySelector(".bml-edge-label-bg");
    const label = els.labelLayer.querySelector(".bml-edge-label");
    if (bg) {
      bg.setAttribute("x", String(point.x - width / 2 - 5));
      bg.setAttribute("y", String(point.y + off - 8.5));
    }
    if (label) {
      label.setAttribute("x", String(point.x));
      label.setAttribute("y", String(point.y + off + 3.6));
    }
  }

  private refreshEdge(edge: EdgeDecl): void {
    const els = this.edgeEls.get(edge.id);
    const geo = this.edgeGeometryOf(edge);
    if (!els || !geo) return;
    const d = pathOf(geo);
    els.line.setAttribute("d", d);
    els.hit.setAttribute("d", d);
    const family = getComputedStyle(this.root).fontFamily;
    const font = `500 10.5px ${family}`;
    const text = truncate(edge.label ?? edge.title ?? "", font, 260);
    if (!text) return;
    const width = textWidth(text, font);
    const t = (edge as EdgeDecl & { __labelT?: number }).__labelT ?? 0.5;
    const off = (edge as EdgeDecl & { __labelOff?: number }).__labelOff ?? 0;
    const point = bezierAt(geo.p1, geo.control, geo.p2, t);
    const bg = els.labelLayer.querySelector(".bml-edge-label-bg");
    const label = els.labelLayer.querySelector(".bml-edge-label");
    if (bg) {
      bg.setAttribute("x", String(point.x - width / 2 - 5));
      bg.setAttribute("y", String(point.y + off - 8.5));
    }
    if (label) {
      label.setAttribute("x", String(point.x));
      label.setAttribute("y", String(point.y + off + 3.6));
    }
  }

  private refreshGroups(): void {
    if (!this.doc || !this.viewDoc) return;
    const visibility = this.visibility();
    for (const group of this.viewDoc.groups) {
      const els = this.groupEls.get(group.id);
      if (!els) continue;
      const members = this.doc.nodes.filter((n) => n.group === group.id);
      const full = groupBoundingBox(members);
      if (!full) continue;
      const collapsed = this.collapsedGroups.has(group.id);
      const box = collapsed
        ? this.collapseChip(full)
        : groupBoundingBox(members.filter((node) => isNodeVisible(node, visibility)));
      if (!box) continue;
      els.rect.setAttribute("x", String(box.x));
      els.rect.setAttribute("y", String(box.y));
      els.rect.setAttribute("width", String(box.w));
      els.rect.setAttribute("height", String(box.h));
      els.text.setAttribute("x", String(box.x + 16));
      els.text.setAttribute("y", String(box.y + (collapsed ? 24 : 21)));
      els.toggle.setAttribute(
        "transform",
        `translate(${box.x + box.w - 16} ${box.y + (collapsed ? 20 : 19)})`,
      );
    }
  }

  /* ------------------------------------------------------------ mutation */

  private commit(patch: { nodes?: Map<string, Point>; edges?: Map<string, Point> }): void {
    if (!this.doc) return;
    const next = applyLayout(this.source, this.doc, patch);
    if (next === this.source) return;
    this.source = next;
    this.options.onSourceChange?.(next);
    const selection = {
      node: this.selectedNode,
      nodes: new Set(this.selectedNodes),
      edge: this.selectedEdge,
    };
    this.parse(this.source);
    this.render();
    this.selectedNode = selection.node;
    this.selectedNodes = selection.nodes;
    this.selectedEdge = selection.edge;
    this.applySelection();
    this.refreshBendHandle();
  }

  /* ------------------------------------------------------------ selection */

  private selectNode(id: string | null, additive = false): void {
    if (id === null) {
      this.selectedNodes.clear();
      this.selectedNode = null;
      this.applySelection();
      if (!this.selectedEdge) this.closeInspector();
      return;
    }
    this.selectedEdge = null;
    if (additive) {
      if (this.selectedNodes.has(id)) {
        this.selectedNodes.delete(id);
        this.selectedNode = this.selectedNodes.values().next().value ?? null;
      } else {
        this.selectedNodes.add(id);
        this.selectedNode = id;
      }
    } else {
      this.selectedNodes = new Set([id]);
      this.selectedNode = id;
    }
    this.applySelection();
    if (this.selectedNode) this.openNodeInspector(this.selectedNode);
    else this.closeInspector();
  }

  private selectEdge(id: string | null): void {
    this.selectedEdge = id;
    if (id) {
      this.selectedNode = null;
      this.selectedNodes.clear();
    }
    this.applySelection();
    if (id) this.openEdgeInspector(id);
    else this.closeInspector();
  }

  private applySelection(): void {
    for (const [id, node] of this.nodeEls) {
      node.classList.toggle("bml-selected", this.selectedNodes.has(id));
    }
    for (const [id, edge] of this.edgeEls) {
      edge.line.parentElement?.classList.toggle("bml-selected", id === this.selectedEdge);
      edge.labelLayer.classList.toggle("bml-selected", id === this.selectedEdge);
    }
    this.applyFocus();
    this.refreshBendHandle();
  }

  /** Dim everything that is not on the hovered/selected node. */
  private applyFocus(): void {
    const focus = this.selectedNode ?? this.hoveredNode;
    const edges = this.viewDoc ? relatedEdges(this.viewDoc, focus) : new Set<string>();
    const nodes = this.viewDoc ? relatedNodes(this.viewDoc, focus) : new Set<string>();
    this.root.classList.toggle("bml-focusing", Boolean(focus));
    for (const [id, els] of this.edgeEls) {
      const related = edges.has(id);
      els.line.parentElement?.classList.toggle("bml-related", related);
      els.labelLayer.classList.toggle("bml-related", related);
    }
    for (const [id, el] of this.nodeEls) {
      el.classList.toggle("bml-focus-node", nodes.has(id));
    }
  }

  private refreshBendHandle(): void {
    this.overlayLayer.innerHTML = "";
    if (this.routeStyle === "orthogonal" || !this.selectedEdge || !this.doc) return;
    const edge = this.doc.edges.find((e) => e.id === this.selectedEdge);
    if (!edge) return;
    const geo = this.edgeGeometryOf(edge);
    if (!geo) return;
    el("path", {
      d: `M ${geo.mid.x} ${geo.mid.y} L ${geo.control.x} ${geo.control.y}`,
      class: "bml-bend-line",
    }, this.overlayLayer);
    const handle = el("circle", {
      cx: geo.control.x, cy: geo.control.y, r: 6.5, class: "bml-bend-handle",
    }, this.overlayLayer);
    handle.addEventListener("pointerdown", (event) => this.startBendDrag(event, edge));
  }

  private openNodeInspector(id: string): void {
    if (!this.doc || this.options.showInspector === false) return;
    const node = this.doc.nodes.find((n) => n.id === id);
    if (!node) return;
    const style = nodeKindStyle(node.kind);
    const sections: string[] = [];
    if (node.note) sections.push(`<h3>说明</h3><p>${escape(node.note)}</p>`);
    if (node.src) sections.push(`<h3>出处</h3><p><code>${escape(node.src)}</code></p>`);

    const outgoing = this.doc.edges.filter((e) => e.from === id);
    const incoming = this.doc.edges.filter((e) => e.to === id);
    const line = (arrow: string, title: string, label: string) =>
      `<div class="bml-edge-item"><span class="bml-arrow">${arrow}</span><div><div class="bml-t">${escape(title)}</div><div class="bml-l">${escape(label)}</div></div></div>`;
    if (outgoing.length) {
      sections.push(`<h3>出边 ${outgoing.length}</h3>`);
      sections.push(...outgoing.map((e) => {
        const target = this.doc!.nodes.find((n) => n.id === e.to);
        return line("→", target ? nodeDisplayName(target) : e.to, edgeDisplayName(e));
      }));
    }
    if (incoming.length) {
      sections.push(`<h3>入边 ${incoming.length}</h3>`);
      sections.push(...incoming.map((e) => {
        const source = this.doc!.nodes.find((n) => n.id === e.from);
        return line("←", source ? nodeDisplayName(source) : e.from, edgeDisplayName(e));
      }));
    }
    if (!sections.length) sections.push(`<p>这个节点还没有 note / src。</p>`);

    this.inspector.innerHTML = `
      <div class="bml-inspector-head">
        <span class="bml-kind-dot" style="background:${style.color}"></span>
        <div style="min-width:0">
          <h2>${escape(nodeDisplayName(node))}</h2>
          <div class="bml-inspector-meta">${escape(node.id)} · ${escape(style.label)}</div>
        </div>
        <button class="bml-close" data-bml-close>×</button>
      </div>
      <div class="bml-inspector-body">${sections.join("")}</div>`;
    this.bindInspectorClose();
    this.inspector.classList.add("bml-open");
  }

  private openEdgeInspector(id: string): void {
    if (!this.doc || this.options.showInspector === false) return;
    const edge = this.doc.edges.find((e) => e.id === id);
    if (!edge) return;
    const style = edgeKindStyle(edge.kind);
    const from = this.doc.nodes.find((n) => n.id === edge.from);
    const to = this.doc.nodes.find((n) => n.id === edge.to);
    const sections: string[] = [];
    if (edge.note) sections.push(`<h3>说明</h3><p>${escape(edge.note)}</p>`);
    if (edge.src) sections.push(`<h3>出处</h3><p><code>${escape(edge.src)}</code></p>`);
    if (!this.options.readOnly) {
      sections.push(
        this.routeStyle === "orthogonal"
          ? `<h3>走线</h3><p>正交布线由节点位置自动生成（直角折线），拖动节点即可调整。</p>`
          : `<h3>调整走线</h3><p>拖动画布上的圆点改变曲率，坐标会写回文件里的 <code>via</code>。</p>`,
      );
    }

    this.inspector.innerHTML = `
      <div class="bml-inspector-head">
        <span class="bml-kind-dot" style="background:${style.color}"></span>
        <div style="min-width:0">
          <h2>${escape(edgeDisplayName(edge))}</h2>
          <div class="bml-inspector-meta">${escape(from ? nodeDisplayName(from) : edge.from)} → ${escape(to ? nodeDisplayName(to) : edge.to)} · ${escape(style.label)}</div>
        </div>
        <button class="bml-close" data-bml-close>×</button>
      </div>
      <div class="bml-inspector-body">${sections.join("")}</div>`;
    this.bindInspectorClose();
    this.inspector.classList.add("bml-open");
  }

  private bindInspectorClose(): void {
    this.inspector.querySelector("[data-bml-close]")?.addEventListener("click", () => {
      this.selectNode(null);
      this.selectEdge(null);
    });
  }

  private closeInspector(): void {
    this.inspector.classList.remove("bml-open");
  }

  /* ---------------------------------------------------------------- api */

  layout(algorithm: LayoutAlgorithm): void {
    if (!this.doc) return;
    const positions = layoutDocument(this.doc, algorithm);
    for (const node of this.doc.nodes) {
      const point = positions.get(node.id);
      if (point) node.at = point;
    }
    this.commit({ nodes: positions });
    this.fit();
  }

  /* ----------------------------------------------------------- visibility */

  toggleLayers(open: boolean = !this.layersOpen): void {
    this.layersOpen = open;
    this.layersPanel.classList.toggle("bml-open", open);
    if (open) this.renderLayersPanel();
  }

  toggleGroupCollapsed(id: string): void {
    if (!this.doc?.groups.some((group) => group.id === id)) return;
    if (this.collapsedGroups.has(id)) this.collapsedGroups.delete(id);
    else this.collapsedGroups.add(id);
    this.afterVisibilityChange();
  }

  setHiddenNodes(ids: string[]): void {
    this.hiddenNodes = new Set(ids);
    this.afterVisibilityChange();
  }

  setHiddenGroups(ids: string[]): void {
    this.hiddenGroups = new Set(ids);
    this.afterVisibilityChange();
  }

  setCollapsedGroups(ids: string[]): void {
    this.collapsedGroups = new Set(ids);
    this.afterVisibilityChange();
  }

  showAll(): void {
    if (!this.hiddenNodes.size && !this.hiddenGroups.size && !this.collapsedGroups.size) return;
    this.hiddenNodes.clear();
    this.hiddenGroups.clear();
    this.collapsedGroups.clear();
    this.afterVisibilityChange();
  }

  getVisibility(): ViewerVisibility {
    return {
      hiddenNodes: [...this.hiddenNodes],
      hiddenGroups: [...this.hiddenGroups],
      collapsedGroups: [...this.collapsedGroups],
    };
  }

  private afterVisibilityChange(): void {
    this.rebuildView();
    this.syncSelectionToView();
    this.render();
    this.options.onVisibilityChange?.(this.getVisibility());
  }

  /** Drop selections that just became invisible; they must not linger off-canvas. */
  private syncSelectionToView(): void {
    const nodeIds = new Set(this.viewDoc?.nodes.map((node) => node.id) ?? []);
    const edgeIds = new Set(this.viewDoc?.edges.map((edge) => edge.id) ?? []);
    if (this.hoveredNode && !nodeIds.has(this.hoveredNode)) this.hoveredNode = null;
    for (const id of [...this.selectedNodes]) {
      if (!nodeIds.has(id)) this.selectedNodes.delete(id);
    }
    if (this.selectedNode && !nodeIds.has(this.selectedNode)) {
      this.selectedNode = null;
      this.closeInspector();
    }
    if (this.selectedEdge && !edgeIds.has(this.selectedEdge)) {
      this.selectedEdge = null;
      this.closeInspector();
    }
  }

  private bindLayersPanel(): void {
    this.layersPanel.addEventListener("change", (event) => {
      const input = event.target as HTMLInputElement;
      if (input.tagName !== "INPUT") return;
      const groupId = input.dataset.group;
      if (groupId !== undefined) {
        if (input.checked) this.hiddenGroups.delete(groupId);
        else this.hiddenGroups.add(groupId);
        this.afterVisibilityChange();
        return;
      }
      const nodeId = input.dataset.node;
      if (nodeId === undefined) return;
      if (input.checked) this.hiddenNodes.delete(nodeId);
      else this.hiddenNodes.add(nodeId);
      this.afterVisibilityChange();
    });

    this.layersPanel.addEventListener("click", (event) => {
      const button = (event.target as Element).closest("button");
      if (!button) return;
      const fold = button.dataset.fold;
      if (fold !== undefined) {
        this.toggleGroupCollapsed(fold);
        return;
      }
      if (button.dataset.showAll !== undefined) {
        this.showAll();
        return;
      }
      if (button.dataset.layersClose !== undefined) this.toggleLayers(false);
    });
  }

  private renderLayersPanel(): void {
    if (!this.layersOpen) return;
    if (!this.doc || !this.viewDoc) {
      this.layersPanel.innerHTML = "";
      return;
    }
    const visibility = this.visibility();
    const known = new Set(this.doc.groups.map((group) => group.id));
    const blocks: string[] = [];

    for (const group of this.doc.groups) {
      const members = this.doc.nodes.filter((node) => node.group === group.id);
      const collapsed = this.collapsedGroups.has(group.id);
      const hidden = this.hiddenGroups.has(group.id);
      const label = escape(group.label ?? group.title);
      const rows = members.map((node) => this.layerNodeRow(node, visibility)).join("");
      blocks.push(`
        <div class="bml-layer-group">
          <div class="bml-layer-row${hidden ? " bml-muted" : ""}">
            <label class="bml-layer-check">
              <input type="checkbox" data-group="${escape(group.id)}"${hidden ? "" : " checked"}>
              <span class="bml-layer-name">${label}</span>
            </label>
            <span class="bml-layer-count">${members.length}</span>
            <button class="bml-layer-fold" data-fold="${escape(group.id)}" title="折叠组成员，只留组框">${collapsed ? "展开" : "折叠"}</button>
          </div>
          ${rows}
        </div>`);
    }

    const loose = this.doc.nodes.filter((node) => !node.group || !known.has(node.group));
    if (loose.length) {
      blocks.push(`
        <div class="bml-layer-group">
          <div class="bml-layer-row">
            <span class="bml-layer-name">未分组</span>
            <span class="bml-layer-count">${loose.length}</span>
          </div>
          ${loose.map((node) => this.layerNodeRow(node, visibility)).join("")}
        </div>`);
    }

    this.layersPanel.innerHTML = `
      <div class="bml-layers-head">
        <b>图层</b>
        <span class="bml-layers-meta">仅影响视图</span>
        <button class="bml-close" data-layers-close title="关闭">×</button>
      </div>
      <div class="bml-layers-body">${blocks.join("")}</div>
      <div class="bml-layers-foot">
        <span>不写回源码</span>
        <button data-show-all>全部显示</button>
      </div>`;
  }

  private layerNodeRow(node: NodeDecl, visibility: Visibility): string {
    const hidden = this.hiddenNodes.has(node.id);
    // Muted marks a node that is hidden indirectly (its group is hidden or collapsed).
    const muted = !hidden && !isNodeVisible(node, visibility);
    return `
      <label class="bml-layer-row bml-layer-node${muted ? " bml-muted" : ""}">
        <input type="checkbox" data-node="${escape(node.id)}"${hidden ? "" : " checked"}>
        <span class="bml-layer-name">${escape(nodeDisplayName(node))}</span>
      </label>`;
  }

  update(source: string): void {
    this.source = source;
    this.parse(source);
    this.render();
    if (!this.fitted) {
      this.fitted = true;
      requestAnimationFrame(() => this.fit());
    }
  }

  getSource(): string {
    return this.source;
  }

  setReadOnly(readOnly: boolean): void {
    this.options.readOnly = readOnly;
    this.root.classList.toggle("bml-readonly", readOnly);
  }

  toSVG(): string {
    const clone = this.svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("xmlns", SVGNS);
    clone.querySelector(".bml-overlay")?.remove();
    clone.querySelector(".bml-ui")?.remove();
    clone.querySelector(".bml-groups > rect[fill^='url']")?.remove();
    // 交互件与临时态不属于图本身
    clone.querySelectorAll(".bml-group-toggle, .bml-bend-handle, .bml-bend-line, .bml-edge-hit").forEach((el) => el.remove());
    clone.querySelectorAll(".bml-selected, .bml-dragging, .bml-related, .bml-focus-node").forEach((el) => {
      el.classList.remove("bml-selected", "bml-dragging", "bml-related", "bml-focus-node");
    });

    // 导出与屏幕同源：沿用 VIEWER_CSS，并把主题变量解析成具体值挂到 <svg> 上，
    // 否则 var(--bml-*) 未定义会让底色、标签底板等退回默认黑色。
    const computed = getComputedStyle(this.root);
    const vars = [
      "--bml-bg",
      "--bml-panel",
      "--bml-ink",
      "--bml-ink-2",
      "--bml-ink-3",
      "--bml-line",
      "--bml-accent",
      "--bml-grid",
      "--bml-label-bg",
    ];
    const declared = vars.map((name) => `${name}:${computed.getPropertyValue(name).trim()}`).join(";");
    clone.setAttribute("style", `${declared};font-family:${computed.fontFamily}`);

    if (this.doc && this.viewDoc) {
      const bounds = this.viewBounds();
      const pad = 40;
      const width = Math.ceil(bounds.w + pad * 2);
      const height = Math.ceil(bounds.h + pad * 2);
      clone.setAttribute("viewBox", `${bounds.x - pad} ${bounds.y - pad} ${bounds.w + pad * 2} ${bounds.h + pad * 2}`);
      clone.setAttribute("width", String(width));
      clone.setAttribute("height", String(height));

      const paper = document.createElementNS(SVGNS, "rect");
      paper.setAttribute("x", String(bounds.x - pad));
      paper.setAttribute("y", String(bounds.y - pad));
      paper.setAttribute("width", String(bounds.w + pad * 2));
      paper.setAttribute("height", String(bounds.h + pad * 2));
      paper.setAttribute("fill", computed.getPropertyValue("--bml-bg").trim());
      clone.insertBefore(paper, clone.firstChild);
    }
    clone.querySelector(".bml-viewport")?.removeAttribute("transform");

    // 深色主题下两条按 .bml-root[data-bml-theme] 生效的规则，导出克隆里没有 .bml-root，补回来。
    const darkRules =
      this.root.dataset.bmlTheme === "dark"
        ? ".bml-node-box{stroke:#243146}.bml-edge-label{fill:#93a3b8}"
        : "";

    const style = document.createElementNS(SVGNS, "style");
    style.textContent = `${VIEWER_CSS}\n${darkRules}`;
    clone.insertBefore(style, clone.firstChild);

    return new XMLSerializer().serializeToString(clone);
  }

  getView(): { x: number; y: number; k: number } {
    return { ...this.view };
  }

  getDocument(): BlockDocument | null {
    return this.doc;
  }

  getDiagnostics(): Diagnostic[] {
    return this.diagnostics;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    window.removeEventListener("keydown", this.onKeyDown);
    this.root.remove();
  }
}

/* --------------------------------------------------------------- helpers */

interface PlacedLabel {
  x: number;
  y: number;
  t: number;
  offset: number;
  rect: Rect;
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
  for (const o of obstacles) penalty += rectOverlapArea(rect, o, 1) * 4;
  for (const o of placed) penalty += rectOverlapArea(rect, o, 4);
  return penalty;
}

function placeLabel(
  geo: EdgeGeometry,
  width: number,
  height: number,
  obstacles: Rect[],
  placed: Rect[],
): PlacedLabel {
  const ts = [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74, 0.18, 0.82];
  const offsets = [0, -15, 15, -30, 30, -46, 46, -64, 64];
  let best: PlacedLabel | null = null;
  let bestPenalty = Infinity;
  for (const offset of offsets) {
    for (const t of ts) {
      const point = bezierAt(geo.p1, geo.control, geo.p2, t);
      const rect: Rect = { x: point.x - width / 2 - 5, y: point.y - height / 2 + offset, w: width + 10, h: height };
      const penalty = labelPenalty(rect, obstacles, placed);
      if (penalty === 0) return { x: point.x, y: point.y + offset, t, offset, rect };
      if (penalty < bestPenalty) {
        bestPenalty = penalty;
        best = { x: point.x, y: point.y + offset, t, offset, rect };
      }
    }
  }
  if (best) return best;
  const point = bezierAt(geo.p1, geo.control, geo.p2, 0.5);
  return {
    x: point.x,
    y: point.y,
    t: 0.5,
    offset: 0,
    rect: { x: point.x - width / 2 - 5, y: point.y - height / 2, w: width + 10, h: height },
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/* ------------------------------------------------------------ wire hops */

const HOP_RADIUS = 9;
const HOP_MIN_T = 0.05;
const HOP_MAX_T = 0.95;

function splitQuad(
  p1: Point,
  c: Point,
  p2: Point,
  t: number,
): { left: [Point, Point, Point]; right: [Point, Point, Point] } {
  const lerp = (a: Point, b: Point): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const p01 = lerp(p1, c);
  const p12 = lerp(c, p2);
  const p012 = lerp(p01, p12);
  return { left: [p1, p01, p012], right: [p012, p12, p2] };
}

/** Sub-curve of a quadratic between parameters t0 and t1. */
function subQuad(p1: Point, c: Point, p2: Point, t0: number, t1: number): [Point, Point, Point] {
  const { left } = splitQuad(p1, c, p2, t1);
  const k = t1 <= 0 ? 0 : t0 / t1;
  const { right } = splitQuad(left[0], left[1], left[2], k);
  return right;
}

function quadSpeed(geo: EdgeGeometry, t: number): number {
  const dx = 2 * (1 - t) * (geo.control.x - geo.p1.x) + 2 * t * (geo.p2.x - geo.control.x);
  const dy = 2 * (1 - t) * (geo.control.y - geo.p1.y) + 2 * t * (geo.p2.y - geo.control.y);
  return Math.hypot(dx, dy);
}

interface EdgeSamples {
  points: Point[];
  box: Rect;
}

function sampleEdge(geo: EdgeGeometry, steps = 40): EdgeSamples {
  const points: Point[] = [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i <= steps; i++) {
    const p = bezierAt(geo.p1, geo.control, geo.p2, i / steps);
    points.push(p);
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  return { points, box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } };
}

function segmentHit(a1: Point, a2: Point, b1: Point, b2: Point): number | null {
  const ax = a2.x - a1.x, ay = a2.y - a1.y;
  const bx = b2.x - b1.x, by = b2.y - b1.y;
  const denom = ax * by - ay * bx;
  if (Math.abs(denom) < 1e-9) return null;
  const ox = b1.x - a1.x, oy = b1.y - a1.y;
  const ua = (ox * by - oy * bx) / denom;
  const ub = (ox * ay - oy * ax) / denom;
  if (ua <= 0 || ua >= 1 || ub <= 0 || ub >= 1) return null;
  return ub;
}

/**
 * For every crossing between two edges, the edge drawn later (the one on top)
 * gets a hop. Returns hop parameters per edge id.
 */
function computeHops(edges: EdgeDecl[], geos: Map<string, EdgeGeometry>): Map<string, number[]> {
  const samples = new Map<string, EdgeSamples>();
  for (const edge of edges) {
    const geo = geos.get(edge.id);
    if (geo) samples.set(edge.id, sampleEdge(geo));
  }
  const hops = new Map<string, number[]>();
  for (let i = 0; i < edges.length; i++) {
    const first = edges[i]!;
    const a = samples.get(first.id);
    if (!a) continue;
    for (let j = i + 1; j < edges.length; j++) {
      const second = edges[j]!;
      const b = samples.get(second.id);
      if (!b) continue;
      if (
        a.box.x + a.box.w < b.box.x || b.box.x + b.box.w < a.box.x ||
        a.box.y + a.box.h < b.box.y || b.box.y + b.box.h < a.box.y
      ) continue;
      const shares =
        first.from === second.from || first.from === second.to ||
        first.to === second.from || first.to === second.to;
      const found: number[] = [];
      for (let s = 0; s < a.points.length - 1; s++) {
        for (let k = 0; k < b.points.length - 1; k++) {
          const ub = segmentHit(a.points[s]!, a.points[s + 1]!, b.points[k]!, b.points[k + 1]!);
          if (ub === null) continue;
          const t = (k + ub) / (b.points.length - 1);
          if (shares && (t < 0.12 || t > 0.88)) continue;
          found.push(t);
        }
      }
      if (found.length) hops.set(second.id, [...(hops.get(second.id) ?? []), ...found]);
    }
  }
  return hops;
}

/** Edge path with a small arc where this (top) edge crosses another one. */
function edgePath(geo: EdgeGeometry, hops?: number[]): string {
  if (!hops?.length) return pathOf(geo);
  const usable: number[] = [];
  for (const t of [...hops].sort((a, b) => a - b)) {
    if (t < HOP_MIN_T || t > HOP_MAX_T) continue;
    const p = bezierAt(geo.p1, geo.control, geo.p2, t);
    if (Math.hypot(p.x - geo.p1.x, p.y - geo.p1.y) < 22) continue;
    if (Math.hypot(p.x - geo.p2.x, p.y - geo.p2.y) < 22) continue;
    if (usable.length) {
      const prev = bezierAt(geo.p1, geo.control, geo.p2, usable[usable.length - 1]!);
      if (Math.hypot(p.x - prev.x, p.y - prev.y) < 18) continue;
    }
    usable.push(t);
  }
  if (!usable.length) return pathOf(geo);

  const f = (n: number) => Number(n.toFixed(2));
  const pointAt = (t: number) => bezierAt(geo.p1, geo.control, geo.p2, t);
  let d = "";
  let cursor = 0;
  for (const t of usable) {
    const half = Math.min(0.06, 7 / Math.max(quadSpeed(geo, t), 0.001));
    const t0 = Math.max(cursor, t - half);
    const t1 = Math.min(1, t + half);
    if (t1 - t0 < 0.004) continue;
    const [s0, s1, s2] = subQuad(geo.p1, geo.control, geo.p2, cursor, t0);
    d += d
      ? ` Q ${f(s1.x)} ${f(s1.y)} ${f(s2.x)} ${f(s2.y)}`
      : `M ${f(s0.x)} ${f(s0.y)} Q ${f(s1.x)} ${f(s1.y)} ${f(s2.x)} ${f(s2.y)}`;
    const b = pointAt(t1);
    d += ` A ${HOP_RADIUS} ${HOP_RADIUS} 0 0 1 ${f(b.x)} ${f(b.y)}`;
    cursor = t1;
  }
  const [, e1, e2] = subQuad(geo.p1, geo.control, geo.p2, cursor, 1);
  return `${d} Q ${f(e1.x)} ${f(e1.y)} ${f(e2.x)} ${f(e2.y)}`;
}

/* --------------------------------------------------- orthogonal polylines */

interface PolyPath {
  points: Point[];
  lengths: number[];
  total: number;
}

function pathMetrics(points: Point[]): PolyPath {
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

function pointAtLength(path: PolyPath, distance: number): Point {
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

const CORNER_RADIUS = 12;

function polylinePath(points: Point[], hops?: number[]): string {
  const f = (n: number) => Number(n.toFixed(2));
  if (points.length < 2) return "";
  const path = pathMetrics(points);
  // Round each bend; a corner never eats more than half of either neighbour, so
  // narrow lane jogs stay smooth instead of turning into spikes.
  const radiusAt = (index: number): number => {
    if (index <= 0 || index >= points.length - 1) return 0;
    const prev = path.lengths[index]! - path.lengths[index - 1]!;
    const next = path.lengths[index + 1]! - path.lengths[index]!;
    if (prev < 2 || next < 2) return 0;
    return Math.min(CORNER_RADIUS, prev / 2, next / 2);
  };
  const at = (distance: number): Point => {
    const s = Math.max(0, Math.min(path.total, distance));
    for (let i = 1; i < points.length; i++) {
      const end = path.lengths[i]!;
      if (end >= s - 1e-6) {
        const a = points[i - 1]!;
        const b = points[i]!;
        const len = end - path.lengths[i - 1]!;
        const k = len < 1e-6 ? 0 : (s - path.lengths[i - 1]!) / len;
        return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
      }
    }
    return points[points.length - 1]!;
  };

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
        const from = at(s - 7);
        const to = at(s + 7);
        d += ` L ${f(from.x)} ${f(from.y)} A 7 7 0 0 1 ${f(to.x)} ${f(to.y)}`;
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

function computePolylineHops(
  edges: EdgeDecl[],
  routes: Map<string, OrthogonalRoute>,
): Map<string, number[]> {
  const paths = new Map<string, PolyPath>();
  for (const edge of edges) {
    const route = routes.get(edge.id);
    if (route) paths.set(edge.id, pathMetrics(route.points));
  }
  const hops = new Map<string, number[]>();
  for (let i = 0; i < edges.length; i++) {
    const first = edges[i]!;
    const a = paths.get(first.id);
    if (!a) continue;
    for (let j = i + 1; j < edges.length; j++) {
      const second = edges[j]!;
      const b = paths.get(second.id);
      if (!b) continue;
      const shares =
        first.from === second.from || first.from === second.to ||
        first.to === second.from || first.to === second.to;
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

function segmentOverlapLength(a1: Point, a2: Point, b1: Point, b2: Point): number {
  const aHorizontal = Math.abs(a1.y - a2.y) < 0.5;
  const bHorizontal = Math.abs(b1.y - b2.y) < 0.5;
  if (aHorizontal !== bHorizontal) return 0;
  // Lines less than 8px apart read as a single thick stroke, so treat them
  // as overlapping rather than as two clean parallel runs.
  if (aHorizontal) {
    if (Math.abs(a1.y - b1.y) > 8) return 0;
    return (
      Math.min(Math.max(a1.x, a2.x), Math.max(b1.x, b2.x)) -
      Math.max(Math.min(a1.x, a2.x), Math.min(b1.x, b2.x))
    );
  }
  if (Math.abs(a1.x - b1.x) > 8) return 0;
  return (
    Math.min(Math.max(a1.y, a2.y), Math.max(b1.y, b2.y)) -
    Math.max(Math.min(a1.y, a2.y), Math.min(b1.y, b2.y))
  );
}

/**
 * Collinear overlap between two routes. `skipAxis` ignores runs that lie on
 * the shared node port's axis: edges meeting one port are meant to merge along
 * that axis, while perpendicular parallel runs must still be separated.
 */
function overlapLength(a: Point[], b: Point[], skipAxis?: "h" | "v"): number {
  let total = 0;
  for (let i = 0; i < a.length - 1; i++) {
    const horizontal = Math.abs(a[i]!.y - a[i + 1]!.y) < 0.5;
    if (skipAxis === (horizontal ? "h" : "v")) continue;
    for (let j = 0; j < b.length - 1; j++) {
      const overlap = segmentOverlapLength(a[i]!, a[i + 1]!, b[j]!, b[j + 1]!);
      if (overlap > 1) total += overlap;
    }
  }
  return total;
}

/**
 * Length of two routes running side by side but a few pixels apart. That reads
 * as a doubled stroke, so lanes should pull such pairs apart.
 */
function nearParallelLength(a: Point[], b: Point[], skipAxis?: "h" | "v"): number {
  let total = 0;
  for (let i = 0; i < a.length - 1; i++) {
    const aHoriz = Math.abs(a[i]!.y - a[i + 1]!.y) < 0.5;
    if (skipAxis === (aHoriz ? "h" : "v")) continue;
    const aLow = Math.min(aHoriz ? a[i]!.x : a[i]!.y, aHoriz ? a[i + 1]!.x : a[i + 1]!.y);
    const aHigh = Math.max(aHoriz ? a[i]!.x : a[i]!.y, aHoriz ? a[i + 1]!.x : a[i + 1]!.y);
    for (let j = 0; j < b.length - 1; j++) {
      const bHoriz = Math.abs(b[j]!.y - b[j + 1]!.y) < 0.5;
      if (aHoriz !== bHoriz) continue;
      const dist = Math.abs(aHoriz ? a[i]!.y - b[j]!.y : a[i]!.x - b[j]!.x);
      if (dist <= 0.8 || dist >= 11) continue;
      const bLow = Math.min(bHoriz ? b[j]!.x : b[j]!.y, bHoriz ? b[j + 1]!.x : b[j + 1]!.y);
      const bHigh = Math.max(bHoriz ? b[j]!.x : b[j]!.y, bHoriz ? b[j + 1]!.x : b[j + 1]!.y);
      const overlap = Math.min(aHigh, bHigh) - Math.max(aLow, bLow);
      if (overlap > 20) total += overlap;
    }
  }
  return total;
}

/** The node port two routes share, with the axis of the run that leaves it. */
function sharedPort(a: Point[], b: Point[]): { axis: "h" | "v" } | null {
  const same = (p: Point, q: Point) => Math.abs(p.x - q.x) < 0.5 && Math.abs(p.y - q.y) < 0.5;
  const orient = (route: Point[], point: Point): "h" | "v" | null => {
    const n = route.length;
    if (n < 2) return null;
    const first = route[0]!;
    const second = route[1]!;
    if (same(first, point)) return Math.abs(first.y - second.y) < 0.5 ? "h" : "v";
    const last = route[n - 1]!;
    const prev = route[n - 2]!;
    if (same(last, point)) return Math.abs(last.y - prev.y) < 0.5 ? "h" : "v";
    return null;
  };
  for (const pa of [a[0]!, a[a.length - 1]!]) {
    for (const pb of [b[0]!, b[b.length - 1]!]) {
      if (!same(pa, pb)) continue;
      const axis = orient(a, pa) ?? orient(b, pb);
      if (axis) return { axis };
    }
  }
  return null;
}

function placeLabelOnPath(
  path: PolyPath,
  width: number,
  height: number,
  obstacles: Rect[],
  placed: Rect[],
  range?: [number, number],
  avoid?: boolean[],
): PlacedLabel {
  const candidates: { t: number; offset: number }[] = [];
  const seen = new Set<string>();
  const push = (t: number, offset: number) => {
    const key = `${t.toFixed(3)}:${offset}`;
    if (!t || t <= 0 || t >= 1 || seen.has(key)) return;
    seen.add(key);
    candidates.push({ t, offset });
  };
  const inRange = (t: number) => !range || (t >= range[0] && t <= range[1]);
  // The pill is as wide as the label, so check the whole span it covers, not
  // just the anchor point.
  const pad = (width / 2 + 6) / Math.max(1, path.total);
  const avoided = (t: number) => {
    if (!avoid) return false;
    const last = avoid.length - 1;
    const lo = Math.max(0, Math.round((t - pad) * last));
    const hi = Math.min(last, Math.round((t + pad) * last));
    for (let i = lo; i <= hi; i++) if (avoid[i]) return true;
    return false;
  };
  // Straight runs read best: try the middle of the longest ones first, sitting
  // the label just above the line (or just below when above is taken).
  const runs: { t: number; length: number; horizontal: boolean }[] = [];
  for (let i = 0; i < path.points.length - 1; i++) {
    const a = path.points[i]!;
    const b = path.points[i + 1]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length < width + 18) continue;
    const mid = path.lengths[i]! + length / 2;
    runs.push({ t: path.total ? mid / path.total : 0, length, horizontal: Math.abs(a.y - b.y) < 0.5 });
  }
  runs.sort((a, b) => Number(b.horizontal) - Number(a.horizontal) || b.length - a.length);
  for (const run of runs) {
    if (!inRange(run.t) || avoided(run.t)) continue;
    push(run.t, -12);
    push(run.t, 14);
  }
  const ts = [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74, 0.18, 0.82];
  const offsets = [0, -15, 15, -30, 30, -46, 46, -64, 64];
  for (const offset of offsets) for (const t of ts) if (inRange(t) && !avoided(t)) push(t, offset);
  if (!candidates.length) for (const offset of offsets) for (const t of ts) if (inRange(t)) push(t, offset);
  if (!candidates.length) for (const offset of offsets) for (const t of ts) push(t, offset);
  let best: PlacedLabel | null = null;
  let bestPenalty = Infinity;
  for (const { t, offset } of candidates) {
    const point = pointAtLength(path, t * path.total);
    const rect: Rect = {
      x: point.x - width / 2 - 5,
      y: point.y - height / 2 + offset,
      w: width + 10,
      h: height,
    };
    const penalty = labelPenalty(rect, obstacles, placed);
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

function escape(text: string): string {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function mount(target: HTMLElement, options: ViewerOptions): ViewerHandle {
  const viewer = new Viewer(target, options);
  viewer.update(options.source);
  return viewer;
}

export { serialize };
