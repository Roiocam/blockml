import { describe, expect, it } from "vitest";
import {
  groupEdgeCount,
  isNodeVisible,
  parse,
  resolveVisibility,
  visibleEdges,
  visibleGroups,
  visibleNodes,
} from "../src/index.js";

const source = `group access "接入" { color: #f59e0b }
group core "核心" { color: #4f46e5 }
group data "数据" { color: #10b981 }

node web "web" { group: access }
node gw "gateway" { group: access }
node order "order" { group: core }
node pay "payment" { group: core }
node pg "PostgreSQL" { group: data }
node cron "cron" { kind: service }

edge web -> gw "https"
edge gw -> order "rest"
edge order -> pay "rest"
edge order -> pg "sql"
edge pay -> pg "sql"
edge cron -> order "trigger"
`;

const document = parse(source).document;

function ids(items: { id: string }[]): string[] {
  return items.map((item) => item.id).sort();
}

describe("visibility", () => {
  it("shows everything by default", () => {
    const visibility = resolveVisibility();
    expect(visibleNodes(document, visibility)).toHaveLength(document.nodes.length);
    expect(visibleEdges(document, visibility)).toHaveLength(document.edges.length);
    expect(visibleGroups(document, visibility)).toHaveLength(document.groups.length);
  });

  it("hiding a node also hides its edges", () => {
    const visibility = resolveVisibility({ hiddenNodes: ["order"] });
    expect(ids(visibleNodes(document, visibility))).toEqual(["cron", "gw", "pay", "pg", "web"]);
    // e1 (web->gw) and e5 (pay->pg) never touch the hidden node.
    expect(visibleEdges(document, visibility).map((e) => e.id)).toEqual(["e1", "e5"]);
    expect(isNodeVisible(document.nodes.find((n) => n.id === "order")!, visibility)).toBe(false);
  });

  it("hiding a group hides its members and their edges", () => {
    const visibility = resolveVisibility({ hiddenGroups: ["core"] });
    const nodes = ids(visibleNodes(document, visibility));
    expect(nodes).toEqual(["cron", "gw", "pg", "web"]);
    expect(visibleEdges(document, visibility).map((e) => e.id)).toEqual(["e1"]);
    expect(ids(visibleGroups(document, visibility))).toEqual(["access", "data"]);
  });

  it("collapsing a group hides members but keeps the group chip", () => {
    const visibility = resolveVisibility({ collapsedGroups: ["core"] });
    expect(ids(visibleNodes(document, visibility))).toEqual(["cron", "gw", "pg", "web"]);
    expect(ids(visibleGroups(document, visibility))).toEqual(["access", "core", "data"]);
  });

  it("an explicitly hidden node stays hidden when its group expands", () => {
    const visibility = resolveVisibility({ hiddenNodes: ["pay"] });
    expect(ids(visibleNodes(document, visibility))).toContain("order");
    expect(ids(visibleNodes(document, visibility))).not.toContain("pay");
  });

  it("unknown ids do not break anything", () => {
    const visibility = resolveVisibility({
      hiddenNodes: ["nope"],
      hiddenGroups: ["ghost"],
      collapsedGroups: ["phantom"],
    });
    expect(visibleNodes(document, visibility)).toHaveLength(document.nodes.length);
    expect(visibleGroups(document, visibility)).toHaveLength(document.groups.length);
  });

  it("counts folded edges per group", () => {
    // core owns order/pay: web->gw is unrelated; gw->order, order->pay,
    // order->pg, pay->pg, cron->order all touch the group.
    expect(groupEdgeCount(document, "core")).toBe(5);
    expect(groupEdgeCount(document, "data")).toBe(2);
    expect(groupEdgeCount(document, "missing")).toBe(0);
  });
});
