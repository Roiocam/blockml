import type {
  BlockDocument,
  Comment,
  Diagnostic,
  DiagramDecl,
  EdgeDecl,
  GroupDecl,
  NodeDecl,
  ParseResult,
  Point,
  ThemeName,
  Direction,
} from "./ast.js";
import { tokenize } from "./tokenizer.js";
import type { Token } from "./tokenizer.js";
import {
  DEFAULT_EDGE_KIND,
  DEFAULT_NODE_KIND,
  EDGE_KINDS,
  FALLBACK_EDGE_KIND,
  FALLBACK_NODE_KIND,
  NODE_KINDS,
} from "./kinds.js";

type Value =
  | { type: "string"; value: string; line: number }
  | { type: "number"; value: number; line: number }
  | { type: "boolean"; value: boolean; line: number }
  | { type: "ident"; value: string; line: number }
  | { type: "color"; value: string; line: number }
  | { type: "pair"; value: [number, number]; line: number }
  | { type: "list"; value: Value[]; line: number };

const NODE_ATTRS = new Set(["group", "kind", "label", "tech", "at", "note", "src", "tags"]);
const EDGE_ATTRS = new Set(["kind", "label", "via", "dash", "bundle", "note", "src"]);
const GROUP_ATTRS = new Set(["color", "label", "note", "src"]);
const DIAGRAM_ATTRS = new Set(["title", "subtitle", "theme", "direction", "version"]);

const COLOR_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

class Parser {
  private tokens: Token[];
  private pos = 0;
  private diagnostics: Diagnostic[] = [];
  private comments: Comment[] = [];

