export interface KindStyle {
  color: string;
  label: string;
  dash?: string;
}

export const NODE_KINDS: Record<string, KindStyle> = {
  service: { color: "#4f46e5", label: "服务" },
  ui: { color: "#64748b", label: "界面" },
  db: { color: "#10b981", label: "数据库" },
  cache: { color: "#ef4444", label: "缓存" },
  idp: { color: "#f59e0b", label: "身份" },
  acp: { color: "#0ea5e9", label: "执行面 / ACP" },
  model: { color: "#14b8a6", label: "模型网关" },
  channel: { color: "#ec4899", label: "渠道" },
  ext: { color: "#8b5cf6", label: "外部服务" },
};

export const EDGE_KINDS: Record<string, KindStyle> = {
  rest: { color: "#6366f1", label: "HTTP", dash: "" },
  acp: { color: "#0ea5e9", label: "ACP", dash: "" },
  sse: { color: "#0ea5e9", label: "SSE", dash: "7 4" },
  sql: { color: "#10b981", label: "SQL", dash: "" },
  rpc: { color: "#8b5cf6", label: "RPC", dash: "" },
  oidc: { color: "#f59e0b", label: "OIDC", dash: "6 4" },
  llm: { color: "#14b8a6", label: "LLM", dash: "" },
  mcp: { color: "#64748b", label: "MCP", dash: "5 4" },
  ws: { color: "#ec4899", label: "长连接", dash: "6 4" },
  gate: { color: "#f43f5e", label: "准入闸门", dash: "2 4" },
  opt: { color: "#94a3b8", label: "可选", dash: "4 4" },
};

export const DEFAULT_NODE_KIND = "service";
export const FALLBACK_NODE_KIND = "ext";
export const DEFAULT_EDGE_KIND = "rest";
export const FALLBACK_EDGE_KIND = "opt";

/** Group frames without an explicit color cycle through this palette. */
export const GROUP_PALETTE = [
  "#f59e0b",
  "#4f46e5",
  "#0ea5e9",
  "#10b981",
  "#ec4899",
  "#8b5cf6",
  "#64748b",
];

export function nodeKindStyle(kind: string): KindStyle {
  return NODE_KINDS[kind] ?? NODE_KINDS[FALLBACK_NODE_KIND]!;
}

export function edgeKindStyle(kind: string): KindStyle {
  return EDGE_KINDS[kind] ?? EDGE_KINDS[FALLBACK_EDGE_KIND]!;
}
