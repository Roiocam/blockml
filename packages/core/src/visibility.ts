import type { BlockDocument, EdgeDecl, GroupDecl, NodeDecl } from "./ast.js";

/**
 * View-only visibility. Nothing here is persisted: the `.blockml` file stays
 * the single source of truth, hiding/collapsing only changes what is drawn.
 */
export interface VisibilityOptions {
  hiddenNodes?: Iterable<string>;
  hiddenGroups?: Iterable<string>;
  /** Members are hidden, but the group frame stays as a compact chip. */
  collapsedGroups?: Iterable<string>;
}

export interface Visibility {
  hiddenNodes: Set<string>;
  hiddenGroups: Set<string>;
  collapsedGroups: Set<string>;
}

export function resolveVisibility(options?: VisibilityOptions): Visibility {
  return {
    hiddenNodes: new Set(options?.hiddenNodes ?? []),
    hiddenGroups: new Set(options?.hiddenGroups ?? []),
    collapsedGroups: new Set(options?.collapsedGroups ?? []),
  };
}

export function isNodeVisible(node: NodeDecl, visibility: Visibility): boolean {
  if (visibility.hiddenNodes.has(node.id)) return false;
  if (!node.group) return true;
  return !visibility.hiddenGroups.has(node.group) && !visibility.collapsedGroups.has(node.group);
}

/** A node is only visible when both the node and its group allow it. */
export function visibleNodes(document: BlockDocument, visibility: Visibility): NodeDecl[] {
  return document.nodes.filter((node) => isNodeVisible(node, visibility));
}

/** An edge collapses as soon as either endpoint is hidden. */
export function visibleEdges(document: BlockDocument, visibility: Visibility): EdgeDecl[] {
  const ids = new Set(visibleNodes(document, visibility).map((node) => node.id));
  return document.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
}

/** Hidden groups drop out entirely; collapsed ones stay so the viewer can draw their chip. */
export function visibleGroups(document: BlockDocument, visibility: Visibility): GroupDecl[] {
  return document.groups.filter((group) => !visibility.hiddenGroups.has(group.id));
}

/** Edges with at least one endpoint in the group — the folded-away count on a collapsed chip. */
export function groupEdgeCount(document: BlockDocument, groupId: string): number {
  const members = new Set(
    document.nodes.filter((node) => node.group === groupId).map((node) => node.id),
  );
  let count = 0;
  for (const edge of document.edges) {
    if (members.has(edge.from) || members.has(edge.to)) count++;
  }
  return count;
}
