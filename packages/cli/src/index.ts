import { readFile, writeFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, extname, join, resolve } from "node:path";
import { applyLayout, hasErrors, layoutDocument, parse, serialize, LAYOUT_ALGORITHMS, LAYOUT_LABELS } from "@block-ml/core";
import type { Diagnostic, LayoutAlgorithm, RouteStyle } from "@block-ml/core";
import { renderStandaloneHTML, VIEWER_CSS } from "@block-ml/viewer";

const require = createRequire(import.meta.url);

const HELP = `blockml — diagram-as-code for architecture maps

用法
  blockml validate <file...>                 校验语法与引用
  blockml render <file> [-o out.html]        生成可双击的单文件阅读器
  blockml fmt <file> [--write]               规范化（会丢弃注释，加 --write 才落盘）
  blockml layout <file> [--algo <name>] [--write]
                                             用算法重排并回写 at 坐标
  blockml inspect <file>                     打印结构摘要

选项
  -o, --out <path>       输出路径（默认同名 .html）
      --title <text>     阅读器标题（默认取 diagram.title / 文件名）
      --theme <light|dark>
      --readonly         只读：禁止拖动写回
      --route <style>    打开时的走线预设：curve | orthogonal（覆盖文件里的 legacy route）
      --algo <name>      layout 算法：layered | pipeline | snowflake | compact
  -h, --help

示例
  blockml render examples/order-platform.blockml -o out/order-platform.html
  blockml validate examples/*.blockml`;

interface Args {
  command: string;
  files: string[];
  out?: string;
  title?: string;
  theme?: "light" | "dark";
  readOnly?: boolean;
  write?: boolean;
  algo?: string;
  route?: string;
  help?: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { command: "", files: [] };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "-h" || token === "--help") args.help = true;
    else if (token === "-o" || token === "--out") args.out = argv[++i];
    else if (token === "--title") args.title = argv[++i];
    else if (token === "--theme") args.theme = argv[++i] === "dark" ? "dark" : "light";
    else if (token === "--readonly") args.readOnly = true;
    else if (token === "--write") args.write = true;
    else if (token === "--algo") args.algo = argv[++i];
    else if (token === "--route") args.route = argv[++i];
    else if (token.startsWith("-")) throw new Error(`未知选项：${token}`);
    else rest.push(token);
  }
  args.command = rest.shift() ?? "";
  args.files = rest;
  return args;
}

function formatDiagnostic(file: string, diagnostic: Diagnostic): string {
  const level = diagnostic.severity === "error" ? "error" : "warn ";
  const head = `  ${level} ${file}:${diagnostic.line}:${diagnostic.column}  ${diagnostic.code}  ${diagnostic.message}`;
  return diagnostic.hint ? `${head}\n        hint: ${diagnostic.hint}` : head;
}

async function validateFile(file: string): Promise<{ ok: boolean; lines: string[] }> {
  let source: string;
  try {
    source = await readFile(file, "utf8");
  } catch {
    return { ok: false, lines: [`  error ${file}  文件不存在或不可读`] };
  }
  const { document, diagnostics } = parse(source);
  const errors = diagnostics.filter((d) => d.severity === "error");
  const warnings = diagnostics.filter((d) => d.severity === "warning");
  const lines = diagnostics.map((d) => formatDiagnostic(file, d));

  if (errors.length) {
    return { ok: false, lines };
  }
  const summary = `${document.nodes.length} nodes · ${document.edges.length} edges · ${document.groups.length} groups`;
  const suffix = warnings.length ? `（${warnings.length} 条 warning）` : "";
  return { ok: true, lines: [`  ✓ ${file}  ${summary}${suffix}`, ...lines] };
}

async function cmdValidate(files: string[]): Promise<number> {
  if (!files.length) {
    console.error("需要至少一个文件");
    return 2;
  }
  let failed = 0;
  for (const file of files) {
    const result = await validateFile(file);
    if (!result.ok) failed++;
    console.log(result.lines.join("\n"));
  }
  return failed ? 1 : 0;
}

