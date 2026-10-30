import {
  applyLayout,
  alignBoxes,
  anchorPoint,
  defaultLayout,
  distributeBoxes,
  parse,
  DEFAULT_BOX,
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
  pathMetrics,
  placeLabelOnPath,
  planCurveSides,
  planPorts,
  pointAtLength,
  primarySide,
  relatedEdges,
  relatedNodes,
  nodeKindStyle,
  resolveVisibility,
  routeCrosses,
  sampleEdgePath,
  serialize,
  sideAlong,
  sideMidpoint,
  sideNormal,
  snapAlignment,
  visibleEdges,
  visibleGroups,
  visibleNodes,
  GROUP_PALETTE,
  type AlignmentGuide,
  type BlockDocument,
  type CurveJunction,
  type Diagnostic,
  type EdgeDecl,
  type EdgeSide,
  type EdgeGeometry,
  type ForcedAnchor,
  type GroupDecl,
  type NodeDecl,
  type NodeBox,
  type LayoutAlgorithm,
  type LabelPlacement,
  type OrthogonalRoute,
  type ParseResult,
  type PathMetrics,
  type Point,
  type PortAssignment,
  type Rect,
  type RouteStyle,
  type SideUse,
  type Visibility,
} from "@block-ml/core";
import { computeHops, computePolylineHops, edgePath, polylinePath } from "./paths.js";
import { VIEWER_CSS } from "./styles.js";

const SVGNS = "http://www.w3.org/2000/svg";
/** Lane offsets tried for orthogonal routes, nearest first. */
const ORTHO_LANES = [0, 1, -1, 2, -2, 3, -3, 4, -4];
/** Sides a bundle may share, in preference order when scores tie. */
const BUNDLE_SIDES: EdgeSide[] = ["top", "right", "bottom", "left"];
/** How close (screen px) a dragged border must come to snap onto a guide. */
const SNAP_RADIUS = 6;

export interface ViewerOptions {
  source: string;
  readOnly?: boolean;
  theme?: "light" | "dark";
  showLegend?: boolean;
  showInspector?: boolean;
  /**
   * `editing` keeps the dot grid, group fold dots, bend handles and drag
   * interactions. `presentation` is the delivered figure: no editing chrome,
   * no accidental drags, but selection and the inspector still work.
   * Defaults to `editing` so embedding editors keep their current behaviour.
   */
  mode?: "presentation" | "editing";
  /**
   * Initial route style for this view. Routing is a rendering choice, not a
   * document key; both styles satisfy the same port/normal/label contract.
   */
  route?: RouteStyle;
  /**
   * Smart guides while dragging: pull a node onto another node's border or
   * centre line. Defaults to true; hold Alt while dragging to move freely.
   */
  snap?: boolean;
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

interface BundleGroup {
  name: string;
  end: "from" | "to";
  nodeId: string;
  side: EdgeSide;
  centroid: Point;
  edges: EdgeDecl[];
}

export interface ViewerHandle {
  update(source: string): void;
  getSource(): string;
  setReadOnly(readOnly: boolean): void;
  /** Switch between the delivered figure and the editable canvas. */
  setMode(mode: "presentation" | "editing"): void;
  getMode(): "presentation" | "editing";
  /** Switch routing at render time; never written back to the source. */
  setRoute(style: RouteStyle): void;
  getRoute(): RouteStyle;
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
  /** Snap guides, kept above the nodes so a rule reads across every box. */
  private guideLayer: SVGGElement;
  private overlayLayer: SVGGElement;
  private defs: SVGDefsElement;
  private legend: HTMLElement;
  private inspector: HTMLElement;
  private layersPanel: HTMLElement;
  private alignBar: HTMLElement;
  private errorBox: HTMLElement;

  private options: ViewerOptions;
  private source: string;
  private doc: BlockDocument | null = null;
  /** `doc` filtered by the current visibility; nodes are the same objects. */
  private viewDoc: BlockDocument | null = null;
  private diagnostics: Diagnostic[] = [];
  private view = { x: 40, y: 20, k: 1 };
  private routeStyle: RouteStyle = "curve";
  private mode: "presentation" | "editing";
  private selectedNode: string | null = null;
  private selectedNodes = new Set<string>();
  private selectedEdge: string | null = null;
  private pointerSelected = false;
  private junctions = new Map<string, CurveJunction>();
  private edgePaths = new Map<string, PathMetrics>();
  private bundleOf = new Map<string, string>();
  private bundleGroups: BundleGroup[] = [];
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
    this.mode = options.mode ?? "editing";
    this.routeStyle = options.route ?? "curve";

    this.root = document.createElement("div");
    this.root.className = "bml-root";
    this.root.dataset.bmlTheme = options.theme ?? "light";
    this.root.classList.add(this.mode === "presentation" ? "bml-presentation" : "bml-editing");
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
    this.guideLayer = el("g", { class: "bml-guides" });
    this.overlayLayer = el("g", { class: "bml-overlay" });

    this.svg.appendChild(this.defs);
    this.viewport.appendChild(this.groupLayer);
    this.viewport.appendChild(this.edgeLayer);
    this.viewport.appendChild(this.headerLayer);
    this.viewport.appendChild(this.nodeLayer);
    this.viewport.appendChild(this.labelLayer);
    this.viewport.appendChild(this.uiLayer);
    this.viewport.appendChild(this.guideLayer);
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

