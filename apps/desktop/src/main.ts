import { mount, renderStandaloneHTML, VIEWER_CSS, type ViewerHandle } from "@block-ml/viewer";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import viewerScript from "virtual:blockml-viewer-iife";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const EMPTY_SOURCE = `diagram {
  title: "BlockML"
}
`;

// Used only when the frontend is opened in a plain browser (`pnpm dev` without Tauri).
const PREVIEW_SOURCE = `diagram {
  title: "浏览器预览"
}

group core "核心" {
  color: #4f46e5
}

node api "api-service" {
  group: core
  kind: service
  tech: "本地预览不读写文件"
  at: 120, 120
}

node db "PostgreSQL" {
  group: core
  kind: db
  tech: "预览节点"
  at: 460, 120
}

edge api -> db "JDBC" {
  kind: sql
}
`;

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing #${id}`);
  return element as T;
};

const canvas = byId<HTMLElement>("canvas");
const fileLabel = byId<HTMLElement>("file");
const statusLabel = byId<HTMLElement>("status");
const emptyOverlay = byId<HTMLElement>("empty");
const dropOverlay = byId<HTMLElement>("drop");
const banner = byId<HTMLElement>("banner");
const bannerText = byId<HTMLElement>("banner-text");
const recentMenu = byId<HTMLElement>("recent-menu");
const exportMenu = byId<HTMLElement>("export-menu");
const autoSaveInput = byId<HTMLInputElement>("autosave");
const themeButton = byId<HTMLButtonElement>("theme");

const FILTERS = [{ name: "BlockML", extensions: ["blockml"] }];

let viewer: ViewerHandle;
let currentPath: string | null = null;
let source = EMPTY_SOURCE;
let dirty = false;
let savedAt: Date | null = null;
let saveTimer: number | undefined;
let externalSource: string | null = null;
let autoSave = localStorage.getItem("blockml.autosave") !== "0";
let theme: "light" | "dark" = initialTheme();
type RouteStyle = "curve" | "orthogonal";
let route: RouteStyle = localStorage.getItem("blockml.route") === "orthogonal" ? "orthogonal" : "curve";
let mode: "presentation" | "editing" = "editing";

autoSaveInput.checked = autoSave;

/* ------------------------------------------------------------------ theme */