async function cmdRender(args: Args): Promise<number> {
  const file = args.files[0];
  if (!file) {
    console.error("render 需要一个 .blockml 文件");
    return 2;
  }

  let source: string;
  try {
    source = await readFile(file, "utf8");
  } catch {
    console.error(`读不到文件：${file}`);
    return 2;
  }

  const { document, diagnostics } = parse(source);
  const errors = diagnostics.filter((d) => d.severity === "error");
  for (const diagnostic of diagnostics) console.error(formatDiagnostic(file, diagnostic));
  if (errors.length) {
    console.error(`\n有 ${errors.length} 个 error，未生成 HTML。`);
    return 1;
  }

  let route: RouteStyle | undefined;
  if (args.route) {
    if (args.route !== "curve" && args.route !== "orthogonal") {
      console.error(`未知走线预设：${args.route}，可用：curve | orthogonal`);
      return 2;
    }
    route = args.route;
  }

  const out = args.out
    ? resolve(args.out)
    : join(dirname(resolve(file)), basename(file, extname(file)) + ".html");

  const iifePath = require.resolve("@block-ml/viewer/iife");
  const viewerScript = await readFile(iifePath, "utf8");

  const html = renderStandaloneHTML({
    source,
    title: args.title ?? document.diagram?.title ?? basename(file, extname(file)),
    theme: args.theme ?? (document.diagram?.theme === "dark" ? "dark" : "light"),
    viewerScript,
    viewerCss: VIEWER_CSS,
    mode: "presentation",
    route,
    readOnly: args.readOnly ?? false,
  });

  await writeFile(out, html, "utf8");
  const size = (await stat(out)).size;
  console.log(`✓ ${out}  ${(size / 1024).toFixed(1)} KB`);
  return 0;
}

async function cmdFmt(args: Args): Promise<number> {
  const file = args.files[0];
  if (!file) {
    console.error("fmt 需要一个 .blockml 文件");
    return 2;
  }
  const source = await readFile(file, "utf8");
  const { document, diagnostics } = parse(source);
  if (hasErrors(diagnostics)) {
    for (const diagnostic of diagnostics) console.error(formatDiagnostic(file, diagnostic));
    return 1;
  }
  const next = serialize(document);
  if (args.write) {
    await writeFile(file, next, "utf8");
    console.log(`✓ 已重写 ${file}`);
  } else {
    process.stdout.write(next);
  }
  return 0;
}

async function cmdLayout(args: Args): Promise<number> {
  const file = args.files[0];
  if (!file) {
    console.error("layout 需要一个 .blockml 文件");
    return 2;
  }
  const algo = (args.algo ?? "layered") as LayoutAlgorithm;
  if (!LAYOUT_ALGORITHMS.includes(algo)) {
    console.error(`未知算法：${algo}，可用：${LAYOUT_ALGORITHMS.join(", ")}`);
    return 2;
  }

  const source = await readFile(file, "utf8");
  const { document, diagnostics } = parse(source);
  if (hasErrors(diagnostics)) {
    for (const diagnostic of diagnostics) console.error(formatDiagnostic(file, diagnostic));
    return 1;
  }

  const positions = layoutDocument(document, algo);
  const next = applyLayout(source, document, { nodes: positions });
  if (args.write) {
    await writeFile(file, next, "utf8");
    console.log(`✓ ${file}  ${LAYOUT_LABELS[algo]}  · ${positions.size} 个节点已重排`);
  } else {
    process.stdout.write(next);
  }
  return 0;
}

async function cmdInspect(args: Args): Promise<number> {
  const file = args.files[0];
  if (!file) {
    console.error("inspect 需要一个 .blockml 文件");
    return 2;
  }
  const source = await readFile(file, "utf8");
  const { document, diagnostics } = parse(source);
  if (hasErrors(diagnostics)) {
    for (const diagnostic of diagnostics) console.error(formatDiagnostic(file, diagnostic));
    return 1;
  }
  const byKind = new Map<string, number>();
  for (const node of document.nodes) byKind.set(node.kind, (byKind.get(node.kind) ?? 0) + 1);

  console.log(`文件    ${file}`);
  console.log(`标题    ${document.diagram?.title ?? "（无）"}`);
  console.log(`规模    ${document.nodes.length} nodes · ${document.edges.length} edges · ${document.groups.length} groups`);
  console.log(`节点    ${[...byKind].map(([kind, count]) => `${kind}×${count}`).join("  ")}`);
  const missingAt = document.nodes.filter((n) => !n.at).length;
  console.log(`坐标    ${document.nodes.length - missingAt} 个已固定 · ${missingAt} 个待自动布局`);
  const missingSrc = document.nodes.filter((n) => !n.src).length;
  console.log(`出处    ${document.nodes.length - missingSrc} 个节点带 src · ${missingSrc} 个缺`);
  return 0;
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error((error as Error).message);
    console.error(HELP);
    return 2;
  }

  if (args.help || !args.command) {
    console.log(HELP);
    return args.command ? 0 : 2;
  }

  switch (args.command) {
    case "validate":
      return cmdValidate(args.files);
    case "render":
      return cmdRender(args);
    case "fmt":
      return cmdFmt(args);
    case "layout":
      return cmdLayout(args);
    case "inspect":
      return cmdInspect(args);
    default:
      console.error(`未知命令：${args.command}\n`);
      console.log(HELP);
      return 2;
  }
}

main().then((code) => {
  process.exitCode = code;
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