    this.alignBar = document.createElement("div");
    this.alignBar.className = "bml-align-bar";
    this.alignBar.setAttribute("role", "toolbar");
    this.alignBar.setAttribute("aria-label", "多选对齐");
    this.alignBar.innerHTML =
      `<span class="bml-align-count" title="Shift / Ctrl 点选或 Shift+拖拽框选；Cmd/Ctrl+A 全选"></span><span class="bml-align-sep"></span>` +
      `<button type="button" data-bml-align="align-x" title="按中线对成一列">纵向对齐</button>` +
      `<button type="button" data-bml-align="align-y" title="按中线对成一行">横向对齐</button>` +
      `<button type="button" data-bml-align="dist-x" title="首尾不动，水平间距相等">水平等距</button>` +
      `<button type="button" data-bml-align="dist-y" title="首尾不动，垂直间距相等">垂直等距</button>`;
    this.alignBar.addEventListener("click", (event) => {
      const button = (event.target as Element | null)?.closest<HTMLButtonElement>("button[data-bml-align]");
      if (!button || button.disabled) return;
      this.applyAlign(button.dataset.bmlAlign!);
    });
    this.root.appendChild(this.alignBar);

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
    // A document with no persisted layout gets the layered algorithm, so the
    // first render already reads as an architecture map.
    const layout = defaultLayout(doc);
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
    // Curves can bow outside the node boxes and labels sit on the path; fit the
    // view to what is actually drawn so no label is cropped at the border.
    for (const layer of [this.edgeLayer, this.labelLayer]) {
      if (typeof layer.getBBox !== "function" || !layer.childElementCount) continue;
      const box = layer.getBBox();
      if (!Number.isFinite(box.x) || !Number.isFinite(box.y) || (!box.width && !box.height)) continue;
      x = Math.min(x, box.x);
      y = Math.min(y, box.y);
      x1 = Math.max(x1, box.x + box.width);
      y1 = Math.max(y1, box.y + box.height);
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
  }

  /* ------------------------------------------------------------- edge paint */

  /**
   * Arrowheads point at the target, so their color is the target node's color.
   * Rebuild them per render because visibility and edits change which kinds the
   * diagram actually shows.
   */
  private renderEdgeDefs(nodes: Map<string, NodeDecl>): void {
    this.defs.querySelectorAll("[data-bml-edge-def]").forEach((node) => node.remove());
    if (!this.viewDoc) return;
    const kinds = new Set<string>();
    for (const edge of this.viewDoc.edges) {
      const to = nodes.get(edge.to);
      if (to) kinds.add(to.kind);
    }
    for (const kind of kinds) {
      const marker = el("marker", {
        id: `bml-arrow-to-${kind}`,
        viewBox: "0 0 10 10",
        refX: 8.4,
        refY: 5,
        markerWidth: 6.6,
        markerHeight: 6.6,
        orient: "auto-start-reverse",
        "data-bml-edge-def": "",
      }, this.defs);
      el("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: nodeKindStyle(kind).color }, marker);
    }
  }

  /**
   * Edges fade from the source node color to the target node color. At a node
   * every outgoing line therefore starts in the same lighter tone while every
   * incoming line ends in that node's solid tone, so direction stays readable
   * even when both sides use the same border.
   */
  private edgePaint(
    edge: EdgeDecl,
    start: Point,
    end: Point,
    nodes: Map<string, NodeDecl>,
    index: number,
  ): string {
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    if (!from || !to) return nodeKindStyle("ext").color;
    const source = nodeKindStyle(from.kind).color;
    const target = nodeKindStyle(to.kind).color;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return target;
    // Keep the source tint to a short collar that follows the port, then run
    // in the target color: the line reads as belonging to where it is going.
    const reach = Math.min(1, 72 / (Math.hypot(dx, dy) || 1));
    const id = `bml-edge-paint-${index}`;
    const gradient = el("linearGradient", {
      id,
      gradientUnits: "userSpaceOnUse",
      x1: start.x,
      y1: start.y,
      x2: start.x + dx * reach,
      y2: start.y + dy * reach,
      "data-bml-edge-def": "",
    }, this.defs);
    el("stop", { offset: "0%", "stop-color": lightenHex(source, 0.55) }, gradient);
    el("stop", { offset: "100%", "stop-color": target }, gradient);
    return `url(#${id})`;
  }

  private render(): void {
    if (!this.doc || !this.viewDoc) return;
    this.nodeEls.clear();
    this.edgeEls.clear();
    this.groupEls.clear();
    this.edgePaths.clear();
    this.placedLabels = [];
    this.groupLayer.innerHTML = "";
    this.edgeLayer.innerHTML = "";
    this.nodeLayer.innerHTML = "";
    this.headerLayer.innerHTML = "";
    this.labelLayer.innerHTML = "";
    this.uiLayer.innerHTML = "";
    this.guideLayer.innerHTML = "";
    this.overlayLayer.innerHTML = "";

    // The dot grid is an editing aid; a delivered figure must not carry it.
    if (this.mode === "editing") {
      const grid = el("rect", {
        x: -8000, y: -8000, width: 16000, height: 16000, fill: "url(#bml-grid)",
      });
      this.groupLayer.appendChild(grid);
    }

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
      // Colour is a view preset now: an explicit legacy colour still wins, and
      // otherwise groups cycle through the palette by declaration order.
      const index = this.doc.groups.findIndex((item) => item.id === group.id);
      const color = group.color ?? GROUP_PALETTE[Math.max(0, index) % GROUP_PALETTE.length]!;
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
      // Fold dots are an editing affordance; presentation keeps the frame but
      // not the controls.
      if (this.mode === "editing") this.uiLayer.appendChild(toggle);

      this.groupEls.set(group.id, { rect, text, toggle, sign });
    }
  }