function initialTheme(): "light" | "dark" {
  const stored = localStorage.getItem("blockml.theme");
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(next: "light" | "dark"): void {
  theme = next;
  document.documentElement.dataset.theme = next;
  localStorage.setItem("blockml.theme", next);
  themeButton.textContent = next === "dark" ? "浅色" : "深色";
  document.querySelector(".bml-root")?.setAttribute("data-bml-theme", next);
}

applyTheme(theme);

/* ------------------------------------------------------------------ files */

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function suggestName(extension = "blockml"): string {
  const name = currentPath ? baseName(currentPath) : "untitled.blockml";
  return extension === "blockml" ? name : name.replace(/\.blockml$/i, `.${extension}`);
}

function updateChrome(): void {
  fileLabel.textContent = currentPath ? baseName(currentPath) : "未打开文件";
  fileLabel.title = currentPath ?? "";
  if (!isTauri) {
    statusLabel.textContent = "浏览器预览 · 无文件读写";
    statusLabel.classList.remove("dirty");
  } else if (dirty) {
    statusLabel.textContent = "未保存";
    statusLabel.classList.add("dirty");
  } else if (savedAt) {
    statusLabel.textContent = `已保存 ${savedAt.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
    statusLabel.classList.remove("dirty");
  } else {
    statusLabel.textContent = currentPath ? "已打开" : "";
    statusLabel.classList.remove("dirty");
  }
  const name = currentPath ? baseName(currentPath) : "BlockML";
  if (isTauri) {
    // Window APIs reject synchronously outside Tauri; never let chrome updates break binding.
    try {
      void getCurrentWindow()
        .setTitle(`${dirty ? "● " : ""}${name} — BlockML`)
        .catch(() => {});
    } catch {
      /* browser preview */
    }
  }
}

function showEmpty(visible: boolean): void {
  emptyOverlay.classList.toggle("hidden", !visible);
}

function showBanner(message: string): void {
  bannerText.textContent = message;
  banner.classList.remove("hidden");
}

function hideBanner(): void {
  banner.classList.add("hidden");
  externalSource = null;
}

function loadFile(path: string, text: string): void {
  currentPath = path;
  source = text;
  dirty = false;
  savedAt = null;
  hideBanner();
  showEmpty(false);
  const layoutSelect = document.getElementById("layout");
  if (layoutSelect instanceof HTMLSelectElement) layoutSelect.value = "";
  viewer.update(text);
  updateChrome();
  watchCurrent();
  pushRecent(path);
}

async function openFile(path?: string): Promise<void> {
  if (!isTauri) {
    statusLabel.textContent = "请在桌面应用内打开文件";
    return;
  }
  const picked = path ?? (await openDialog({ title: "打开 BlockML", multiple: false, filters: FILTERS }));
  if (!picked || Array.isArray(picked)) return;
  try {
    loadFile(picked, await invoke<string>("read_file", { path: picked }));
  } catch (error) {
    showBanner(`打开失败：${String(error)}`);
  }
}

async function saveNow(forceDialog = false): Promise<void> {
  if (!isTauri) return;
  let target = currentPath;
  if (!target || forceDialog) {
    const picked = await saveDialog({
      title: "保存 BlockML",
      defaultPath: suggestName(),
      filters: FILTERS,
    });
    if (!picked || Array.isArray(picked)) return;
    target = picked;
  }
  try {
    await invoke("write_file", { path: target, contents: source });
    currentPath = target;
    dirty = false;
    savedAt = new Date();
    hideBanner();
    updateChrome();
    watchCurrent();
    pushRecent(target);
  } catch (error) {
    showBanner(`保存失败：${String(error)}`);
  }
}

function scheduleSave(): void {
  if (!autoSave || !currentPath) return;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void saveNow(), 700);
}

function watchCurrent(): void {
  if (!isTauri || !currentPath) return;
  void invoke("watch_file", { path: currentPath }).catch(() => {});
}

/* ----------------------------------------------------------------- recent */

function recentFiles(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem("blockml.recent") ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function pushRecent(path: string): void {
  const next = [path, ...recentFiles().filter((item) => item !== path)].slice(0, 8);
  localStorage.setItem("blockml.recent", JSON.stringify(next));
}

function renderRecentMenu(): void {
  recentMenu.replaceChildren();
  const items = recentFiles();
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "menu-empty";
    empty.textContent = "还没有打开过文件";
    recentMenu.appendChild(empty);
    return;
  }
  for (const path of items) {
    const button = document.createElement("button");
    button.dataset.path = path;
    button.title = path;
    const label = document.createElement("span");
    label.className = "menu-path";
    label.textContent = baseName(path);
    button.appendChild(label);
    recentMenu.appendChild(button);
  }
}

/* ----------------------------------------------------------------- export */

async function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("SVG 渲染失败"));
    image.src = url;
  });
}

async function rasterizePng(svg: string): Promise<string> {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const image = await loadImage(url);
    const scale = Math.min(2, 4096 / Math.max(image.width, image.height, 1));
    const surface = document.createElement("canvas");
    surface.width = Math.max(1, Math.round(image.width * scale));
    surface.height = Math.max(1, Math.round(image.height * scale));
    const context = surface.getContext("2d");
    if (!context) throw new Error("无法创建画布");
    context.fillStyle = theme === "dark" ? "#0b1220" : "#f7f8fa";
    context.fillRect(0, 0, surface.width, surface.height);
    context.drawImage(image, 0, 0, surface.width, surface.height);
    return surface.toDataURL("image/png").split(",")[1] ?? "";
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function exportAs(kind: "svg" | "png" | "html"): Promise<void> {
  if (!isTauri) return;
  const picked = await saveDialog({
    title: `导出 ${kind.toUpperCase()}`,
    defaultPath: suggestName(kind),
    filters: [{ name: kind.toUpperCase(), extensions: [kind] }],
  });
  if (!picked || Array.isArray(picked)) return;
  try {
    if (kind === "svg") {
      await invoke("write_file", { path: picked, contents: viewer.toSVG() });
    } else if (kind === "png") {
      await invoke("write_binary", { path: picked, base64Data: await rasterizePng(viewer.toSVG()) });
    } else {
      await invoke("write_file", { path: picked, contents: buildExportHTML() });
    }
    showBanner(`已导出 ${baseName(picked)}`);
  } catch (error) {
    showBanner(`导出失败：${String(error)}`);
  }
}

/** Self-contained reader: current source, theme and view state, interactive like the CLI output. */
function buildExportHTML(): string {
  const title = viewer.getDocument()?.diagram?.title
    ?? (currentPath ? baseName(currentPath).replace(/\.blockml$/i, "") : "BlockML");
  return renderStandaloneHTML({
    source: viewer.getSource(),
    title,
    theme,
    viewerScript,
    viewerCss: VIEWER_CSS,
    visibility: viewer.getVisibility(),
    mode: "presentation",
    readOnly: false,
    route: viewer.getRoute(),
  });
}

/* ------------------------------------------------------------------ viewer */

viewer = mount(canvas, {
  source: isTauri ? EMPTY_SOURCE : PREVIEW_SOURCE,
  theme,
  route,
  onSourceChange(next) {
    source = next;
    if (!isTauri) return;
    dirty = true;
    updateChrome();
    scheduleSave();
  },
});

showEmpty(isTauri ? currentPath === null : false);
updateChrome();

/* --------------------------------------------------------------- commands */

function handleMenu(id: string): void {
  if (id === "open") void openFile();
  else if (id === "save") void saveNow();
  else if (id === "save-as") void saveNow(true);
  else if (id === "export-html") void exportAs("html");
  else if (id === "export-svg") void exportAs("svg");
  else if (id === "export-png") void exportAs("png");
  else if (id === "fit") viewer.fit();
  else if (id === "reload" && currentPath) void openFile(currentPath);
}

function bindEvents(): void {
  byId("open").addEventListener("click", () => void openFile());
  byId("empty-open").addEventListener("click", () => void openFile());
  byId("save").addEventListener("click", () => void saveNow());
  byId("save-as").addEventListener("click", () => void saveNow(true));
  byId("fit").addEventListener("click", () => viewer.fit());
  byId("layers").addEventListener("click", () => viewer.toggleLayers());
  byId("zoom-in").addEventListener("click", () => viewer.zoomTo(viewer.getView().k * 1.25));
  byId("zoom-out").addEventListener("click", () => viewer.zoomTo(viewer.getView().k / 1.25));
  byId<HTMLSelectElement>("layout").addEventListener("change", (event) => {
    const algorithm = (event.target as HTMLSelectElement).value;
    if (!algorithm) return;
    viewer.layout(algorithm as Parameters<ViewerHandle["layout"]>[0]);
  });
  const routeSelect = byId<HTMLSelectElement>("route");
  routeSelect.value = route;
  routeSelect.addEventListener("change", () => {
    route = routeSelect.value === "orthogonal" ? "orthogonal" : "curve";
    localStorage.setItem("blockml.route", route);
    viewer.setRoute(route);
  });
  const modeButton = byId("mode");
  modeButton.addEventListener("click", () => {
    mode = mode === "presentation" ? "editing" : "presentation";
    viewer.setMode(mode);
    document.body.dataset.mode = mode;
    modeButton.textContent = mode === "presentation" ? "编辑" : "预览";
  });
  themeButton.addEventListener("click", () => applyTheme(theme === "dark" ? "light" : "dark"));

  autoSaveInput.addEventListener("change", () => {
    autoSave = autoSaveInput.checked;
    localStorage.setItem("blockml.autosave", autoSave ? "1" : "0");
    if (autoSave) scheduleSave();
  });

  byId("recent").addEventListener("click", (event) => {
    event.stopPropagation();
    renderRecentMenu();
    recentMenu.classList.toggle("hidden");
    exportMenu.classList.add("hidden");
  });
  byId("export").addEventListener("click", (event) => {
    event.stopPropagation();
    exportMenu.classList.toggle("hidden");
    recentMenu.classList.add("hidden");
  });
  recentMenu.addEventListener("click", (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>("button[data-path]");
    if (!button) return;
    recentMenu.classList.add("hidden");
    void openFile(button.dataset.path);
  });
  exportMenu.addEventListener("click", (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>("button[data-export]");
    if (!button) return;
    exportMenu.classList.add("hidden");
    const kind = button.dataset.export;
    if (kind === "svg" || kind === "png" || kind === "html") void exportAs(kind);
  });
  document.addEventListener("click", (event) => {
    if (!(event.target as Element).closest("#recent, #export, #recent-menu, #export-menu")) {
      recentMenu.classList.add("hidden");
      exportMenu.classList.add("hidden");
    }
  });

  byId("banner-reload").addEventListener("click", () => {
    if (!currentPath || externalSource === null) return;
    loadFile(currentPath, externalSource);
  });
  byId("banner-dismiss").addEventListener("click", () => hideBanner());
}

async function bindDesktop(): Promise<void> {
  await listen<string>("blockml://file-changed", async (event) => {
    if (!currentPath || event.payload !== currentPath) return;
    const text = await invoke<string>("read_file", { path: currentPath }).catch(() => null);
    if (text === null || text === source) return;
    if (dirty) {
      externalSource = text;
      showBanner("文件已在磁盘上修改");
    } else {
      loadFile(currentPath, text);
    }
  });

  await listen<string>("blockml://open-path", (event) => void openFile(event.payload));

  await listen<string>("blockml://menu", (event) => handleMenu(event.payload));

  await getCurrentWebview().onDragDropEvent((event) => {
    const payload = event.payload;
    if (payload.type === "enter" || payload.type === "over") {
      dropOverlay.classList.remove("hidden");
    } else if (payload.type === "leave") {
      dropOverlay.classList.add("hidden");
    } else if (payload.type === "drop") {
      dropOverlay.classList.add("hidden");
      const file = payload.paths.find((path) => path.toLowerCase().endsWith(".blockml"));
      if (file) void openFile(file);
    }
  });

  const pending = await invoke<string[]>("take_pending_paths").catch(() => []);
  if (pending.length && pending[0]) await openFile(pending[0]);
}

bindEvents();
if (isTauri) void bindDesktop();
