import {
  applyLayout,
  parse,
  DEFAULT_BOX,
  autoLayout,
  bezierAt,
  boxOf,
  contentBounds,
  edgeDisplayName,
  edgeGeometry,
  edgeKindStyle,
  groupBoundingBox,
  hasErrors,
  indexPairs,
  layoutDocument,
  nodeDisplayName,
  relatedEdges,
  relatedNodes,
  nodeKindStyle,
  pathOf,
  serialize,
  GROUP_HEAD,
  GROUP_PAD,
  type BlockDocument,
  type Diagnostic,
  type EdgeDecl,
  type EdgeGeometry,
  type GroupDecl,
  type NodeDecl,
  type LayoutAlgorithm,
  type ParseResult,
  type Point,
  type Rect,
} from "@blockml/core";
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
}

export interface ViewerHandle {
  update(source: string): void;
  getSource(): string;
  setReadOnly(readOnly: boolean): void;
  fit(): void;
  zoomTo(scale: number): void;
  layout(algorithm: LayoutAlgorithm): void;
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

function rectsHit(a: Rect, b: Rect, pad: number): boolean {
  return !(
    a.x + a.w + pad < b.x ||
    b.x + b.w + pad < a.x ||
    a.y + a.h + pad < b.y ||
    b.y + b.h + pad < a.y
  );
}

class Viewer implements ViewerHandle {
  private root: HTMLElement;
  private svg: SVGSVGElement;
  private viewport: SVGGElement;
  private groupLayer: SVGGElement;
  private edgeLayer: SVGGElement;
  private nodeLayer: SVGGElement;
  private labelLayer: SVGGElement;
  private overlayLayer: SVGGElement;
  private defs: SVGDefsElement;
  private legend: HTMLElement;
  private inspector: HTMLElement;
  private errorBox: HTMLElement;

  private options: ViewerOptions;
  private source: string;
  private doc: BlockDocument | null = null;
  private diagnostics: Diagnostic[] = [];
  private view = { x: 40, y: 20, k: 1 };
  private selectedNode: string | null = null;
  private selectedEdge: string | null = null;
  private hoveredNode: string | null = null;
  private nodeEls = new Map<string, SVGGElement>();
  private edgeEls = new Map<string, { line: SVGPathElement; hit: SVGPathElement; labelLayer: SVGGElement }>();
  private groupEls = new Map<string, { rect: SVGRectElement; text: SVGTextElement }>();
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
    this.nodeLayer = el("g", { class: "bml-nodes" });
    this.labelLayer = el("g", { class: "bml-labels" });
    this.overlayLayer = el("g", { class: "bml-overlay" });

    this.svg.appendChild(this.defs);
    this.viewport.appendChild(this.groupLayer);
    this.viewport.appendChild(this.edgeLayer);
    this.viewport.appendChild(this.nodeLayer);
    this.viewport.appendChild(this.labelLayer);
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
    if (!this.doc) return;
    this.nodeEls.clear();
    this.edgeEls.clear();
    this.groupEls.clear();
    this.placedLabels = [];
    this.groupLayer.innerHTML = "";
    this.edgeLayer.innerHTML = "";
    this.nodeLayer.innerHTML = "";
    this.labelLayer.innerHTML = "";
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
  }

  private renderGroups(): void {
    if (!this.doc) return;
    for (const group of this.doc.groups) {
      const members = this.doc.nodes.filter((n) => n.group === group.id);
      const box = groupBoundingBox(members);
      if (!box) continue;
      const color = group.color ?? "#64748b";
      const rect = el("rect", {
        x: box.x, y: box.y, width: box.w, height: box.h, rx: 16,
        fill: color, stroke: color, class: "bml-group-box",
      }) as SVGRectElement;
      this.groupLayer.appendChild(rect);
      const text = el("text", {
        x: box.x + 16, y: box.y + 21, class: "bml-group-label", fill: color,
      }) as SVGTextElement;
      text.textContent = group.label ?? group.title;
      this.groupLayer.appendChild(text);
      this.groupEls.set(group.id, { rect, text });
    }
  }

  private edgeGeometryOf(edge: EdgeDecl): EdgeGeometry | null {
    if (!this.doc) return null;
    return edgeGeometry(edge, { byId: new Map(this.doc.nodes.map((n) => [n.id, n])), pairs: indexPairs(this.doc) });
  }