  private edgeGeometryOf(
    edge: EdgeDecl,
    obstacles?: { id: string; rect: Rect }[],
    soft: Rect[] = [],
  ): EdgeGeometry | null {
    if (!this.viewDoc) return null;
    return edgeGeometry(edge, {
      byId: this.nodeMap(),
      pairs: indexPairs(this.viewDoc),
      obstacles,
      soft,
      anchors: this.forcedAnchors,
      junctions: this.junctions,
      trunks: this.trunks,
    });
  }

  private nodeMap(): Map<string, NodeDecl> {
    return new Map(this.viewDoc?.nodes.map((n) => [n.id, n]) ?? []);
  }

  /**
   * Edges that declare the same `bundle:` share their common endpoint and a
   * trunk, so a node reaching several peers draws one line that branches out
   * instead of a stack of near-parallel ones.
   */
  private computeBundles(obstacles: { id: string; rect: Rect }[] = []): void {
    this.bundleOf = new Map();
    this.bundleGroups = [];
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
      let side = edgeSide(anchorPoint(sharedNode, centroid), sharedBox);
      // The centroid only says where the peers are; a node in between can make
      // that side unusable. Probe the four sides and keep the centroid side
      // unless another one routes every peer around the boxes.
      if (obstacles.length) {
        const probe = (candidate: EdgeSide): number => {
          const port = sideMidpoint(sharedBox, candidate);
          const anchors = new Map<string, { from?: ForcedAnchor; to?: ForcedAnchor }>();
          for (const item of peers) {
            const anchor = { point: port, side: candidate };
            anchors.set(item.edge.id, end === "from" ? { from: anchor } : { to: anchor });
          }
          const context = { byId: nodes, pairs: new Map(), obstacles, anchors };
          let score = 0;
          for (const item of peers) {
            const route = orthogonalRoute(item.edge, context, 0);
            if (!route) return Number.POSITIVE_INFINITY;
            const blockers = obstacles
              .filter((entry) => entry.id !== item.edge.from && entry.id !== item.edge.to)
              .map((entry) => entry.rect);
            if (routeCrosses(route.points, blockers, 2)) score += 1000;
            for (let i = 1; i < route.points.length; i++) {
              const a = route.points[i - 1]!;
              const b = route.points[i]!;
              score += Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
            }
            score += route.points.length * 6;
          }
          return score;
        };
        let bestScore = probe(side);
        for (const candidate of BUNDLE_SIDES) {
          if (candidate === side) continue;
          const score = probe(candidate);
          if (score < bestScore - 1) {
            bestScore = score;
            side = candidate;
          }
        }
      }
      const point = sideMidpoint(sharedBox, side);
      const horizontal = side === "left" || side === "right";
      const others = peers.map((item) => {
        const peerPoint = anchorPoint(item.node, { x: sharedBox.cx, y: sharedBox.cy });
        return {
          side: edgeSide(peerPoint, item.box),
          point: peerPoint,
          at: horizontal ? peerPoint.x : peerPoint.y,
        };
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
      // A shared trunk must stay outside other nodes. If it would cut through
      // one, give up the trunk (and its label window) rather than draw a line
      // behind a node; the edges still share their port and route individually.
      if (trunk && obstacles.length) {
        const skip = new Set([sharedNode.id, ...peers.map((item) => item.node.id)]);
        const rects = obstacles.filter((item) => !skip.has(item.id)).map((item) => item.rect);
        const segments: Point[][] = [];
        if (horizontal) {
          const borderX = side === "left" ? sharedBox.x : sharedBox.x + sharedBox.w;
          segments.push([{ x: borderX, y: point.y }, { x: trunk.x!, y: point.y }]);
          for (const peer of others) {
            segments.push([{ x: trunk.x!, y: point.y }, { x: trunk.x!, y: peer.point.y }]);
          }
        } else {
          const borderY = side === "top" ? sharedBox.y : sharedBox.y + sharedBox.h;
          segments.push([{ x: point.x, y: borderY }, { x: point.x, y: trunk.y! }]);
          for (const peer of others) {
            segments.push([{ x: point.x, y: trunk.y! }, { x: peer.point.x, y: trunk.y! }]);
          }
        }
        // Ports shift the shared point by up to ~17px; keep a safety margin.
        if (segments.some((segment) => routeCrosses(segment, rects, 24))) trunk = undefined;
      }
      // The final point is assigned together with every other port on this
      // border; keep the midpoint until computePorts() owns the rail.
      this.bundleGroups.push({
        name,
        end,
        nodeId: sharedNode.id,
        side,
        centroid,
        edges: peers.map((item) => item.edge),
      });
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
   * Shared port rail for both route styles. Every node border gets one port per
   * direction plus one per bundle; the assignments are written back into the
   * forced-anchor map the geometry reads.
   */
  private applyPortAssignments(assignments: PortAssignment[]): void {
    for (const assignment of assignments) {
      const forced = this.forcedAnchors.get(assignment.edgeId) ?? {};
      forced[assignment.end] = { point: assignment.point, side: assignment.side };
      this.forcedAnchors.set(assignment.edgeId, forced);
      if (!assignment.bundle) continue;
      const info = this.bundleInfo.get(assignment.edgeId);
      if (info) {
        info.sharedX = assignment.point.x;
        info.sharedY = assignment.point.y;
      }
    }
  }

  /**
   * Ports are assigned after a first orthogonal routing pass: only sides that
   * actually carry edges are considered, and inbound/outbound edges on one side
   * get separate attachment points while their own groups still share one.
   * Bundles keep their own point on the same rail.
   */
  private computePorts(baseline: Map<string, OrthogonalRoute>): void {
    if (!this.viewDoc) return;
    const nodes = this.nodeMap();
    const boxes = new Map([...nodes].map(([id, node]) => [id, boxOf(node)]));
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
    for (const group of this.bundleGroups) {
      const box = boxes.get(group.nodeId);
      if (!box) continue;
      useOf(group.nodeId, group.side).bundles.push({
        key: `bundle:${group.name}`,
        desired: sideAlong(box, group.side, group.centroid),
        edges: group.edges,
        end: group.end,
      });
    }
    for (const edge of this.viewDoc.edges) {
      const route = baseline.get(edge.id);
      if (!route) continue;
      const fromBox = boxes.get(edge.from);
      const toBox = boxes.get(edge.to);
      if (!fromBox || !toBox) continue;
      const bundled = this.bundleInfo.get(edge.id)?.end;
      if (bundled !== "from") {
        const side = edgeSide(route.points[0]!, fromBox);
        useOf(edge.from, side).outs.push({
          edge,
          desired: sideAlong(fromBox, side, { x: toBox.cx, y: toBox.cy }),
        });
      }
      if (bundled !== "to") {
        const last = route.points[route.points.length - 1]!;
        const side = edgeSide(last, toBox);
        useOf(edge.to, side).ins.push({
          edge,
          desired: sideAlong(toBox, side, { x: fromBox.cx, y: fromBox.cy }),
        });
      }
    }
    this.applyPortAssignments(planPorts([...uses.values()]));
  }

  /**
   * Curve routing shares the same ports. Sides come from the dominant relative
   * direction (so a layered layout exits right and enters left), bundles keep
   * the side computed by computeBundles, and a validated trunk point turns a
   * bundle into one shared run plus branches.
   */
  /**
   * Choose which border each curve end leaves from. The dominant-direction pair
   * wins when it stays compact and clear; the orthogonal router is the fallback
   * for a stacked pair that needs to go around a blocker.
   */
  private curveSides(
    nodeObstacles: { id: string; rect: Rect }[],
    soft: Rect[],
  ): Map<string, { from?: EdgeSide; to?: EdgeSide }> {
    if (!this.viewDoc) return new Map();
    return planCurveSides(this.viewDoc, {
      obstacles: nodeObstacles,
      soft,
      anchors: this.forcedAnchors,
    });
  }

  private buildCurveRoutes(nodeObstacles: { id: string; rect: Rect }[], soft: Rect[]): void {
    if (!this.viewDoc) return;
    this.computeBundles(nodeObstacles);
    this.junctions = new Map();
    const nodes = this.nodeMap();
    const boxes = new Map([...nodes].map(([id, node]) => [id, boxOf(node)]));
    const sides = this.curveSides(nodeObstacles, soft);
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
    for (const group of this.bundleGroups) {
      const box = boxes.get(group.nodeId);
      if (!box) continue;
      useOf(group.nodeId, group.side).bundles.push({
        key: `bundle:${group.name}`,
        desired: sideAlong(box, group.side, group.centroid),
        edges: group.edges,
        end: group.end,
      });
    }
    for (const edge of this.viewDoc.edges) {
      const fromBox = boxes.get(edge.from);
      const toBox = boxes.get(edge.to);
      if (!fromBox || !toBox) continue;
      const bundled = this.bundleInfo.get(edge.id)?.end;
      if (bundled !== "from") {
        const side = sides.get(edge.id)?.from ?? primarySide(fromBox, toBox);
        useOf(edge.from, side).outs.push({
          edge,
          desired: sideAlong(fromBox, side, { x: toBox.cx, y: toBox.cy }),
        });
      }
      if (bundled !== "to") {
        const side = sides.get(edge.id)?.to ?? primarySide(toBox, fromBox);
        useOf(edge.to, side).ins.push({
          edge,
          desired: sideAlong(toBox, side, { x: fromBox.cx, y: fromBox.cy }),
        });
      }
    }
    this.applyPortAssignments(planPorts([...uses.values()]));

    // A bundle trunk is a short run along the shared normal. If that run would
    // cut a node, keep the shared port but drop the trunk rather than draw
    // through a box.
    for (const group of this.bundleGroups) {
      const first = group.edges[0];
      if (!first) continue;
      const anchor = this.forcedAnchors.get(first.id)?.[group.end];
      if (!anchor) continue;
      const normal = sideNormal(anchor.side);
      const point = {
        x: anchor.point.x + normal.x * 30,
        y: anchor.point.y + normal.y * 30,
      };
      const blockers = nodeObstacles
        .filter((item) => item.id !== group.nodeId)
        .map((item) => item.rect);
      if (routeCrosses([anchor.point, point], blockers, 2)) continue;
      for (const edge of group.edges) {
        this.junctions.set(edge.id, { point, side: anchor.side, end: group.end });
      }
    }
  }

  /**
   * Greedy lane assignment plus overlap repair for one candidate set.
   */
  private selectRoutes(
    edges: EdgeDecl[],
    candidates: Map<string, Map<number, OrthogonalRoute>>,
    byId: Map<string, NodeDecl>,
    paint = false,
    obstacles: { id: string; rect: Rect }[] = [],
  ): Map<string, OrthogonalRoute> {
    const routes = new Map<string, OrthogonalRoute>();
    const lanes = new Map<string, number>();
    const routeOf = (edge: EdgeDecl): OrthogonalRoute | undefined =>
      candidates.get(edge.id)?.get(lanes.get(edge.id) ?? 0);

    const sameBundle = (a: string, b: string): boolean => {
      const bundle = this.bundleOf.get(a);
      return bundle !== undefined && bundle === this.bundleOf.get(b);
    };
    // Lane separation follows the stroke color. The first pass keeps protocol
    // colors so repainting never changes side choices; the final pass compares
    // the actual gradient (source kind -> target kind) before merging lines.
    const colorOf = new Map(
      edges.map((edge) => [
        edge.id,
        paint
          ? `${byId.get(edge.from)?.kind ?? ""}>${byId.get(edge.to)?.kind ?? ""}`
          : edgeKindStyle(edge.kind).color,
      ]),
    );
    const weightOf = (a: string, b: string): number => (colorOf.get(a) === colorOf.get(b) ? 0.25 : 1);

    // A lane that cuts through a node is not a valid candidate. Only fall back
    // to those when every lane is blocked.
    const laneOptions = new Map<string, number[]>();
    for (const edge of edges) {
      const all = [...(candidates.get(edge.id)?.keys() ?? [])];
      const blockers = obstacles
        .filter((item) => item.id !== edge.from && item.id !== edge.to)
        .map((item) => item.rect);
      const clean = all.filter((lane) => {
        const route = candidates.get(edge.id)?.get(lane);
        return !!route && !routeCrosses(route.points, blockers, 2);
      });
      laneOptions.set(edge.id, clean.length ? clean : all);
    }

    const accepted: { id: string; points: Point[] }[] = [];
    for (const edge of edges) {
      const options = laneOptions.get(edge.id) ?? [];
      let chosen = options[0] ?? 0;
      for (const lane of options) {
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
        for (const lane of laneOptions.get(edge.id) ?? []) {
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

  /**
   * Orthogonal routes for every edge. Lanes shift the trunk/stub of an edge so
   * no two edges draw on the same line; leftover conflicts are repaired by
   * re-laning the earlier edge while the total overlap keeps dropping.
   */
  private buildOrthogonalRoutes(
    nodeObstacles: { id: string; rect: Rect }[],
    soft: Rect[],
  ): Map<string, OrthogonalRoute> {
    if (!this.viewDoc) return new Map();
    this.computeBundles(nodeObstacles);
    this.junctions = new Map();
    const edges = this.viewDoc.edges;
    const ctx = {
      byId: this.nodeMap(),
      pairs: indexPairs(this.viewDoc),
      obstacles: nodeObstacles,
      soft,
      anchors: this.forcedAnchors,
      trunks: this.trunks,
    };
    const buildCandidates = (): Map<string, Map<number, OrthogonalRoute>> => {
      const candidates = new Map<string, Map<number, OrthogonalRoute>>();
      for (const edge of edges) {
        const perLane = new Map<number, OrthogonalRoute>();
        // Bundled edges share one trunk, so they must stay on the base lane.
        const lanes = this.bundleOf.has(edge.id) ? [0] : ORTHO_LANES;
        for (const lane of lanes) {
          const route = orthogonalRoute(edge, ctx, lane);
          if (route) perLane.set(lane, route);
        }
        candidates.set(edge.id, perLane);
      }
      return candidates;
    };

    // The first pass chooses sides exactly as the router always did, skipping
    // lanes that would cut through a node. Ports are then spread only on the
    // sides that pass actually used, and the second pass re-lanes the pinned
    // endpoints, so slots never force a worse detour.
    const baseline = this.selectRoutes(edges, buildCandidates(), ctx.byId, false, nodeObstacles);
    this.computePorts(baseline);
    return this.selectRoutes(edges, buildCandidates(), ctx.byId, true, nodeObstacles);
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
  private foreignMarks(paths: Map<string, PathMetrics>): Map<string, boolean[]> {
    const out = new Map<string, boolean[]>();
    if (paths.size < 2) return out;
    const SAMPLES = 160;
    const routes = [...paths];
    const near = (point: Point, start: Point, end: Point): boolean => {
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const length = Math.hypot(dx, dy);
      if (!length) return Math.hypot(point.x - start.x, point.y - start.y) < 1.5;
      const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (length * length)));
      return Math.hypot(point.x - (start.x + dx * t), point.y - (start.y + dy * t)) < 1.5;
    };
    for (const [id, path] of routes) {
      const marks: boolean[] = new Array(SAMPLES + 1).fill(false);
      for (let k = 0; k <= SAMPLES; k++) {
        const point = pointAtLength(path, (k / SAMPLES) * path.total);
        for (const [otherId, other] of routes) {
          if (otherId === id) continue;
          const points = other.points;
          for (let j = 0; j < points.length - 1; j++) {
            if (near(point, points[j]!, points[j + 1]!)) {
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

  /** Label window that keeps bundled labels off the shared orthogonal trunk. */
  private bundleLabelRange(path: PathMetrics, edgeId: string): [number, number] | undefined {
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

  /** Label window that keeps a curve bundle's label off its shared trunk. */
  private curveBundleLabelRange(geo: EdgeGeometry, edgeId: string): [number, number] | undefined {
    const info = this.bundleInfo.get(edgeId);
    if (!info || !this.junctions.has(edgeId)) return undefined;
    const path = this.edgePaths.get(edgeId);
    if (!path?.total) return undefined;
    const margin = 10;
    if (info.end === "from") {
      const trunk = Math.hypot(geo.control.x - geo.p1.x, geo.control.y - geo.p1.y);
      return [Math.min(1, (trunk + margin) / path.total), 1];
    }
    const trunk = Math.hypot(geo.p2.x - geo.control.x, geo.p2.y - geo.control.y);
    return [0, Math.max(0, (path.total - trunk - margin) / path.total)];
  }

  /** Route every edge for the current style and collect label/hop paths. */
  private routeGeometry(): {
    obstacles: Rect[];
    geos: Map<string, EdgeGeometry>;
    paths: Map<string, PathMetrics>;
    hops: Map<string, number[]> | null;
    orthHops: Map<string, number[]> | null;
  } {
    const { labels: obstacles, routes: routeObstacles, soft } = this.collectObstacles();
    const orthogonal = this.routeStyle === "orthogonal";
    const geos = new Map<string, EdgeGeometry>();
    const paths = new Map<string, PathMetrics>();
    let hops: Map<string, number[]> | null = null;
    let orthHops: Map<string, number[]> | null = null;
    if (!this.viewDoc) return { obstacles, geos, paths, hops, orthHops };
    if (orthogonal) {
      const routes = this.buildOrthogonalRoutes(routeObstacles, soft);
      for (const [id, route] of routes) paths.set(id, pathMetrics(route.points));
      orthHops = computePolylineHops(this.viewDoc.edges, routes);
    } else {
      this.buildCurveRoutes(routeObstacles, soft);
      for (const edge of this.viewDoc.edges) {
        const geo = this.edgeGeometryOf(edge, routeObstacles, soft);
        if (!geo) continue;
        geos.set(edge.id, geo);
        paths.set(edge.id, pathMetrics(sampleEdgePath(geo, 96)));
      }
      hops = computeHops(this.viewDoc.edges, geos);
    }
    return { obstacles, geos, paths, hops, orthHops };
  }

  private renderEdges(): void {
    if (!this.doc || !this.viewDoc) return;
    const orthogonal = this.routeStyle === "orthogonal";
    const geometry = this.routeGeometry();
    this.edgePaths = geometry.paths;
    const nodes = this.nodeMap();
    this.renderEdgeDefs(nodes);
    const foreign = this.foreignMarks(geometry.paths);

    let paintIndex = 0;
    for (const edge of this.viewDoc.edges) {
      const path = geometry.paths.get(edge.id);
      const geo = geometry.geos.get(edge.id);
      if (!path || (!orthogonal && !geo)) continue;
      const style = edgeKindStyle(edge.kind);
      const dash = edge.dash === null ? style.dash ?? "" : edge.dash ? "6 4" : "";
      const d = orthogonal
        ? polylinePath(path.points, geometry.orthHops?.get(edge.id))
        : edgePath(geo!, geometry.hops?.get(edge.id));
      const start = path.points[0]!;
      const end = path.points[path.points.length - 1]!;
      const paint = this.edgePaint(edge, start, end, nodes, paintIndex++);
      const arrowKind = nodes.get(edge.to)?.kind ?? "ext";

      const group = el("g", { class: "bml-edge", "data-id": edge.id });
      const hit = el("path", { d, class: "bml-edge-hit" }, group);
      const line = el("path", {
        d,
        class: "bml-edge-line",
        stroke: paint,
        "stroke-dasharray": dash || "none",
        "marker-end": `url(#bml-arrow-to-${arrowKind})`,
      }, group);
      this.edgeLayer.appendChild(group);

      const labelGroup = el("g", { class: "bml-edge-label-group", "data-id": edge.id });
      const labelText = edge.label ?? edge.title ?? "";
      const font = `500 10.5px ${getComputedStyle(this.root).fontFamily}`;
      const shown = truncate(labelText, font, 260);
      const width = shown ? textWidth(shown, font) : 0;
      let t = 0.5;
      let offset = 0;
      if (shown) {
        const range = orthogonal
          ? this.bundleLabelRange(path, edge.id)
          : this.curveBundleLabelRange(geo!, edge.id);
        const placed = placeLabelOnPath(
          path,
          width,
          17,
          geometry.obstacles,
          this.placedLabels,
          { range, avoid: foreign.get(edge.id) },
        );
        this.placedLabels.push(placed.rect);
        t = placed.t;
        offset = placed.offset;
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
      (edge as EdgeDecl & { __labelT?: number; __labelOff?: number }).__labelT = t;
      (edge as EdgeDecl & { __labelOff?: number }).__labelOff = offset;

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
      // Shift+drag on the canvas draws a selection rectangle; plain drag still pans.
      if (event.shiftKey && this.viewDoc && !this.options.readOnly && this.mode === "editing") {
        event.preventDefault();
        this.selectEdge(null);
        this.startMarquee(event);
        return;
      }
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

  /**
   * A Shift+drag rectangle on empty canvas. It is additive to the current
   * selection, and every node it touches lights up live while dragging.
   */
  private startMarquee(event: PointerEvent): void {
    const rect = this.svg.getBoundingClientRect();
    const origin = { x: event.clientX, y: event.clientY };
    const base = new Set(this.selectedNodes);
    let shape: SVGRectElement | null = null;
    let moved = false;

    const onMove = (move: PointerEvent) => {
      if (!moved && Math.abs(move.clientX - origin.x) < 3 && Math.abs(move.clientY - origin.y) < 3) return;
      moved = true;
      const left = Math.min(origin.x, move.clientX) - rect.left;
      const top = Math.min(origin.y, move.clientY) - rect.top;
      const width = Math.abs(move.clientX - origin.x);
      const height = Math.abs(move.clientY - origin.y);
      if (!shape) shape = el("rect", { class: "bml-marquee", rx: 3 }, this.svg);
      shape.setAttribute("x", String(left));
      shape.setAttribute("y", String(top));
      shape.setAttribute("width", String(width));
      shape.setAttribute("height", String(height));

      const a = this.toWorld(origin.x, origin.y);
      const b = this.toWorld(move.clientX, move.clientY);
      const bounds = {
        x: Math.min(a.x, b.x),
        y: Math.min(a.y, b.y),
        w: Math.abs(b.x - a.x),
        h: Math.abs(b.y - a.y),
      };
      const hits = (this.viewDoc?.nodes ?? [])
        .filter((node) => node.at)
        .filter((node) => {
          const box = boxOf(node);
          return box.x < bounds.x + bounds.w && box.x + box.w > bounds.x &&
            box.y < bounds.y + bounds.h && box.y + box.h > bounds.y;
        })
        .map((node) => node.id);
      this.previewSelection(new Set([...base, ...hits]));
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      shape?.remove();
      if (!moved) return;
      this.finishMarquee();
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
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
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      const ids = this.viewDoc?.nodes.map((node) => node.id) ?? [];
      if (!ids.length) return;
      event.preventDefault();
      this.selectedNodes = new Set(ids);
      this.selectedNode = null;
      this.selectedEdge = null;
      this.applySelection();
      this.closeInspector();
    }
  };

  private startNodeDrag(event: PointerEvent, node: NodeDecl): void {
    if (event.button !== 0) return;
    if (this.options.readOnly || this.mode !== "editing") return;
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
    // Positions and neighbour boxes are fixed for the whole gesture, so every
    // move re-uses them instead of re-measuring the already dragged nodes.
    const movingBoxes = moving.map((n) => boxOf(n));
    const movingIds = new Set(moving.map((n) => n.id));
    const targets = (this.viewDoc?.nodes ?? [])
      .filter((n) => n.at && !movingIds.has(n.id))
      .map((n) => boxOf(n));
    const snapping = this.options.snap !== false;
    let moved = false;
    this.clearGuides();
    for (const n of moving) this.nodeEls.get(n.id)?.classList.add("bml-dragging");

    const onMove = (e: PointerEvent) => {
      const p = this.toWorld(e.clientX, e.clientY);
      let dx = Math.round(p.x - start.x);
      let dy = Math.round(p.y - start.y);
      let guides: AlignmentGuide[] = [];
      if (snapping && !e.altKey && (dx || dy)) {
        const snapped = snapAlignment(movingBoxes, targets, dx, dy, SNAP_RADIUS / this.view.k);
        dx = snapped.dx;
        dy = snapped.dy;
        guides = snapped.guides;
      }
      this.drawGuides(guides);
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
      // Ports are shared, so moving one node can re-side every edge on it.
      this.refreshEdgePaths();
      this.refreshGroups();
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      this.clearGuides();
      for (const n of moving) this.nodeEls.get(n.id)?.classList.remove("bml-dragging");
      if (!moved) return;
      this.suppressClick = true;
      setTimeout(() => { this.suppressClick = false; }, 250);
      this.commit({ nodes: new Map(moving.map((n) => [n.id, n.at!])) });
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  /** Draw the alignment rules for the current snapped drag; one line per axis. */
  private drawGuides(guides: AlignmentGuide[]): void {
    this.guideLayer.replaceChildren();
    for (const guide of guides) {
      const vertical = guide.axis === "x";
      el("line", {
        x1: vertical ? guide.at : guide.from,
        y1: vertical ? guide.from : guide.at,
        x2: vertical ? guide.at : guide.to,
        y2: vertical ? guide.to : guide.at,
        "vector-effect": "non-scaling-stroke",
        class: "bml-guide",
      }, this.guideLayer);
    }
  }

  private clearGuides(): void {
    this.guideLayer.replaceChildren();
  }

  private startBendDrag(event: PointerEvent, edge: EdgeDecl): void {
    if (event.button !== 0 || this.options.readOnly || this.mode !== "editing") return;
    if (this.routeStyle === "orthogonal") return;
    // A bundled curve's shared control point belongs to the whole bundle, not
    // to one edge; `via` is a single-edge escape hatch only.
    if (this.junctions.has(edge.id)) return;
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

  /** Rebuild every edge path; ports, labels and hops all follow node positions. */
  private refreshEdgePaths(): void {
    if (!this.viewDoc) return;
    const geometry = this.routeGeometry();
    this.edgePaths = geometry.paths;
    const orthogonal = this.routeStyle === "orthogonal";
    for (const edge of this.viewDoc.edges) {
      const els = this.edgeEls.get(edge.id);
      const path = geometry.paths.get(edge.id);
      const geo = geometry.geos.get(edge.id);
      if (!els || !path || (!orthogonal && !geo)) continue;
      const d = orthogonal
        ? polylinePath(path.points, geometry.orthHops?.get(edge.id))
        : edgePath(geo!, geometry.hops?.get(edge.id));
      els.line.setAttribute("d", d);
      els.hit.setAttribute("d", d);
      this.placeEdgeLabel(edge, path);
    }
  }

  private placeEdgeLabel(edge: EdgeDecl, path?: PathMetrics): void {
    const els = this.edgeEls.get(edge.id);
    if (!els) return;
    const labelPath = path ?? this.edgePaths.get(edge.id);
    if (!labelPath) return;
    const family = getComputedStyle(this.root).fontFamily;
    const font = `500 10.5px ${family}`;
    const text = truncate(edge.label ?? edge.title ?? "", font, 260);
    if (!text) return;
    const width = textWidth(text, font);
    const t = (edge as EdgeDecl & { __labelT?: number }).__labelT ?? 0.5;
    const off = (edge as EdgeDecl & { __labelOff?: number }).__labelOff ?? 0;
    const point = pointAtLength(labelPath, t * labelPath.total);
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
    this.updateAlignBar();
  }

  /** Visible nodes in the current selection; hidden ones cannot be aligned. */
  private selectedVisibleNodes(): NodeDecl[] {
    return this.viewDoc?.nodes.filter((node) => node.at && this.selectedNodes.has(node.id)) ?? [];
  }

  private updateAlignBar(): void {
    const selected = this.selectedVisibleNodes();
    const open = this.mode === "editing" && !this.options.readOnly && selected.length >= 2;
    this.alignBar.classList.toggle("bml-open", open);
    if (!open) return;
    const count = this.alignBar.querySelector(".bml-align-count");
    if (count) count.textContent = `${selected.length} 个节点`;
    for (const button of this.alignBar.querySelectorAll<HTMLButtonElement>("button[data-bml-align]")) {
      const distribute = button.dataset.bmlAlign?.startsWith("dist") ?? false;
      button.disabled = distribute && selected.length < 3;
    }
  }

  private applyAlign(action: string): void {
    if (this.options.readOnly) return;
    const nodes = this.selectedVisibleNodes();
    if (nodes.length < 2) return;
    const items = nodes.map((node) => ({ id: node.id, rect: boxOf(node) }));
    let next: Map<string, Point>;
    if (action === "align-x") next = alignBoxes(items, "x");
    else if (action === "align-y") next = alignBoxes(items, "y");
    else if (action === "dist-x" && items.length >= 3) next = distributeBoxes(items, "x");
    else if (action === "dist-y" && items.length >= 3) next = distributeBoxes(items, "y");
    else return;
    if (next.size) this.commit({ nodes: next });
  }

  /** Live selection while a marquee is dragged; no inspector changes per move. */
  private previewSelection(ids: Set<string>): void {
    this.selectedNodes = new Set(ids);
    this.selectedEdge = null;
    this.selectedNode = ids.size === 1 ? [...ids][0]! : null;
    this.applySelection();
  }

  private finishMarquee(): void {
    const ids = this.selectedNodes;
    if (ids.size === 1) {
      this.selectedNode = [...ids][0]!;
      this.applySelection();
      this.openNodeInspector(this.selectedNode);
      return;
    }
    this.selectedNode = null;
    this.applySelection();
    this.closeInspector();
  }

  /** Dim everything that is not on the hovered/selected node. */
  private applyFocus(): void {
    // A multi-selection is itself the focus; dimming unrelated nodes would hide
    // the very boxes the user is about to align.
    const focus = this.selectedNodes.size > 1 ? null : this.selectedNode ?? this.hoveredNode;
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
    if (this.mode !== "editing" || this.routeStyle === "orthogonal" || !this.selectedEdge || !this.doc) {
      return;
    }
    const edge = this.doc.edges.find((e) => e.id === this.selectedEdge);
    if (!edge) return;
    const { routes, soft } = this.collectObstacles();
    const geo = this.edgeGeometryOf(edge, routes, soft);
    // A detour is auto-routed and a bundle's apex belongs to the whole group;
    // neither offers a single-edge handle.
    if (!geo || geo.detour || this.junctions.has(edge.id)) return;
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
    if (!this.options.readOnly && this.mode === "editing") {
      sections.push(
        this.routeStyle === "orthogonal"
          ? `<h3>走线</h3><p>正交走线由节点位置自动生成；端口与出线方向由平台统一决定。</p>`
          : this.junctions.has(edge.id)
            ? `<h3>走线</h3><p>这条边属于 <code>bundle</code>，共享主干由组内连线共同决定。</p>`
            : `<h3>调整走线</h3><p>拖动曲线中点改变曲率，坐标会写回文件里的 <code>via</code>；出线方向与端口由平台统一决定。</p>`,
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
    if (this.mode !== "editing") return;
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
    this.updateAlignBar();
  }

  setMode(mode: "presentation" | "editing"): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.root.classList.toggle("bml-presentation", mode === "presentation");
    this.root.classList.toggle("bml-editing", mode === "editing");
    if (mode === "presentation") {
      this.toggleLayers(false);
      this.layersOpen = false;
      this.layersPanel.classList.remove("bml-open");
      this.overlayLayer.innerHTML = "";
    }
    this.render();
  }

  getMode(): "presentation" | "editing" {
    return this.mode;
  }

  setRoute(style: RouteStyle): void {
    if (this.routeStyle === style) return;
    this.routeStyle = style;
    this.render();
  }

  getRoute(): RouteStyle {
    return this.routeStyle;
  }

  toSVG(): string {
    const clone = this.svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("xmlns", SVGNS);
    clone.querySelector(".bml-overlay")?.remove();
    clone.querySelector(".bml-ui")?.remove();
    clone.querySelector(".bml-groups > rect[fill^='url']")?.remove();
    // 交互件与临时态不属于图本身
    clone.querySelectorAll(".bml-group-toggle, .bml-bend-handle, .bml-bend-line, .bml-edge-hit, .bml-guides, .bml-marquee").forEach((el) => el.remove());
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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Mix a hex color toward white; used for the source end of an edge gradient. */
function lightenHex(hex: string, amount: number): string {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) return hex;
  const value = parseInt(match[1]!, 16);
  const mix = (channel: number) => Math.round(channel + (255 - channel) * clamp(amount, 0, 1));
  const r = mix((value >> 16) & 255);
  const g = mix((value >> 8) & 255);
  const b = mix(value & 255);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
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
