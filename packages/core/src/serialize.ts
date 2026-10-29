import type { BlockDocument, EdgeDecl, GroupDecl, NodeDecl, Point } from "./ast.js";

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

function isBareIdent(value: string): boolean {
  if (!IDENT_RE.test(value)) return false;
  return value !== "true" && value !== "false";
}

function quote(value: string): string {
  if (value.includes("\n")) {
    return '"""\n' + value.replace(/\n$/, "") + "\n" + '"""';
  }
  return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

function pair(p: Point): string {
  const fmt = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));
  return `${fmt(p.x)}, ${fmt(p.y)}`;
}

function blockHead(keyword: string, id: string | null, title: string | null): string {
  const parts: string[] = [keyword];
  if (id) parts.push(id);
  if (title && title !== id) parts.push(quote(title));
  return parts.join(" ");
}

function renderBody(properties: string[]): string[] {
  if (!properties.length) return [];
  return [" {", ...properties.map((line) => "  " + line), "}"];
}

function nodeLines(node: NodeDecl): string[] {
  const props: string[] = [];
  if (node.group) props.push(`group: ${node.group}`);
  if (node.kind) props.push(`kind: ${node.kind}`);
  if (node.tech) props.push(`tech: ${quote(node.tech)}`);
  if (node.at) props.push(`at: ${pair(node.at)}`);
  if (node.note) props.push(`note: ${quote(node.note)}`);
  if (node.src) props.push(`src: ${quote(node.src)}`);
  if (node.tags.length) props.push(`tags: [${node.tags.map((t) => (isBareIdent(t) ? t : quote(t))).join(", ")}]`);
  for (const [key, value] of Object.entries(node.extra)) {
    props.push(`${key}: ${serializeExtra(value)}`);
  }
  const head = blockHead("node", node.id, node.label ?? node.title);
  const body = renderBody(props);
  return body.length ? [head + body[0]!, ...body.slice(1)] : [head];
}

function edgeLines(edge: EdgeDecl): string[] {
  const props: string[] = [];
  props.push(`kind: ${edge.kind}`);
  if (edge.via && (edge.via.x !== 0 || edge.via.y !== 0)) props.push(`via: ${pair(edge.via)}`);
  if (edge.dash !== null) props.push(`dash: ${edge.dash}`);
  if (edge.bundle) props.push(`bundle: ${/^[A-Za-z_][\w.-]*$/.test(edge.bundle) ? edge.bundle : quote(edge.bundle)}`);
  if (edge.note) props.push(`note: ${quote(edge.note)}`);
  if (edge.src) props.push(`src: ${quote(edge.src)}`);
  for (const [key, value] of Object.entries(edge.extra)) {
    props.push(`${key}: ${serializeExtra(value)}`);
  }
  const label = edge.label ?? edge.title;
  const head = `edge ${edge.from} -> ${edge.to}${label ? " " + quote(label) : ""}`;
  const body = renderBody(props);
  return body.length ? [head + body[0]!, ...body.slice(1)] : [head];
}

function groupLines(group: GroupDecl): string[] {
  const props: string[] = [];
  if (group.color) props.push(`color: ${group.color}`);
  if (group.note) props.push(`note: ${quote(group.note)}`);
  if (group.src) props.push(`src: ${quote(group.src)}`);
  for (const [key, value] of Object.entries(group.extra)) {
    props.push(`${key}: ${serializeExtra(value)}`);
  }
  const head = blockHead("group", group.id, group.label ?? group.title);
  const body = renderBody(props);
  return body.length ? [head + body[0]!, ...body.slice(1)] : [head];
}

function serializeExtra(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(serializeExtra).join(", ")}]`;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return String(value);
  const text = String(value);
  return isBareIdent(text) ? text : quote(text);
}

export function serialize(doc: BlockDocument): string {
  const sections: string[][] = [];

  const diagram = doc.diagram;
  if (diagram) {
    const props: string[] = [];
    if (diagram.title) props.push(`title: ${quote(diagram.title)}`);
    if (diagram.subtitle) props.push(`subtitle: ${quote(diagram.subtitle)}`);
    if (diagram.theme !== "light") props.push(`theme: ${diagram.theme}`);
    if (diagram.direction !== "TB") props.push(`direction: ${diagram.direction}`);
    if (diagram.route !== "curve") props.push(`route: ${diagram.route}`);
    if (diagram.version !== "1.0") props.push(`version: ${quote(diagram.version)}`);
    for (const [key, value] of Object.entries(diagram.extra)) {
      props.push(`${key}: ${serializeExtra(value)}`);
    }
    const body = renderBody(props);
    sections.push(body.length ? ["diagram" + body[0]!, ...body.slice(1)] : ["diagram"]);
  }

  if (doc.groups.length) sections.push(...doc.groups.map(groupLines));
  if (doc.nodes.length) sections.push(...doc.nodes.map(nodeLines));
  if (doc.edges.length) sections.push(...doc.edges.map(edgeLines));

  return sections.map((lines) => lines.join("\n")).join("\n\n") + "\n";
}
