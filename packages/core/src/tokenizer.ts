import type { Diagnostic } from "./ast.js";

export type TokenType =
  | "ident"
  | "string"
  | "number"
  | "color"
  | "{"
  | "}"
  | "["
  | "]"
  | ":"
  | ","
  | "->"
  | ";"
  | "newline"
  | "eof";

export interface Token {
  type: TokenType;
  value: string;
  line: number;
  column: number;
  start: number;
  end: number;
}

const PUNCT = new Set(["{", "}", "[", "]", ":", ",", ";"]);

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function isIdentStart(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
}

function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || isDigit(ch) || ch === "." || ch === "-";
}

function isHex(ch: string): boolean {
  return isDigit(ch) || (ch >= "a" && ch <= "f") || (ch >= "A" && ch <= "F");
}

/**
 * `#` is overloaded: it starts a line comment, but it also starts a hex color.
 * Resolution rule (see spec §2.2): a `#` followed by exactly 3 or 6 hex digits
 * and then a delimiter is a color token; everything else is a comment.
 */
function readColor(cursor: number, src: string): string | null {
  let i = cursor + 1;
  while (i < src.length && isHex(src[i]!)) i++;
  const digits = src.slice(cursor + 1, i);
  if (digits.length !== 3 && digits.length !== 6) return null;
  const next = src[i];
  if (next !== undefined && !/[\s,}\];]/.test(next)) return null;
  return src.slice(cursor, i);
}

export function tokenize(src: string): { tokens: Token[]; diagnostics: Diagnostic[] } {
  const tokens: Token[] = [];
  const diagnostics: Diagnostic[] = [];
  let i = 0;
  let line = 1;
  let column = 1;

  const push = (type: TokenType, value: string, start: number, startLine: number, startColumn: number) => {
    tokens.push({ type, value, line: startLine, column: startColumn, start, end: i });
  };

  while (i < src.length) {
    const ch = src[i]!;

    if (ch === "\r") {
      i++;
      continue;
    }

    if (ch === "\n") {
      push("newline", "\n", i, line, column);
      i++;
      line++;
      column = 1;
      continue;
    }

    if (ch === " " || ch === "\t") {
      i++;
      column++;
      continue;
    }

    // comments
    if (ch === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }

    if (ch === "#") {
      const color = readColor(i, src);
      if (color) {
        const start = i;
        const startLine = line;
        const startColumn = column;
        i += color.length;
        column += color.length;
        push("color", color, start, startLine, startColumn);
        continue;
      }
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }

    // multi-line string
    if (ch === '"' && src.startsWith('"""', i)) {
      const start = i;
      const startLine = line;
      const startColumn = column;
      i += 3;
      column += 3;
      // skip an immediate newline after the opening delimiter
      if (src[i] === "\r") { i++; }
      if (src[i] === "\n") { i++; line++; column = 1; }
      const bodyStart = i;
      let closed = false;
      while (i < src.length) {
        if (src.startsWith('"""', i)) { closed = true; break; }
        if (src[i] === "\n") { line++; column = 1; i++; continue; }
        i++;
        column++;
      }
      if (!closed) {
        diagnostics.push({
          severity: "error",
          code: "BLK003",
          message: "多行字符串没有闭合（缺少结尾的 \"\"\"）",
          line: startLine,
          column: startColumn,
          hint: '补上结尾的 """，或改用单行双引号字符串',
        });
        break;
      }
      let body = src.slice(bodyStart, i);
      i += 3;
      column += 3;
      // drop the trailing newline before the closing delimiter
      if (body.endsWith("\n")) body = body.slice(0, -1);
      push("string", body, start, startLine, startColumn);
      continue;
    }

    // single-line string
    if (ch === '"') {
      const start = i;
      const startLine = line;
      const startColumn = column;
      i++;
      column++;
      let value = "";
      let closed = false;
      while (i < src.length) {
        const c = src[i]!;
        if (c === "\\") {
          const next = src[i + 1];
          if (next === undefined) break;
          if (next === "n") value += "\n";
          else if (next === "t") value += "\t";
          else if (next === '"') value += '"';
          else if (next === "\\") value += "\\";
          else value += next;
          i += 2;
          column += 2;
          continue;
        }
        if (c === '"') { closed = true; i++; column++; break; }
        if (c === "\n") break;
        value += c;
        i++;
        column++;
      }
      if (!closed) {
        diagnostics.push({
          severity: "error",
          code: "BLK003",
          message: "字符串没有闭合（缺少结尾的双引号）",
          line: startLine,
          column: startColumn,
          hint: '补上结尾的 "',
        });
        break;
      }
      push("string", value, start, startLine, startColumn);
      continue;
    }

    // arrow
    if (ch === "-" && src[i + 1] === ">") {
      const start = i;
      i += 2;
      column += 2;
      push("->", "->", start, line, column - 2);
      continue;
    }

    // number (with optional leading '-')
    if (isDigit(ch) || (ch === "-" && isDigit(src[i + 1] ?? ""))) {
      const start = i;
      const startLine = line;
      const startColumn = column;
      if (ch === "-") { i++; column++; }
      while (i < src.length && isDigit(src[i]!)) { i++; column++; }
      if (src[i] === "." && isDigit(src[i + 1] ?? "")) {
        i++; column++;
        while (i < src.length && isDigit(src[i]!)) { i++; column++; }
      }
      push("number", src.slice(start, i), start, startLine, startColumn);
      continue;
    }

    // identifier
    if (isIdentStart(ch)) {
      const start = i;
      const startLine = line;
      const startColumn = column;
      while (i < src.length && isIdentPart(src[i]!)) {
        // stop a trailing '-' when it starts an arrow
        if (src[i] === "-" && src[i + 1] === ">") break;
        i++;
        column++;
      }
      push("ident", src.slice(start, i), start, startLine, startColumn);
      continue;
    }

    if (PUNCT.has(ch)) {
      const start = i;
      i++;
      column++;
      push(ch as TokenType, ch, start, line, column - 1);
      continue;
    }

    diagnostics.push({
      severity: "error",
      code: "BLK001",
      message: `无法识别的字符 "${ch}"`,
      line,
      column,
      hint: "检查是否用了不支持的单引号或全角标点",
    });
    i++;
    column++;
  }

  tokens.push({ type: "eof", value: "", line, column, start: i, end: i });
  return { tokens, diagnostics };
}
