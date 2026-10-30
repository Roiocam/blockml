import { describe, expect, it } from "vitest";
import { renderStandaloneHTML, type StandaloneOptions } from "../src/standalone.js";
import type { ViewerVisibility } from "../src/viewer.js";

const SCRIPT = "globalThis.BlockML = { mount: function(){ return {}; } };";

function base(overrides: Partial<StandaloneOptions> = {}): StandaloneOptions {
  return {
    source: 'node api "api-gateway" {}',
    title: "订单平台",
    theme: "light",
    viewerScript: SCRIPT,
    viewerCss: ".bml-root{color:red}",
    ...overrides,
  };
}

function jsonBlock(html: string, id: string): string | null {
  const match = new RegExp(`<script id="${id}" type="application/json">([\\s\\S]*?)</script>`).exec(html);
  return match?.[1] ?? null;
}

describe("renderStandaloneHTML", () => {
  it("restores the initial visibility after mounting", () => {
    const visibility: ViewerVisibility = {
      hiddenNodes: ["pay"],
      hiddenGroups: ["data"],
      collapsedGroups: ["ops"],
    };
    const html = renderStandaloneHTML(base({ visibility }));

    const embedded = jsonBlock(html, "blockml-visibility");
    expect(embedded).not.toBeNull();
    expect(JSON.parse(embedded!)).toEqual(visibility);
    expect(html).toContain("handle.setHiddenNodes(initial.hiddenNodes)");
    expect(html).toContain("handle.setHiddenGroups(initial.hiddenGroups)");
    expect(html).toContain("handle.setCollapsedGroups(initial.collapsedGroups)");
  });

  it("omits the visibility snapshot when no view state is supplied", () => {
    const html = renderStandaloneHTML(base());
    expect(jsonBlock(html, "blockml-visibility")).toBeNull();
  });

  it("derives a usable download name from a non-ASCII title", () => {
    const html = renderStandaloneHTML(base({ title: "订单平台 · 架构示例" }));
    expect(html).toContain('"订单平台-架构示例.blockml"');
  });

  it("falls back to a plain download name when the title has no word characters", () => {
    const html = renderStandaloneHTML(base({ title: "···" }));
    expect(html).toContain('"blockml.blockml"');
  });

  it("opens as a presentation without editing chrome", () => {
    const html = renderStandaloneHTML(base());
    expect(html).toContain('data-mode="presentation"');
    expect(html).toContain('mode: "presentation"');
    expect(html).toContain('data-act="mode"');
    expect(html).toContain("setMode");
  });

  it("honours an editing preset", () => {
    const html = renderStandaloneHTML(base({ mode: "editing" }));
    expect(html).toContain('data-mode="editing"');
    expect(html).toContain('mode: "editing"');
  });

  it("embeds the route preset", () => {
    const html = renderStandaloneHTML(base({ route: "orthogonal" }));
    expect(html).toContain('route: "orthogonal"');
  });

  it("hides the mode toggle for read-only exports", () => {
    const html = renderStandaloneHTML(base({ readOnly: true }));
    expect(html).not.toContain('<button data-act="mode"');
  });

  it("keeps hostile source and title text inside their own script blocks", () => {
    const html = renderStandaloneHTML(
      base({
        source: 'node a "A</script><script>alert(1)</script>" { note: "x\u2028y" }',
        title: '"><img src=x onerror=alert(1)>',
      }),
    );

    expect(html).not.toContain("</script><script>alert(1)");
    expect(html).toContain("\\u003c/script");
    expect(html).toContain("&quot;&gt;&lt;img");
    expect(html).toContain("\\u2028");
  });
});