  constructor(source: string, comments: Comment[]) {
    const result = tokenize(source);
    this.tokens = result.tokens;
    this.diagnostics.push(...result.diagnostics);
    this.comments.push(...comments);
  }

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)]!;
  }

  private next(): Token {
    const t = this.peek();
    if (t.type !== "eof") this.pos++;
    return t;
  }

  private skipNewlines(): void {
    while (this.peek().type === "newline" || this.peek().type === ";") this.next();
  }

  private error(code: string, message: string, token: Token, hint?: string): void {
    const d: Diagnostic = {
      severity: "error",
      code,
      message,
      line: token.line,
      column: token.column,
    };
    if (hint) d.hint = hint;
    this.diagnostics.push(d);
  }

  private warn(code: string, message: string, token: Token, hint?: string): void {
    const d: Diagnostic = {
      severity: "warning",
      code,
      message,
      line: token.line,
      column: token.column,
    };
    if (hint) d.hint = hint;
    this.diagnostics.push(d);
  }

  private skipToLineEnd(): void {
    while (this.peek().type !== "newline" && this.peek().type !== "eof") this.next();
  }

  parse(): ParseResult {
    const document: BlockDocument = {
      type: "document",
      version: "1.0",
      diagram: null,
      groups: [],
      nodes: [],
      edges: [],
      comments: this.comments,
    };

    const groupIds = new Set<string>();
    const nodeIds = new Set<string>();

    while (true) {
      this.skipNewlines();
      const token = this.peek();
      if (token.type === "eof") break;

      if (token.type !== "ident") {
        this.error("BLK001", `期望一个块（diagram / group / node / edge），实际是 "${token.value || token.type}"`, token, "顶层只能是这四个关键字之一");
        this.skipToLineEnd();
        continue;
      }

      switch (token.value) {
        case "diagram": {
          this.next();
          const title = this.peek().type === "string" ? this.next().value : null;
          const props = this.parseBlock("diagram");
          if (document.diagram) {
            this.warn("BLK004", "重复的 diagram 块，只保留第一个", token);
            break;
          }
          document.diagram = this.buildDiagram(title, props, token);
          break;
        }
        case "group": {
          this.next();
          const idToken = this.peek();
          if (idToken.type !== "ident") {
            this.error("BLK011", "group 缺少 id", idToken, '写法：group <id> "标题" { … }');
            this.skipToLineEnd();
            break;
          }
          this.next();
          const title = this.peek().type === "string" ? this.next().value : null;
          const props = this.parseBlock("group");
          if (groupIds.has(idToken.value)) {
            this.error("BLK004", `group id 重复：${idToken.value}`, idToken, "同一个 id 只能声明一次");
            break;
          }
          groupIds.add(idToken.value);
          document.groups.push(this.buildGroup(idToken, title, props));
          break;
        }
        case "node": {
          this.next();
          const idToken = this.peek();
          if (idToken.type !== "ident") {
            this.error("BLK011", "node 缺少 id", idToken, '写法：node <id> "标题" { … }');
            this.skipToLineEnd();
            break;
          }
          this.next();
          const title = this.peek().type === "string" ? this.next().value : null;
          const props = this.parseBlock("node");
          if (nodeIds.has(idToken.value)) {
            this.error("BLK004", `node id 重复：${idToken.value}`, idToken, "同一个 id 只能声明一次");
            break;
          }
          nodeIds.add(idToken.value);
          document.nodes.push(this.buildNode(idToken, title, props));
          break;
        }
        case "edge": {
          this.next();
          const fromToken = this.peek();
          if (fromToken.type !== "ident") {
            this.error("BLK011", "edge 缺少起点 id", fromToken, '写法：edge <from> -> <to> "标签" { … }');
            this.skipToLineEnd();
            break;
          }
          this.next();
          if (this.peek().type !== "->") {
            this.error("BLK001", 'edge 缺少 "->"', this.peek(), '两个节点之间用 -> 连接');
            this.skipToLineEnd();
            break;
          }
          this.next();
          const toToken = this.peek();
          if (toToken.type !== "ident") {
            this.error("BLK011", "edge 缺少终点 id", toToken, '写法：edge <from> -> <to> "标签" { … }');
            this.skipToLineEnd();
            break;
          }
          this.next();
          const title = this.peek().type === "string" ? this.next().value : null;
          const props = this.parseBlock("edge");
          document.edges.push(this.buildEdge(fromToken, toToken, title, props, document.edges.length));
          break;
        }
        default: {
          this.error("BLK001", `未知的顶层块 "${token.value}"`, token, "可用：diagram / group / node / edge");
          this.skipToLineEnd();
        }
      }
    }

    this.validate(document);
    return { document, diagnostics: this.diagnostics };
  }

  private parseBlock(kind: "diagram" | "group" | "node" | "edge"): Map<string, Value> {
    const props = new Map<string, Value>();
    this.skipNewlines();
    if (this.peek().type !== "{") return props;
    this.next();

    while (true) {
      this.skipNewlines();
      const token = this.peek();
      if (token.type === "}") { this.next(); break; }
      if (token.type === "eof") {
        this.error("BLK002", `块没有闭合：${kind}`, token, "补上 }");
        break;
      }
      if (token.type !== "ident") {
        this.error("BLK001", `期望属性名，实际是 "${token.value || token.type}"`, token);
        this.skipToLineEnd();
        continue;
      }
      this.next();
      const key = token.value;
      if (this.peek().type !== ":") {
        this.error("BLK001", `属性 "${key}" 后面缺少冒号`, this.peek(), "写法：key: value");
        this.skipToLineEnd();
        continue;
      }
      this.next();
      const value = this.parseValue();
      if (!value) {
        this.skipToLineEnd();
        continue;
      }
      if (props.has(key)) {
        this.warn("BLK005", `属性 "${key}" 重复，保留最后一个`, token);
      }
      props.set(key, value);
      const after = this.peek();
      // Properties may be separated by a newline, `;` or `,` — the latter lets
      // small blocks stay on one line: node a "A" { kind: db, group: core }
      if (after.type === "," || after.type === ";") {
        this.next();
        continue;
      }
      if (after.type !== "newline" && after.type !== "}" && after.type !== "eof") {
        this.error("BLK001", `属性 "${key}" 的值后面有多余内容`, after, "属性之间用换行、分号或逗号分隔");
        this.skipToLineEnd();
      }
    }
    return props;
  }

  private parseValue(): Value | null {
    const token = this.peek();

    if (token.type === "string") {
      this.next();
      return { type: "string", value: token.value, line: token.line };
    }

    if (token.type === "color") {
      this.next();
      return { type: "color", value: token.value, line: token.line };
    }

    if (token.type === "number") {
      this.next();
      const first = Number(token.value);
      if (this.peek().type === ",") {
        const save = this.pos;
        this.next();
        const second = this.peek();
        if (second.type === "number") {
          this.next();
          return { type: "pair", value: [first, Number(second.value)], line: token.line };
        }
        this.pos = save;
      }
      return { type: "number", value: first, line: token.line };
    }

    if (token.type === "[") {
      this.next();
      const items: Value[] = [];
      while (true) {
        this.skipInline();
        if (this.peek().type === "]") { this.next(); break; }
        if (this.peek().type === "eof" || this.peek().type === "newline") {
          this.error("BLK006", "列表没有闭合", token, "补上 ]");
          break;
        }
        const item = this.parseValue();
        if (!item) break;
        items.push(item);
        this.skipInline();
        if (this.peek().type === ",") { this.next(); continue; }
      }
      return { type: "list", value: items, line: token.line };
    }

    if (token.type === "ident") {
      this.next();
      if (token.value === "true") return { type: "boolean", value: true, line: token.line };
      if (token.value === "false") return { type: "boolean", value: false, line: token.line };
      return { type: "ident", value: token.value, line: token.line };
    }

    this.error("BLK006", `无法识别的值 "${token.value || token.type}"`, token);
    return null;
  }

  private skipInline(): void {
    // lists keep everything on one logical line; newlines inside are tolerated
    while (this.peek().type === "newline") this.next();
  }

  private collectExtra(
    props: Map<string, Value>,
    allowed: Set<string>,
    block: string,
    anchor: Token,
  ): Record<string, unknown> {
    const extra: Record<string, unknown> = {};
    for (const [key, value] of props) {
      if (allowed.has(key)) continue;
      if (key.startsWith("x-")) {
        extra[key] = toPlain(value);
        continue;
      }
      this.warn(
        "BLK005",
        `${block} 不支持属性 "${key}"，已忽略`,
        { ...anchor, line: value.line, column: anchor.column },
        `可用属性：${[...allowed].join(", ")}；自定义扩展请加 x- 前缀`,
      );
    }
    return extra;
  }

  private buildDiagram(title: string | null, props: Map<string, Value>, anchor: Token): DiagramDecl {
    const routeValue = props.get("route");
    if (routeValue) {
      this.warn(
        "BLK005",
        `diagram 不支持属性 "route"，已忽略`,
        { ...anchor, line: routeValue.line, column: anchor.column },
        "走线风格是查看器选项：在工具条切换曲线/正交，或在 CLI 加 --route orthogonal",
      );
      props.delete("route");
    }
    const extra = this.collectExtra(props, DIAGRAM_ATTRS, "diagram", anchor);
    const themeRaw = asIdent(props.get("theme")) ?? "light";
    const theme: ThemeName = themeRaw === "dark" || themeRaw === "auto" ? themeRaw : "light";
    const directionRaw = (asIdent(props.get("direction")) ?? "TB").toUpperCase();
    const direction: Direction = directionRaw === "LR" ? "LR" : "TB";
    return {
      type: "diagram",
      title: asString(props.get("title")) ?? title,
      subtitle: asString(props.get("subtitle")),
      theme,
      direction,
      version: asString(props.get("version")) ?? "1.0",
      line: anchor.line,
      extra,
    };
  }

  private buildGroup(anchor: Token, title: string | null, props: Map<string, Value>): GroupDecl {
    const extra = this.collectExtra(props, GROUP_ATTRS, "group", anchor);
    const color = asColor(props.get("color"));
    if (props.has("color") && !color) {
      this.error("BLK012", "group.color 必须是 #rgb 或 #rrggbb", { ...anchor, line: props.get("color")!.line }, '例如 color: #4f46e5');
    }
    return {
      type: "group",
      id: anchor.value,
      title: title ?? anchor.value,
      label: asString(props.get("label")),
      color,
      note: asString(props.get("note")),
      src: asString(props.get("src")),
      line: anchor.line,
      extra,
    };
  }

  private buildNode(anchor: Token, title: string | null, props: Map<string, Value>): NodeDecl {
    const extra = this.collectExtra(props, NODE_ATTRS, "node", anchor);
    let kind = asIdent(props.get("kind")) ?? DEFAULT_NODE_KIND;
    if (!NODE_KINDS[kind]) {
      this.warn(
        "BLK009",
        `未知的 node kind "${kind}"，按 ${FALLBACK_NODE_KIND} 渲染`,
        { ...anchor, line: props.get("kind")?.line ?? anchor.line },
        `内置 kind：${Object.keys(NODE_KINDS).join(", ")}`,
      );
      kind = FALLBACK_NODE_KIND;
    }
    const at = asPair(props.get("at"));
    if (props.has("at") && !at) {
      this.error("BLK006", "node.at 必须是 x, y 两个数字", { ...anchor, line: props.get("at")!.line }, "例如 at: 340, 280");
    }
    return {
      type: "node",
      id: anchor.value,
      title: title ?? anchor.value,
      label: asString(props.get("label")),
      group: asIdent(props.get("group")),
      kind,
      tech: asString(props.get("tech")),
      at,
      note: asString(props.get("note")),
      src: asString(props.get("src")),
      tags: asStringList(props.get("tags")),
      line: anchor.line,
      extra,
    };
  }

  private buildEdge(from: Token, to: Token, title: string | null, props: Map<string, Value>, index: number): EdgeDecl {
    const extra = this.collectExtra(props, EDGE_ATTRS, "edge", from);
    let kind = asIdent(props.get("kind")) ?? DEFAULT_EDGE_KIND;
    if (!EDGE_KINDS[kind]) {
      this.warn(
        "BLK009",
        `未知的 edge kind "${kind}"，按 ${FALLBACK_EDGE_KIND} 渲染`,
        { ...from, line: props.get("kind")?.line ?? from.line },
        `内置 kind：${Object.keys(EDGE_KINDS).join(", ")}`,
      );
      kind = FALLBACK_EDGE_KIND;
    }
    const via = asPair(props.get("via"));
    if (props.has("via") && !via) {
      this.error("BLK006", "edge.via 必须是 dx, dy 两个数字", { ...from, line: props.get("via")!.line }, "例如 via: -30, 0");
    }
    const dash = asBool(props.get("dash"));
    const bundle = asString(props.get("bundle")) ?? asIdent(props.get("bundle"));
    return {
      type: "edge",
      id: `e${index + 1}`,
      from: from.value,
      to: to.value,
      title: title ?? "",
      label: asString(props.get("label")) ?? title,
      kind,
      via,
      dash,
      bundle,
      note: asString(props.get("note")),
      src: asString(props.get("src")),
      line: from.line,
      extra,
    };
  }

  private validate(document: BlockDocument): void {
    const groupIds = new Set(document.groups.map((g) => g.id));
    const nodeIds = new Set(document.nodes.map((n) => n.id));

    for (const node of document.nodes) {
      if (node.group && !groupIds.has(node.group)) {
        this.diagnostics.push({
          severity: "error",
          code: "BLK008",
          message: `node "${node.id}" 引用了未声明的 group "${node.group}"`,
          line: node.line,
          column: 1,
          hint: `先声明 group ${node.group} "…" { … }，或去掉这条引用`,
        });
        node.group = null;
      }
    }

    for (const edge of document.edges) {
      if (!nodeIds.has(edge.from)) {
        this.diagnostics.push({
          severity: "error",
          code: "BLK007",
          message: `edge 起点 "${edge.from}" 不存在`,
          line: edge.line,
          column: 1,
          hint: "检查 node id 拼写，或先声明该节点",
        });
      }
      if (!nodeIds.has(edge.to)) {
        this.diagnostics.push({
          severity: "error",
          code: "BLK007",
          message: `edge 终点 "${edge.to}" 不存在`,
          line: edge.line,
          column: 1,
          hint: "检查 node id 拼写，或先声明该节点",
        });
      }
    }

    const version = document.diagram?.version ?? "1.0";
    const major = Number(version.split(".")[0]);
    if (!Number.isFinite(major) || major > 1) {
      this.diagnostics.push({
        severity: "warning",
        code: "BLK010",
        message: `文件声明 version "${version}"，当前实现支持 1.x，已按 1.0 解析`,
        line: document.diagram?.line ?? 1,
        column: 1,
      });
    }
    document.version = version;
  }
}

