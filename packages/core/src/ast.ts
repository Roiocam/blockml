export type Severity = "error" | "warning";

export interface Diagnostic {
  severity: Severity;
  code: string;
  message: string;
  line: number;
  column: number;
  hint?: string;
}

export interface Point {
  x: number;
  y: number;
}

export type ThemeName = "light" | "dark" | "auto";
export type Direction = "TB" | "LR";
/** Rendering choice for the viewer/app; not part of the document language. */
export type RouteStyle = "curve" | "orthogonal";

export interface DiagramDecl {
  type: "diagram";
  title: string | null;
  subtitle: string | null;
  theme: ThemeName;
  direction: Direction;
  version: string;
  line: number;
  extra: Record<string, unknown>;
}

export interface GroupDecl {
  type: "group";
  id: string;
  title: string;
  label: string | null;
  color: string | null;
  note: string | null;
  src: string | null;
  line: number;
  extra: Record<string, unknown>;
}

export interface NodeDecl {
  type: "node";
  id: string;
  title: string;
  label: string | null;
  group: string | null;
  kind: string;
  tech: string | null;
  at: Point | null;
  note: string | null;
  src: string | null;
  tags: string[];
  line: number;
  extra: Record<string, unknown>;
}

export interface EdgeDecl {
  type: "edge";
  id: string;
  from: string;
  to: string;
  title: string;
  label: string | null;
  kind: string;
  via: Point | null;
  dash: boolean | null;
  /** Edges sharing a bundle name are drawn as one trunk that branches out. */
  bundle: string | null;
  note: string | null;
  src: string | null;
  line: number;
  extra: Record<string, unknown>;
}

export interface Comment {
  line: number;
  text: string;
}

export interface BlockDocument {
  type: "document";
  version: string;
  diagram: DiagramDecl | null;
  groups: GroupDecl[];
  nodes: NodeDecl[];
  edges: EdgeDecl[];
  comments: Comment[];
}

export interface ParseResult {
  document: BlockDocument;
  diagnostics: Diagnostic[];
}

export function hasErrors(diagnostics: Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === "error");
}

export function nodeDisplayName(node: NodeDecl): string {
  return node.label ?? node.title ?? node.id;
}

export function edgeDisplayName(edge: EdgeDecl): string {
  return edge.label ?? edge.title ?? `${edge.from} -> ${edge.to}`;
}
