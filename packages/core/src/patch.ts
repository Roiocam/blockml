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

const IDENT_CH = /[A-Za-z0-9_$]/;

/** The `}` matching the `{` at `open`, skipping quoted text; null when the line ends first. */
function inlineBlockEnd(line: string, open: number): number | null {
  let depth = 0;
  let inString = false;
  for (let i = open; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return null;
}

/** Replace `key: 12, 34` written inline inside the block's opening line. */
function replaceInlinePair(line: string, key: string, value: string): string | null {
  const open = line.indexOf("{");
  if (open < 0) return null;
  const end = inlineBlockEnd(line, open) ?? line.length;
  let inString = false;
  for (let i = open + 1; i < end; i++) {
    const ch = line[i]!;
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "#" || (ch === "/" && line[i + 1] === "/")) break;
    if (!line.startsWith(key, i)) continue;
    if (IDENT_CH.test(line[i - 1] ?? "") || IDENT_CH.test(line[i + key.length] ?? "")) continue;
    let j = i + key.length;
    while (line[j] === " " || line[j] === "\t") j++;
    if (line[j] !== ":") continue;
    j++;
    const match = /^\s*-?[\d.]+(?:\s*,\s*-?[\d.]+)?/.exec(line.slice(j));
    if (!match) continue;
    return line.slice(0, j) + ` ${value}` + line.slice(j + match[0].length);
  }
  return null;
}

/** Add a missing key inside a block that opens and closes on one line. */
function insertInlinePair(line: string, key: string, value: string): string | null {
  const open = line.indexOf("{");
  if (open < 0) return null;
  const close = inlineBlockEnd(line, open);
  if (close === null) return null;
  const head = line.slice(0, close).replace(/\s+$/, "");
  const tail = line.slice(close);
  const separator = head.endsWith("{") ? " " : ", ";
  return `${head}${separator}${key}: ${value} ${tail}`;
}

function replaceOrInsert(lines: string[], headLine: number, key: string, value: string): void {
  const range = findBlock(lines, headLine);
  const keyRe = new RegExp(`^(\\s*)${key}\\s*:`);

  if (range.openIndex !== null) {
    const inline = replaceInlinePair(lines[range.openIndex] ?? "", key, value);
    if (inline !== null) {
      lines[range.openIndex] = inline;
      return;
    }
  }

  if (range.openIndex !== null && range.closeIndex !== null && range.closeIndex > range.openIndex) {
    for (let i = range.openIndex + 1; i < range.closeIndex; i++) {
      const match = keyRe.exec(lines[i] ?? "");
      if (match) {
        lines[i] = `${match[1]}${key}: ${value}`;
        return;
      }
    }
    lines.splice(range.openIndex + 1, 0, `${range.indent}${key}: ${value}`);
    return;
  }

  // A block written on one line has nowhere to insert a new line, so the key
  // goes inside the braces: `{ kind: db }` -> `{ kind: db, at: 5, 6 }`.
  if (range.openIndex !== null && range.closeIndex === range.openIndex) {
    const inserted = insertInlinePair(lines[range.openIndex] ?? "", key, value);
    if (inserted !== null) {
      lines[range.openIndex] = inserted;
      return;
    }
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