function toPlain(value: Value): unknown {
  if (value.type === "list") return value.value.map(toPlain);
  if (value.type === "pair") return [value.value[0], value.value[1]];
  return value.value;
}

function asString(value: Value | undefined): string | null {
  if (!value) return null;
  if (value.type === "string" || value.type === "ident" || value.type === "color") return value.value;
  if (value.type === "number") return String(value.value);
  if (value.type === "boolean") return String(value.value);
  return null;
}

function asIdent(value: Value | undefined): string | null {
  if (!value) return null;
  if (value.type === "ident" || value.type === "string") return value.value;
  return null;
}

function asColor(value: Value | undefined): string | null {
  if (!value) return null;
  if (value.type === "color" && COLOR_RE.test(value.value)) return value.value;
  if (value.type === "string" && COLOR_RE.test(value.value)) return value.value;
  return null;
}

function asPair(value: Value | undefined): Point | null {
  if (!value || value.type !== "pair") return null;
  return { x: value.value[0], y: value.value[1] };
}

function asBool(value: Value | undefined): boolean | null {
  if (!value) return null;
  return value.type === "boolean" ? value.value : null;
}

function asStringList(value: Value | undefined): string[] {
  if (!value || value.type !== "list") return [];
  return value.value
    .map((item) => (item.type === "string" || item.type === "ident" ? item.value : null))
    .filter((item): item is string => item !== null);
}

/** Collect `#` / `//` comment lines with their original line numbers. */
function collectComments(source: string): Comment[] {
  const comments: Comment[] = [];
  source.split("\n").forEach((raw, index) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    if (trimmed.startsWith("//")) {
      comments.push({ line: index + 1, text: trimmed });
      return;
    }
    if (trimmed.startsWith("#") && !/^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?(\s|$)/.test(trimmed)) {
      comments.push({ line: index + 1, text: trimmed });
    }
  });
  return comments;
}

export function parse(source: string): ParseResult {
  const parser = new Parser(source, collectComments(source));
  return parser.parse();
}
