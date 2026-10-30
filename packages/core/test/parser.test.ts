import { describe, expect, it } from "vitest";
import { hasErrors, parse, serialize } from "../src/index.js";

const codes = (src: string) => parse(src).diagnostics.map((d) => d.code);
const doc = (src: string) => parse(src).document;

/** Line numbers legitimately move after reformatting; compare semantics only. */
function stripLines(document: ReturnType<typeof doc>) {
  const pick = <T extends { line: number }>(items: T[]) => items.map(({ line, ...rest }) => rest);
  return {
    version: document.version,
    diagram: document.diagram ? (({ line, ...rest }) => rest)(document.diagram) : null,
    groups: pick(document.groups),
    nodes: pick(document.nodes),
    edges: pick(document.edges),
  };
}

describe("structure", () => {
  it("parses an empty document", () => {
    const { document, diagnostics } = parse("");
    expect(diagnostics).toEqual([]);
    expect(document.nodes).toEqual([]);
    expect(document.edges).toEqual([]);
  });

  it("parses diagram block with title", () => {
    const d = doc(`diagram "架构图" {\n  subtitle: "副标题"\n  theme: dark\n}`);
    expect(d.diagram?.title).toBe("架构图");
    expect(d.diagram?.subtitle).toBe("副标题");
    expect(d.diagram?.theme).toBe("dark");
  });

  it("parses a block-less node", () => {
    const d = doc(`node app "后端"`);
    expect(d.nodes[0]?.id).toBe("app");
    expect(d.nodes[0]?.title).toBe("后端");
    expect(d.nodes[0]?.kind).toBe("service");
  });

  it("parses an empty block like a block-less declaration", () => {
    const d = doc(`node app "后端" { }`);
    expect(d.nodes[0]?.id).toBe("app");
  });

  it("allows a forward reference from edge to node", () => {
    const result = parse(`edge a -> b "调用"\n\nnode a "A"\nnode b "B"`);
    expect(hasErrors(result.diagnostics)).toBe(false);
    expect(result.document.edges).toHaveLength(1);
  });

  it("parses group membership", () => {
    const d = doc(`group core "核心" {\n  color: #4f46e5\n}\nnode a "A" {\n  group: core\n}`);
    expect(d.groups[0]?.color).toBe("#4f46e5");
    expect(d.nodes[0]?.group).toBe("core");
  });
});

describe("values", () => {
  it("parses pair, list, boolean, number and ident", () => {
    const d = doc(
      `node a "A" {\n  at: 340, 280\n  tags: [core, "big one"]\n}\n` +
        `edge a -> a "loop" {\n  dash: true\n  via: -12.5, 8\n}`,
    );
    expect(d.nodes[0]?.at).toEqual({ x: 340, y: 280 });
    expect(d.nodes[0]?.tags).toEqual(["core", "big one"]);
    expect(d.edges[0]?.dash).toBe(true);
    expect(d.edges[0]?.via).toEqual({ x: -12.5, y: 8 });
  });

  it("parses multi-line strings verbatim", () => {
    const source = `node a "A" {\n  note: """\n第一行\n  第二行\n"""\n}`;
    const d = doc(source);
    expect(d.nodes[0]?.note).toBe("第一行\n  第二行");
  });

  it("unescapes single-line strings", () => {
    const d = doc(`node a "A" {\n  note: "x\\ny\\"z"\n}`);
    expect(d.nodes[0]?.note).toBe('x\ny"z');
  });

  it("treats #hex as a color and # as a comment", () => {
    const d = doc(`# 这是注释\ngroup g "G" {\n  color: #abc\n}`);
    expect(d.groups[0]?.color).toBe("#abc");
    expect(d.comments).toHaveLength(1);
  });
});

