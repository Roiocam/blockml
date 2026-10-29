import type { BlockDocument, EdgeDecl, NodeDecl, Point } from "./ast.js";

function formatPoint(p: Point): string {
  const fmt = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));
  return `${fmt(p.x)}, ${fmt(p.y)}`;
}

/**
 * Find the line that closes the block opened on `openIndex`.
 * Handles `"""` strings, escapes and comments; returns null when unterminated.
 */
function findCloseLine(lines: string[], openIndex: number): number | null {
  let depth = 0;
  let inTriple = false;

  for (let i = openIndex; i < lines.length; i++) {
    const line = lines[i] ?? "";
    let inString = false;
    let j = 0;

    while (j < line.length) {
      if (inTriple) {
        if (line.startsWith('"""', j)) { inTriple = false; j += 3; continue; }
        j++;
        continue;
      }
      if (!inString && line.startsWith('"""', j)) { inTriple = true; j += 3; continue; }
      const ch = line[j]!;
      if (ch === '"') {
        if (!inString) inString = true;
        else if (line[j - 1] !== "\\") inString = false;
        j++;
        continue;
      }
      if (inString) { j++; continue; }
      if (ch === "#" || (ch === "/" && line[j + 1] === "/")) break;
      if (ch === "{") depth++;
      if (ch === "}") depth--;
      j++;
    }

    if (depth <= 0 && i >= openIndex) return i;
  }
  return null;
}

interface BlockRange {
  headIndex: number;
  openIndex: number | null;
  closeIndex: number | null;
  indent: string;
}

function findBlock(lines: string[], headLine: number): BlockRange {
  const headIndex = headLine - 1;
  const head = lines[headIndex] ?? "";
  const openIndex = head.includes("{") ? headIndex : null;
  if (openIndex === null) {
    return { headIndex, openIndex: null, closeIndex: null, indent: "  " };
  }

  const closeIndex = findCloseLine(lines, openIndex);
  let indent = "  ";
  if (closeIndex !== null) {
    for (let i = openIndex + 1; i < closeIndex; i++) {
      const match = /^(\s+)\S/.exec(lines[i] ?? "");
      if (match) { indent = match[1]!; break; }
    }
  }
  return { headIndex, openIndex, closeIndex, indent };
}

function replaceOrInsert(lines: string[], headLine: number, key: string, value: string): void {
  const range = findBlock(lines, headLine);
  const keyRe = new RegExp(`^(\\s*)${key}\\s*:`);

  if (range.closeIndex !== null) {
    for (let i = range.openIndex! + 1; i < range.closeIndex; i++) {
      const match = keyRe.exec(lines[i] ?? "");
      if (match) {
        lines[i] = `${match[1]}${key}: ${value}`;
        return;
      }
    }
    lines.splice(range.openIndex! + 1, 0, `${range.indent}${key}: ${value}`);
    return;
  }

  // Block-less declaration: expand it so the coordinate has somewhere to live.
  const head = (lines[range.headIndex] ?? "").replace(/\s+$/, "");
  lines[range.headIndex] = `${head} {`;
  lines.splice(range.headIndex + 1, 0, `  ${key}: ${value}`, "}");
}

export interface LayoutPatch {
  nodes?: Map<string, Point>;
  edges?: Map<string, Point>;
}

/**
 * Rewrite only `at:` / `via:` values in place. Comments, ordering and every
 * other property stay byte-identical (spec §7.4).
 */
export function applyLayout(source: string, document: BlockDocument, patch: LayoutPatch): string {
  const lines = source.split("\n");
  const byId = new Map(document.nodes.map((n) => [n.id, n]));
  const edgeById = new Map(document.edges.map((e) => [e.id, e]));

  type Job = { line: number; key: string; value: string };
  const jobs: Job[] = [];

  for (const [id, point] of patch.nodes ?? []) {
    const decl: NodeDecl | undefined = byId.get(id);
    if (decl) jobs.push({ line: decl.line, key: "at", value: formatPoint(point) });
  }
  for (const [id, point] of patch.edges ?? []) {
    const decl: EdgeDecl | undefined = edgeById.get(id);
    if (decl) jobs.push({ line: decl.line, key: "via", value: formatPoint(point) });
  }

  // Bottom-up so inserted lines never invalidate a not-yet-applied line number.
  jobs.sort((a, b) => b.line - a.line);
  for (const job of jobs) replaceOrInsert(lines, job.line, job.key, job.value);

  return lines.join("\n");
}

export function hasPersistedLayout(document: BlockDocument): boolean {
  return document.nodes.some((n) => n.at !== null);
}
