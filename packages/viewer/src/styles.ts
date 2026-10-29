export const VIEWER_CSS = `
.bml-root{
  --bml-bg:#f7f8fa;
  --bml-panel:#ffffff;
  --bml-ink:#0f172a;
  --bml-ink-2:#475569;
  --bml-ink-3:#94a3b8;
  --bml-line:#e2e8f0;
  --bml-accent:#4f46e5;
  --bml-grid:#dfe5ec;
  --bml-label-bg:#f7f8fa;
  position:relative;
  display:flex;
  flex-direction:column;
  height:100%;
  min-height:0;
  background:var(--bml-bg);
  color:var(--bml-ink);
  font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  -webkit-font-smoothing:antialiased;
}
.bml-root[data-bml-theme="dark"]{
  --bml-bg:#0b1220;
  --bml-panel:#0f172a;
  --bml-ink:#e2e8f0;
  --bml-ink-2:#94a3b8;
  --bml-ink-3:#64748b;
  --bml-line:#1e293b;
  --bml-grid:#1b2637;
  --bml-label-bg:#0b1220;
}
.bml-svg{flex:1;width:100%;height:100%;display:block;touch-action:none;cursor:default}
.bml-root.bml-readonly .bml-node{cursor:default}
.bml-grid-dot{fill:var(--bml-grid)}
.bml-group-box{fill-opacity:.06;stroke-opacity:.3;stroke-width:1.2}
.bml-group-label{font:600 10.5px/1 inherit;letter-spacing:.06em;text-transform:uppercase}
.bml-node{cursor:grab}
.bml-node.bml-dragging{cursor:grabbing}
.bml-node-box{fill:var(--bml-panel);stroke:#dbe2ea;stroke-width:1.2;filter:url(#bml-node-shadow)}
.bml-root[data-bml-theme="dark"] .bml-node-box{stroke:#243146}
.bml-node:hover .bml-node-box{stroke:#b9c4d2}
.bml-node.bml-selected .bml-node-box{stroke:var(--bml-accent);stroke-width:2;filter:url(#bml-node-shadow-sel)}
.bml-node-title{font:600 13px/1 inherit;fill:var(--bml-ink);pointer-events:none}
.bml-node-tech{font:400 10.5px/1 inherit;fill:#7c8999;pointer-events:none}
.bml-edge{transition:opacity .12s ease}
.bml-focusing .bml-edge{opacity:.14}
.bml-focusing .bml-edge.bml-related{opacity:1}
.bml-focusing .bml-edge.bml-related .bml-edge-line{stroke-width:2.3}
.bml-focusing .bml-edge.bml-related .bml-edge-label{fill:var(--bml-ink);font-weight:600}
.bml-node{transition:opacity .12s ease}
.bml-focusing .bml-node:not(.bml-focus-node){opacity:.55}
.bml-edge-line{fill:none;stroke-width:1.6;pointer-events:none}
.bml-edge-hit{fill:none;stroke:transparent;stroke-width:16;cursor:pointer}
.bml-edge-label{font:500 10.5px/1 inherit;fill:#5c6b7f;pointer-events:none}
.bml-root[data-bml-theme="dark"] .bml-edge-label{fill:#93a3b8}
.bml-edge-label-bg{fill:var(--bml-label-bg);pointer-events:none}
.bml-edge.bml-selected .bml-edge-line{stroke-width:2.6}
.bml-edge.bml-selected{opacity:1}
.bml-edge.bml-selected .bml-edge-label{fill:var(--bml-ink);font-weight:600}
.bml-label-group{pointer-events:auto;cursor:pointer}
.bml-bend-handle{fill:var(--bml-panel);stroke:var(--bml-accent);stroke-width:2;cursor:move}
.bml-bend-line{stroke:var(--bml-accent);stroke-width:1;stroke-dasharray:3 3;fill:none;opacity:.5}
.bml-legend{
  position:absolute;left:14px;bottom:14px;display:flex;flex-wrap:wrap;gap:6px 12px;
  max-width:min(560px,60%);padding:9px 11px;font-size:11px;color:var(--bml-ink-2);
  background:color-mix(in srgb,var(--bml-panel) 92%,transparent);
  border:1px solid var(--bml-line);border-radius:10px;
  box-shadow:0 4px 16px rgba(15,23,42,.06);backdrop-filter:blur(6px);
}
.bml-legend b{font-weight:600;color:var(--bml-ink);font-size:10.5px;margin-right:2px}
.bml-legend .bml-item{display:inline-flex;align-items:center;gap:5px}
.bml-legend .bml-swatch{width:10px;height:10px;border-radius:3px;flex:0 0 auto}
.bml-hint{
  position:absolute;right:14px;bottom:14px;padding:6px 10px;font-size:11px;color:var(--bml-ink-3);
  background:color-mix(in srgb,var(--bml-panel) 90%,transparent);
  border:1px solid var(--bml-line);border-radius:8px;box-shadow:0 2px 10px rgba(15,23,42,.05);
}
.bml-hint kbd{
  font:500 10px/1 ui-monospace,monospace;background:var(--bml-bg);border:1px solid var(--bml-line);
  border-bottom-width:2px;border-radius:4px;padding:2px 4px;color:var(--bml-ink-2);
}
.bml-inspector{
  position:absolute;top:0;right:0;bottom:0;width:340px;display:flex;flex-direction:column;
  background:var(--bml-panel);border-left:1px solid var(--bml-line);
  box-shadow:-8px 0 24px rgba(15,23,42,.06);
  transform:translateX(100%);transition:transform .16s ease;z-index:5;
}
.bml-inspector.bml-open{transform:translateX(0)}
.bml-inspector-head{display:flex;align-items:flex-start;gap:8px;padding:14px 14px 10px;border-bottom:1px solid var(--bml-line)}
.bml-kind-dot{width:8px;height:8px;border-radius:3px;margin-top:5px;flex:0 0 auto}
.bml-inspector-head h2{margin:0;font-size:14px;font-weight:650;line-height:1.3;word-break:break-all;color:var(--bml-ink)}
.bml-inspector-meta{font-size:11.5px;color:var(--bml-ink-3);margin-top:3px;font-family:ui-monospace,monospace}
.bml-close{margin-left:auto;border:none;background:transparent;color:var(--bml-ink-3);cursor:pointer;font-size:16px;line-height:1;padding:2px 4px;border-radius:4px}
.bml-close:hover{background:var(--bml-bg);color:var(--bml-ink)}
.bml-inspector-body{padding:12px 14px 24px;overflow:auto;flex:1;font-size:12.5px;line-height:1.6;color:var(--bml-ink-2)}
.bml-inspector-body h3{font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--bml-ink-3);margin:16px 0 6px;font-weight:600}
.bml-inspector-body h3:first-child{margin-top:0}
.bml-inspector-body p{margin:0 0 8px;white-space:pre-wrap}
.bml-inspector-body code{font-family:ui-monospace,monospace;font-size:11px;background:var(--bml-bg);padding:1px 5px;border-radius:4px;color:var(--bml-ink-2);word-break:break-all}
.bml-edge-item{display:flex;gap:8px;align-items:flex-start;padding:7px 0;border-bottom:1px dashed var(--bml-line)}
.bml-edge-item:last-child{border-bottom:none}
.bml-edge-item .bml-arrow{font-family:ui-monospace,monospace;color:var(--bml-ink-3);font-size:11px;padding-top:1px}
.bml-edge-item .bml-t{font-size:12px;color:var(--bml-ink)}
.bml-edge-item .bml-l{font-size:11px;color:var(--bml-ink-3);font-family:ui-monospace,monospace;word-break:break-all}
.bml-error{
  position:absolute;left:14px;top:14px;max-width:min(560px,70%);padding:10px 12px;
  background:#fef2f2;border:1px solid #fecaca;border-radius:10px;color:#991b1b;
  font-size:11.5px;line-height:1.55;z-index:6;box-shadow:0 8px 24px rgba(153,27,27,.12);
}
.bml-error b{font-weight:650}
.bml-error code{font-family:ui-monospace,monospace;font-size:10.5px;background:#fee2e2;padding:0 4px;border-radius:3px}
`;