describe("diagnostics", () => {
  it("reports duplicate node ids", () => {
    const d = parse(`node a "A"\nnode a "A again"`).diagnostics;
    expect(d.map((x) => x.code)).toEqual(["BLK004"]);
  });

  it("reports unknown group", () => {
    const result = parse(`node a "A" {\n  group: nope\n}`);
    expect(result.diagnostics.map((x) => x.code)).toContain("BLK008");
    expect(result.document.nodes[0]?.group).toBeNull();
  });

  it("reports missing edge endpoint", () => {
    const result = parse(`node a "A"\nedge a -> ghost "x"`);
    expect(result.diagnostics.map((x) => x.code)).toContain("BLK007");
  });

  it("downgrades unknown kind with a warning", () => {
    const result = parse(`node a "A" {\n  kind: quantum\n}`);
    expect(result.diagnostics.map((x) => x.code)).toEqual(["BLK009"]);
    expect(result.document.nodes[0]?.kind).toBe("ext");
    expect(hasErrors(result.diagnostics)).toBe(false);
  });

  it("warns on unknown property but keeps the document usable", () => {
    const result = parse(`node a "A" {\n  colour: red\n}`);
    expect(result.diagnostics.map((x) => x.code)).toEqual(["BLK005"]);
    expect(hasErrors(result.diagnostics)).toBe(false);
  });

  it("treats route as a viewer option, not a document key", () => {
    const result = parse(`diagram { route: orthogonal }`);
    expect(result.diagnostics.map((x) => x.code)).toEqual(["BLK005"]);
    expect(result.diagnostics[0]?.hint).toContain("--route");
    expect(result.document.diagram && "route" in result.document.diagram).toBe(false);
    expect(serialize(result.document)).not.toContain("route");
  });

  it("keeps x- extension properties", () => {
    const d = doc(`node a "A" {\n  x-owner: "team-x"\n}`);
    expect(d.nodes[0]?.extra).toEqual({ "x-owner": "team-x" });
  });

  it("reports unclosed blocks", () => {
    expect(codes(`node a "A" {\n  kind: service`)).toContain("BLK002");
  });

  it("reports unterminated strings", () => {
    expect(codes(`node a "A {\n}`)).toContain("BLK003");
  });

  it("reports unknown top-level keywords", () => {
    expect(codes(`table users {`)).toEqual(["BLK001"]);
  });

  it("warns when version is newer than supported", () => {
    const result = parse(`diagram {\n  version: "2.0"\n}`);
    expect(result.diagnostics.map((x) => x.code)).toEqual(["BLK010"]);
  });

  it("records line numbers for errors", () => {
    const result = parse(`node a "A"\nnode b "B" {\n  group: missing\n}`);
    const diag = result.diagnostics.find((x) => x.code === "BLK008");
    expect(diag?.line).toBe(2);
  });
});

describe("serialize", () => {
  const sample = `diagram "示例" {
  title: "示例"
  theme: dark
}

group core "核心" {
  color: #4f46e5
}

node app "后端" {
  group: core
  kind: service
  tech: "Spring Boot"
  at: 340, 280
  note: """
多行
说明"""
  src: "docs/README.md:1"
  tags: [java, core]
}

edge app -> app "自环" {
  kind: acp
  via: -20, 0
}
`;

  it("round-trips without losing semantics", () => {
    const first = parse(sample);
    expect(hasErrors(first.diagnostics)).toBe(false);
    const text = serialize(first.document);
    const second = parse(text);
    expect(hasErrors(second.diagnostics)).toBe(false);
    expect(stripLines(second.document)).toEqual(stripLines(first.document));
  });

  it("is stable after the first normalization", () => {
    const once = serialize(parse(sample).document);
    const twice = serialize(parse(once).document);
    expect(twice).toBe(once);
  });

  it("folds label into the block head", () => {
    const text = serialize(parse(`node a "A" {\n  label: "显示名"\n}`).document);
    expect(text).toContain('node a "显示名"');
    expect(text).not.toContain("label:");
  });
});