  private renderEdges(): void {
    if (!this.doc) return;
    const family = getComputedStyle(this.root).fontFamily;
    const obstacles: Rect[] = this.doc.nodes.map((n) => ({
      x: n.at!.x - 2, y: n.at!.y - 2, w: DEFAULT_BOX.width + 4, h: DEFAULT_BOX.height + 4,
    }));
    for (const group of this.doc.groups) {
      const members = this.doc.nodes.filter((n) => n.group === group.id);
      const box = groupBoundingBox(members);
      if (!box) continue;
      const label = group.label ?? group.title;
      const width = textWidth(label, `600 10.5px ${family}`);
      obstacles.push({ x: box.x + 8, y: box.y + 5, w: width + 26, h: 24 });
    }

    for (const edge of this.doc.edges) {
      const geo = this.edgeGeometryOf(edge);
      if (!geo) continue;
      const style = edgeKindStyle(edge.kind);
      const dash = edge.dash === null ? style.dash ?? "" : edge.dash ? "6 4" : "";

      const group = el("g", { class: "bml-edge", "data-id": edge.id });
      const hit = el("path", { d: pathOf(geo), class: "bml-edge-hit" }, group);
      const line = el("path", {
        d: pathOf(geo),
        class: "bml-edge-line",
        stroke: style.color,
        "stroke-dasharray": dash || "none",
        "marker-end": `url(#bml-arrow-${edge.kind})`,
      }, group);
      this.edgeLayer.appendChild(group);

      const labelGroup = el("g", { class: "bml-edge-label-group", "data-id": edge.id });
      const labelText = edge.label ?? edge.title ?? "";
      const font = `500 10.5px ${family}`;
      const shown = truncate(labelText, font, 260);
      const width = shown ? textWidth(shown, font) : 0;
      const placed = placeLabel(geo, width, 17, obstacles, this.placedLabels);
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
    if (!this.doc) return;
    const family = getComputedStyle(this.root).fontFamily;
    for (const node of this.doc.nodes) {
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

      group.addEventListener("pointerdown", (event) => this.startNodeDrag(event, node, group));
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
      group.addEventListener("click", () => {
        if (this.suppressClick) { this.suppressClick = false; return; }
        this.selectNode(node.id);
      });

      this.nodeLayer.appendChild(group);
      this.nodeEls.set(node.id, group);
    }
  }

  private renderLegend(): void {
    if (this.options.showLegend === false || !this.doc) {
      this.legend.style.display = "none";
      return;
    }
    const seen = new Set<string>();
    for (const node of this.doc.nodes) seen.add(node.kind);
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
    if (!this.doc) return;
    const rect = this.svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const bounds = contentBounds(this.doc);
    const pad = 56;
    const k = clamp(Math.min((rect.width - pad * 2) / Math.max(bounds.w, 1),
                             (rect.height - pad * 2) / Math.max(bounds.h, 1)), 0.15, 1.2);
    this.view = {
      k,
      x: (rect.width - bounds.w * k) / 2 - bounds.x * k,
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
      this.selectNode(null);
      this.selectEdge(null);
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "0") {
      event.preventDefault();
      this.fit();
    }
  };

  private startNodeDrag(event: PointerEvent, node: NodeDecl, group: SVGGElement): void {
    if (event.button !== 0) return;
    if (this.options.readOnly) return;
    event.stopPropagation();

    const start = this.toWorld(event.clientX, event.clientY);
    const origin = { x: node.at!.x, y: node.at!.y, x0: start.x, y0: start.y };
    let moved = false;
    group.classList.add("bml-dragging");

    const affected = this.doc?.edges.filter((e) => e.from === node.id || e.to === node.id) ?? [];

    const onMove = (e: PointerEvent) => {
      const p = this.toWorld(e.clientX, e.clientY);
      const x = Math.round(origin.x + (p.x - origin.x0));
      const y = Math.round(origin.y + (p.y - origin.y0));
      if (x === node.at!.x && y === node.at!.y) return;
      node.at = { x, y };
      moved = true;
      group.setAttribute("transform", `translate(${x} ${y})`);
      for (const edge of affected) this.refreshEdge(edge);
      this.refreshGroups();
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      group.classList.remove("bml-dragging");
      if (!moved) return;
      this.suppressClick = true;
      setTimeout(() => { this.suppressClick = false; }, 250);
      this.commit({ nodes: new Map([[node.id, node.at!]]) });
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  private startBendDrag(event: PointerEvent, edge: EdgeDecl): void {
    if (event.button !== 0 || this.options.readOnly) return;
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
    if (!this.doc) return;
    for (const group of this.doc.groups) {
      const els = this.groupEls.get(group.id);
      if (!els) continue;
      const members = this.doc.nodes.filter((n) => n.group === group.id);
      const box = groupBoundingBox(members);
      if (!box) continue;
      els.rect.setAttribute("x", String(box.x));
      els.rect.setAttribute("y", String(box.y));
      els.rect.setAttribute("width", String(box.w));
      els.rect.setAttribute("height", String(box.h));
      els.text.setAttribute("x", String(box.x + 16));
      els.text.setAttribute("y", String(box.y + 21));
    }
  }

  /* ------------------------------------------------------------ mutation */

  private commit(patch: { nodes?: Map<string, Point>; edges?: Map<string, Point> }): void {
    if (!this.doc) return;
    const next = applyLayout(this.source, this.doc, patch);
    if (next === this.source) return;
    this.source = next;
    this.options.onSourceChange?.(next);
    const selection = { node: this.selectedNode, edge: this.selectedEdge };
    this.parse(this.source);
    this.render();
    this.selectedNode = selection.node;
    this.selectedEdge = selection.edge;
    this.applySelection();
    this.refreshBendHandle();
  }

  /* ------------------------------------------------------------ selection */

  private selectNode(id: string | null): void {
    this.selectedNode = id;
    if (id) this.selectedEdge = null;
    this.applySelection();
    if (id) this.openNodeInspector(id);
    else if (!this.selectedEdge) this.closeInspector();
  }

  private selectEdge(id: string | null): void {
    this.selectedEdge = id;
    if (id) this.selectedNode = null;
    this.applySelection();
    if (id) this.openEdgeInspector(id);
    else this.closeInspector();
  }

  private applySelection(): void {
    for (const [id, node] of this.nodeEls) {
      node.classList.toggle("bml-selected", id === this.selectedNode);
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
    const edges = this.doc ? relatedEdges(this.doc, focus) : new Set<string>();
    const nodes = this.doc ? relatedNodes(this.doc, focus) : new Set<string>();
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
    if (!this.selectedEdge || !this.doc) return;
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
      sections.push(`<h3>调整走线</h3><p>拖动画布上的圆点改变曲率，坐标会写回文件里的 <code>via</code>。</p>`);
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
    clone.querySelector(".bml-groups > rect[fill^='url']")?.remove();

    if (this.doc) {
      const bounds = contentBounds(this.doc);
      const pad = 40;
      clone.setAttribute("viewBox", `${bounds.x - pad} ${bounds.y - pad} ${bounds.w + pad * 2} ${bounds.h + pad * 2}`);
      clone.setAttribute("width", String(Math.ceil(bounds.w + pad * 2)));
      clone.setAttribute("height", String(Math.ceil(bounds.h + pad * 2)));
    }
    clone.querySelector(".bml-viewport")?.removeAttribute("transform");

    const style = document.createElementNS(SVGNS, "style");
    style.textContent = `
      text{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
      .bml-node-box{fill:#fff;stroke:#dbe2ea;stroke-width:1.2}
      .bml-node-title{font-weight:600;font-size:13px;fill:#0f172a}
      .bml-node-tech{font-size:10.5px;fill:#7c8999}
      .bml-group-label{font-size:10.5px;font-weight:600;letter-spacing:.06em}
      .bml-edge-line{fill:none;stroke-width:1.6}
      .bml-edge-label{font-size:10.5px;fill:#5c6b7f}
      .bml-edge-label-bg{fill:#f7f8fa}
      .bml-edge-hit{display:none}
    `;
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

function placeLabel(
  geo: EdgeGeometry,
  width: number,
  height: number,
  obstacles: Rect[],
  placed: Rect[],
): PlacedLabel {
  const ts = [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74, 0.18, 0.82];
  const offsets = [0, -15, 15, -30, 30, -46, 46, -64, 64];
  for (const offset of offsets) {
    for (const t of ts) {
      const point = bezierAt(geo.p1, geo.control, geo.p2, t);
      const rect: Rect = { x: point.x - width / 2 - 5, y: point.y - height / 2 + offset, w: width + 10, h: height };
      let blocked = obstacles.some((o) => rectsHit(rect, o, 1));
      if (!blocked) blocked = placed.some((o) => rectsHit(rect, o, 1));
      if (!blocked) return { x: point.x, y: point.y + offset, t, offset, rect };
    }
  }
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
