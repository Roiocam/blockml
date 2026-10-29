export interface StandaloneOptions {
  source: string;
  title?: string;
  theme?: "light" | "dark";
  /** IIFE bundle that assigns `globalThis.BlockML`. */
  viewerScript: string;
  viewerCss: string;
  readOnly?: boolean;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/** Wrap a `.blockml` document into a self-contained, double-clickable HTML file. */
export function renderStandaloneHTML(options: StandaloneOptions): string {
  const title = options.title ?? "BlockML";
  const theme = options.theme ?? "light";
  const readOnly = options.readOnly ?? false;
  const script = options.viewerScript.replace(/<\/script/gi, "<\\/script");
  const sourceJson = jsonForScript(options.source);

  return `<!doctype html>
<html lang="zh-CN" data-bml-theme="${theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  html,body{margin:0;height:100%;background:${theme === "dark" ? "#0b1220" : "#f7f8fa"}}
  #blockml-app{height:100%}
  #blockml-bar{
    position:absolute;top:0;left:0;right:0;height:44px;display:flex;align-items:center;gap:10px;
    padding:0 14px;z-index:20;font:500 12px/1 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;
    color:${theme === "dark" ? "#94a3b8" : "#475569"};
    background:${theme === "dark" ? "rgba(11,18,32,.86)" : "rgba(255,255,255,.86)"};
    border-bottom:1px solid ${theme === "dark" ? "#1e293b" : "#e2e8f0"};
    backdrop-filter:blur(8px);
  }
  #blockml-bar .grow{flex:1}
  #blockml-bar .name{font-weight:650;color:${theme === "dark" ? "#e2e8f0" : "#0f172a"};font-size:12.5px}
  #blockml-bar .badge{font:500 10px/1 ui-monospace,monospace;padding:3px 6px;border-radius:5px;
    background:${theme === "dark" ? "#1e293b" : "#f1f5f9"};color:${theme === "dark" ? "#94a3b8" : "#64748b"}}
  #blockml-bar button{
    appearance:none;border:1px solid ${theme === "dark" ? "#1e293b" : "#e2e8f0"};
    background:${theme === "dark" ? "#0f172a" : "#fff"};
    color:${theme === "dark" ? "#cbd5e1" : "#475569"};
    font:500 11.5px/1 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;
    padding:6px 9px;border-radius:6px;cursor:pointer;
  }
  #blockml-bar button:hover{filter:brightness(.97)}
  #blockml-bar select{
    appearance:none;border:1px solid ${theme === "dark" ? "#1e293b" : "#e2e8f0"};
    background:${theme === "dark" ? "#0f172a" : "#fff"};
    color:${theme === "dark" ? "#cbd5e1" : "#475569"};
    font:500 11.5px/1 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;
    padding:6px 22px 6px 9px;border-radius:6px;cursor:pointer;
    background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='6' viewBox='0 0 8 6'%3E%3Cpath d='M1 1l3 3 3-3' fill='none' stroke='%2394a3b8' stroke-width='1.4' stroke-linecap='round'/%3E%3C/svg%3E");
    background-repeat:no-repeat;background-position:right 7px center;
  }
  #blockml-app{position:relative;padding-top:44px}
  #blockml-mount{position:absolute;inset:44px 0 0 0}
${options.viewerCss}
</style>
</head>
<body>
<div id="blockml-app">
  <div id="blockml-bar">
    <span class="name">${escapeHtml(title)}</span>
    <span class="badge">.blockml</span>
    <span class="grow"></span>
    <select id="blockml-layout" title="重新排列（会覆盖手工坐标）">
      <option value="">手工布局</option>
      <option value="layered">从左到右</option>
      <option value="pipeline">Pipeline</option>
      <option value="snowflake">雪花形</option>
      <option value="compact">紧凑型</option>
    </select>
    <button data-act="fit">适应窗口</button>
    <button data-act="zoom-in">＋</button>
    <button data-act="zoom-out">－</button>
    <button data-act="download">下载源码</button>
  </div>
  <div id="blockml-mount"></div>
</div>
<script id="blockml-source" type="application/json">${sourceJson}</script>
<script>${script}</script>
<script>
(function(){
  var source = JSON.parse(document.getElementById("blockml-source").textContent);
  var handle = BlockML.mount(document.getElementById("blockml-mount"), {
    source: source,
    theme: "${theme}",
    readOnly: ${readOnly}
  });
  // Expose the handle for debugging and for embedding pages that want to script it.
  window.blockmlViewer = handle;
  window.__blockmlGetSource = function(){ return handle.getSource(); };
  var actions = {
    "fit": function(){ handle.fit(); },
    "zoom-in": function(){ handle.zoomTo(handle.getView().k * 1.25); },
    "zoom-out": function(){ handle.zoomTo(handle.getView().k / 1.25); },
    "download": function(){
      var blob = new Blob([handle.getSource()], {type: "text/plain;charset=utf-8"});
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = ${jsonForScript(title.replace(/[^\w.-]+/g, "-").toLowerCase() + ".blockml")};
      a.click();
      setTimeout(function(){ URL.revokeObjectURL(a.href); }, 1000);
    }
  };
  document.getElementById("blockml-layout").addEventListener("change", function(event){
    var algorithm = event.target.value;
    if (!algorithm) return;
    handle.layout(algorithm);
  });
  document.getElementById("blockml-bar").addEventListener("click", function(event){
    var button = event.target.closest("button[data-act]");
    if (!button) return;
    var fn = actions[button.getAttribute("data-act")];
    if (fn) fn();
  });
})();
</script>
</body>
</html>
`;
}
