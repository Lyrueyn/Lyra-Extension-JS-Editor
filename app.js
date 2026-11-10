(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const host = window.chrome && window.chrome.webview ? window.chrome.webview : null;
  const params = new URLSearchParams(location.search);
  const JS_EXT = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx"]);
  const THEME_KEY = "lyra.js.editor.theme";
  const THEMES = new Set(["javascript", "lyra", "violet", "emerald", "sunset", "sakura", "light"]);
  const SHELL_MODE = params.get("shell") === "1" && window.parent !== window;
  const shellPending = new Map();
  let shellSeq = 1;
  const state = {
    projectName: params.get("projectName") || "JS 项目",
    root: "",
    files: [],
    dirs: [],
    expanded: new Set(),
    currentRel: "",
    dirty: false,
    cleanValue: "",
    requestId: 1,
    pending: new Map(),
    suppressChange: false,
    outlineTimer: 0,
    autoHintCooldown: 0,
    hintRefresh: false,
    problems: [],
    lintTimer: 0,
    lintLineClasses: new Map(),
    bottomTab: "console",
    debug: { enabled: false, active: false, paused: false, frameId: null, frames: [], pausedLine: null, breakpointIds: [] },
    problemIndex: -1,
    consoleAutoScroll: true,
    pendingRunDone: null,
    runDoneTimer: 0,
    postRunNoted: false,
    lastRunEnded: false,
    runMeta: null,
    runWorker: null,
    runWorkerUrl: "",
    runWatchdog: 0,
    runtimeLines: new Set(),
    workerSandbox: true,
    hintSymbolsValue: null,
    hintSymbols: [],
    breakpointsByFile: new Map(),
    autoSaveTimer: 0,
    saveInFlight: false,
    saveQueued: false,
    running: false,
    runSeq: 0,
    runStartedAt: 0,
    find: { matches: [], index: -1, query: "", caseSensitive: false, open: false },
  };
  let cm = null;
  let language = null;

  function setupFoldHelpers() {
    try {
      const brace = window.CodeMirror && CodeMirror.fold && CodeMirror.fold.brace;
      if (!brace) return;
      ["javascript", "json", "htmlmixed", "xml", "css"].forEach((mode) => CodeMirror.registerHelper("fold", mode, brace));
    } catch { }
  }

  function bytesToBase64(bytes) {
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    return btoa(bin);
  }
  function base64ToBytes(b64) {
    const bin = atob(b64 || "");
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i) & 0xff;
    return out;
  }
  function encodeText(text) { return bytesToBase64(new TextEncoder().encode(text || "")); }
  function decodeText(b64) { return new TextDecoder("utf-8", { fatal: false }).decode(base64ToBytes(b64)); }
  function extOf(rel) {
    const s = String(rel || "");
    const i = s.lastIndexOf(".");
    return i >= 0 ? s.slice(i).toLowerCase() : "";
  }
  function baseName(rel) {
    const s = String(rel || "");
    const i = s.lastIndexOf("/");
    return i >= 0 ? s.slice(i + 1) : s;
  }
  function classify(rel) {
    const ext = extOf(rel);
    if (JS_EXT.has(ext)) return "js";
    if (ext === ".json") return "json";
    if (ext === ".html" || ext === ".htm") return "html";
    if (ext === ".css") return "css";
    return "other";
  }

  function shellHostCall(type, payload) {
    return new Promise((resolve, reject) => {
      const requestId = "js-shell-" + (shellSeq++) + "-" + Date.now();
      shellPending.set(requestId, { resolve, reject });
      window.parent.postMessage({ type: "shell-host-request", requestId: requestId, method: type, payload: payload || {} }, "*");
      setTimeout(() => {
        if (!shellPending.has(requestId)) return;
        shellPending.delete(requestId);
        reject(new Error("编辑器外壳响应超时"));
      }, 20000);
    });
  }
  window.addEventListener("message", (event) => {
    const d = event.data || {};
    if (d.type === "theme" && typeof d.theme === "string" && THEMES.has(d.theme)) applyTheme(d.theme);
  });

  window.addEventListener("message", (event) => {
    const d = event.data || {};
    if (d.type !== "shell-host-result") return;
    const p = shellPending.get(d.requestId);
    if (!p) return;
    shellPending.delete(d.requestId);
    if (d.ok === false) p.reject(new Error(d.error || "外壳操作失败"));
    else p.resolve(d);
  });

  function hostCall(type, payload) {
    if (SHELL_MODE) return shellHostCall(type, payload);
    return new Promise((resolve, reject) => {
      if (!host) { reject(new Error("请从璃鸢镜扩展窗口打开")); return; }
      const requestId = "js-" + (state.requestId++) + "-" + Date.now();
      state.pending.set(requestId, { resolve, reject });
      host.postMessage(Object.assign({ type: type, requestId: requestId }, payload || {}));
      setTimeout(() => {
        const p = state.pending.get(requestId);
        if (!p) return;
        state.pending.delete(requestId);
        reject(new Error("宿主响应超时"));
      }, 20000);
    });
  }
  if (host) {
    host.addEventListener("message", (event) => {
      const d = event.data || {};
      if (d.type === "editor.cdp-event") { handleCdpEvent(d.method, d.params || {}); return; }
      const p = state.pending.get(d.requestId);
      if (!p) return;
      state.pending.delete(d.requestId);
      if (d.ok === false) p.reject(new Error(d.error || "宿主操作失败"));
      else p.resolve(d);
    });
  }

  let toastTimer = 0;
  function toast(message, isError) {
    const el = $("toast");
    el.textContent = String(message || "");
    el.className = "toast" + (isError ? " error" : "");
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
  }
  function setStatus(text) { $("saveState").textContent = text || ""; }
  function showError(err) { const m = String(err && err.message ? err.message : err); setStatus("错误：" + m); toast(m, true); }

  function fullPath(rel) {
    const root = String(state.root || "").replace(/[\\/]+$/, "");
    if (!root) return String(rel || "");
    const sep = root.includes("\\") ? "\\" : "/";
    return root + sep + String(rel || "").replace(/\//g, sep);
  }

  function applyTheme(name) {
    const next = THEMES.has(name) ? name : "javascript";
    document.documentElement.dataset.jsTheme = next;
    $("themeSelect").value = next;
    try { localStorage.setItem(THEME_KEY, next); } catch { }
    if (cm) setTimeout(() => cm.refresh(), 20);
  }

  function initTheme() {
    let saved = "javascript";
    try { saved = localStorage.getItem(THEME_KEY) || "javascript"; } catch { }
    applyTheme(saved);
  }

  function languageFor(rel) {
    const kind = classify(rel);
    if (kind === "json") return { mode: { name: "javascript", json: true }, badge: "JSON" };
    if (kind === "js") {
      const ext = extOf(rel);
      return { mode: { name: "javascript" }, badge: ext === ".ts" || ext === ".tsx" ? "TypeScript" : "JavaScript" };
    }
    return { mode: null, badge: "Text" };
  }

  function fileIcon(rel) {
    const kind = classify(rel);
    if (kind === "js") return { cls: "js", text: "JS" };
    if (kind === "json") return { cls: "json", text: "{}" };
    if (kind === "html") return { cls: "html", text: "<>" };
    if (kind === "css") return { cls: "css", text: "#" };
    return { cls: "md", text: "·" };
  }

  function buildTree() {
    const root = { dirs: new Map(), files: [] };
    for (const d of state.dirs) {
      const parts = String(d || "").split("/").filter(Boolean);
      let node = root;
      for (let i = 0; i < parts.length; i += 1) {
        const name = parts[i];
        const path = parts.slice(0, i + 1).join("/");
        if (!node.dirs.has(name)) node.dirs.set(name, { name, path, node: { dirs: new Map(), files: [] } });
        node = node.dirs.get(name).node;
      }
    }
    for (const file of state.files) {
      const parts = String(file.rel || "").split("/");
      let node = root;
      for (let i = 0; i < parts.length - 1; i += 1) {
        const name = parts[i];
        const path = parts.slice(0, i + 1).join("/");
        if (!node.dirs.has(name)) node.dirs.set(name, { name, path, node: { dirs: new Map(), files: [] } });
        node = node.dirs.get(name).node;
      }
      node.files.push(file);
    }
    return root;
  }

  function renderTree() {
    const box = $("fileTree");
    box.innerHTML = "";
    const root = buildTree();
    function walk(node, container, depth) {
      const dirs = Array.from(node.dirs.values()).sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
      const files = node.files.slice().sort((a, b) => baseName(a.rel).localeCompare(baseName(b.rel), "zh-CN"));
      for (const dir of dirs) {
        const open = state.expanded.has(dir.path);
        const row = document.createElement("button");
        row.type = "button";
        row.className = "tree-row tree-dir" + (open ? " open" : "");
        row.style.paddingLeft = (6 + depth * 13) + "px";
        row.title = dir.path;
        row.innerHTML = '<span class="tree-chevron">▸</span><span class="tree-icon dir">▤</span><span class="tree-name"></span>';
        row.querySelector(".tree-name").textContent = dir.name;
        const children = document.createElement("div");
        children.className = "tree-children";
        children.hidden = !open;
        row.addEventListener("click", () => {
          if (state.expanded.has(dir.path)) state.expanded.delete(dir.path);
          else state.expanded.add(dir.path);
          renderTree();
        });
        container.append(row, children);
        walk(dir.node, children, depth + 1);
      }
      for (const file of files) {
        const kind = classify(file.rel);
        const editable = kind === "js" || kind === "json";
        const routed = kind === "html" || kind === "css";
        const row = document.createElement("button");
        row.type = "button";
        row.className = "tree-row tree-file" + (file.rel === state.currentRel ? " active" : "") + (editable || routed ? "" : " disabled");
        row.style.paddingLeft = (6 + depth * 13 + 14) + "px";
        row.title = file.rel + (kind === "html" ? "（HTML 编辑器插件）" : kind === "css" ? "（CSS 编辑器插件）" : "");
        const icon = fileIcon(file.rel);
        row.innerHTML = '<span class="tree-icon ' + icon.cls + '"></span><span class="tree-name"></span>';
        row.querySelector(".tree-icon").textContent = icon.text;
        row.querySelector(".tree-name").textContent = baseName(file.rel);
        if (editable) row.addEventListener("click", () => switchFile(file.rel).catch(showError));
        else if (routed) row.addEventListener("click", () => openWithOtherPlugin(file.rel).catch(showError));
        else row.addEventListener("click", () => toast("这个文件类型不属于 JavaScript 编辑器：" + file.rel, true));
        container.appendChild(row);
      }
    }
    walk(root, box, 0);
  }

  async function openWithOtherPlugin(rel) {
    const kind = classify(rel);
    if (kind === "html") {
      const res = await hostCall("editor.open-file", { rel });
      if (!res || res.ok === false) throw new Error((res && res.error) || "打开 HTML 编辑器失败");
      toast("已交给 HTML 编辑器插件打开：" + rel);
      return;
    }
    if (kind === "css") { toast("还没有 CSS 编辑器插件，暂时不能编辑 " + rel, true); return; }
    toast("没有适配这个文件类型的编辑器插件：" + rel, true);
  }

  function updateChrome() {
    $("projectName").textContent = state.projectName || "";
    $("currentFile").textContent = state.currentRel || "未打开文件";
    $("currentFile").classList.toggle("dirty", state.dirty);
    $("dirtyBadge").hidden = !state.dirty;
    $("statusFile").textContent = state.currentRel ? fullPath(state.currentRel) : "";
    const lang = languageFor(state.currentRel);
    $("languageBadge").textContent = lang.badge;
    if (cm) {
      const pos = cm.getCursor();
      $("statusPos").textContent = "Ln " + (pos.line + 1) + ", Col " + (pos.ch + 1);
    }
  }

  function updateHistoryButtons() {
    if (!cm) return;
    const h = cm.historySize();
    $("undoBtn").disabled = !h.undo;
    $("redoBtn").disabled = !h.redo;
  }

  function markDirty() {
    if (!state.currentRel) return;
    state.dirty = cm.getValue() !== state.cleanValue;
    $("dirtyBadge").hidden = !state.dirty;
    $("currentFile").classList.toggle("dirty", state.dirty);
    setStatus(state.dirty ? "编辑中…" : "已保存");
    scheduleAutoSave();
    scheduleOutline();
    scheduleLint(900);
    updateHistoryButtons();
  }

  function scheduleAutoSave() {
    clearTimeout(state.autoSaveTimer);
    if (!state.currentRel) return;
    state.autoSaveTimer = setTimeout(() => saveNow({ auto: true }).catch((e) => setStatus("自动保存失败：" + e.message)), 900);
  }

  async function saveNow(opts) {
    opts = opts || {};
    if (!state.currentRel || !cm) return;
    if (!state.dirty) { if (!opts.auto) setStatus("已保存"); return; }
    if (state.saveInFlight) { state.saveQueued = true; return; }
    state.saveInFlight = true;
    const rel = state.currentRel;
    const value = cm.getValue();
    setStatus(opts.auto ? "自动保存中…" : "保存中…");
    try {
      await hostCall("host.workspace.save", { path: rel, data: encodeText(value) });
      if (state.currentRel === rel) {
        state.cleanValue = value;
        state.dirty = cm.getValue() !== value;
        $("dirtyBadge").hidden = !state.dirty;
        $("currentFile").classList.toggle("dirty", state.dirty);
        const stamp = new Date().toTimeString().slice(0, 8);
        if (language) language.invalidateProjectIndex();
        if (opts.auto) { setStatus("已自动保存 " + stamp); $("statusSave").textContent = "自动保存 " + stamp; }
        else { setStatus("已保存 " + stamp); $("statusSave").textContent = "已保存 " + stamp; }
      }
    } catch (e) {
      setStatus("保存失败");
      throw e;
    } finally {
      state.saveInFlight = false;
      if (state.saveQueued) {
        state.saveQueued = false;
        if (state.dirty) scheduleAutoSave();
      }
    }
  }

  async function switchFile(rel) {
    if (!rel || rel === state.currentRel) return;
    clearTimeout(state.autoSaveTimer);
    if (state.dirty) { try { await saveNow({ silent: true }); } catch (e) { toast("切换文件前保存失败：" + e.message, true); return; } }
    const res = await hostCall("host.workspace.load", { path: rel });
    const text = decodeText(res.data || "");
    state.currentRel = rel;
    state.cleanValue = text;
    state.dirty = false;
    const lang = languageFor(rel);
    state.suppressChange = true;
    cm.setValue(text);
    cm.setOption("mode", lang.mode);
    state.suppressChange = false;
    cm.clearHistory();
    cm.setCursor({ line: 0, ch: 0 });
    cm.focus();
    expandParents(rel);
    renderTree();
    updateChrome();
    renderOutline();
    renderBreakpoints();
    updateHistoryButtons();
    resetLint();
    scheduleLint(350);
    setStatus("已加载");
    if (language) language.invalidateProjectIndex();
  }

  function expandParents(rel) {
    const parts = String(rel || "").split("/");
    for (let i = 1; i < parts.length; i += 1) state.expanded.add(parts.slice(0, i).join("/"));
  }

  async function loadProject() {
    const info = await hostCall("host.project.list");
    state.root = info.root || "";
    state.projectName = info.name || state.projectName;
    state.files = Array.isArray(info.files) ? info.files : [];
    state.dirs = Array.isArray(info.dirs) ? info.dirs : [];
    renderTree();
    const entry = params.get("projectEntry") || "";
    const candidates = state.files.filter((f) => {
      const k = classify(f.rel);
      return k === "js" || k === "json";
    });
    const target = candidates.find((f) => f.rel === entry) ||
      candidates.find((f) => /\.(m?js|cjs)$/i.test(f.rel)) ||
      candidates.find((f) => /\.json$/i.test(f.rel)) ||
      candidates[0];
    if (target) await switchFile(target.rel);
    else setStatus("项目里没有 .js / .json 文件");
    updateChrome();
  }

  function collectSymbols(code) {
    const lines = String(code || "").split("\n");
    const out = [];
    const seen = new Set();
    function add(name, kind, index) {
      if (!name || seen.has(name)) return;
      seen.add(name);
      out.push({ name, kind, line: index + 1 });
    }
    lines.forEach((line, index) => {
      let m;
      m = line.match(/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/);
      if (m) { add(m[1], "function", index); return; }
      m = line.match(/^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/);
      if (m) { add(m[1], "class", index); return; }
      m = line.match(/^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/);
      if (m) { add(m[1], "arrow", index); return; }
      m = line.match(/^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/);
      if (m) { add(m[1], "var", index); return; }
      m = line.match(/^\s{2,}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/);
      if (m && !["if", "for", "while", "switch", "catch"].includes(m[1])) add(m[1], "method", index);
    });
    return out.slice(0, 200);
  }

  function renderOutline() {
    const box = $("outlineList");
    if (!box) return;
    const symbols = cm ? collectSymbols(cm.getValue()) : [];
    $("outlineCount").textContent = String(symbols.length);
    box.innerHTML = "";
    if (!symbols.length) {
      box.innerHTML = '<div class="outline-empty">当前文件里没有函数 / 类 / 顶层变量。</div>';
      return;
    }
    for (const sym of symbols) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "outline-row";
      row.title = sym.name + " · 第 " + sym.line + " 行";
      row.innerHTML = '<span class="outline-kind"></span><span class="outline-name"></span><span class="outline-line"></span>';
      const kindEl = row.querySelector(".outline-kind");
      kindEl.textContent = sym.kind === "class" ? "C" : sym.kind === "function" || sym.kind === "method" ? "ƒ" : sym.kind === "arrow" ? "λ" : "V";
      kindEl.className = "outline-kind kind-" + sym.kind;
      row.querySelector(".outline-name").textContent = sym.name;
      row.querySelector(".outline-line").textContent = String(sym.line);
      row.addEventListener("click", () => {
        cm.setCursor({ line: Math.max(0, sym.line - 1), ch: 0 });
        cm.focus();
        cm.scrollIntoView({ line: Math.max(0, sym.line - 1), ch: 0 }, 120);
      });
      box.appendChild(row);
    }
  }

  function scheduleOutline() {
    clearTimeout(state.outlineTimer);
    state.outlineTimer = setTimeout(renderOutline, 250);
  }

  function appendConsole(level, args, extraClass, options) {
    const out = $("consoleOutput");
    const empty = out.querySelector(".console-empty");
    if (empty) empty.remove();
    if (state.pendingRunDone && state.running) {
      clearTimeout(state.runDoneTimer);
      state.runDoneTimer = setTimeout(finalizeRun, 460);
    }
    if (state.lastRunEnded && !state.postRunNoted && !/^run-/.test(extraClass || "")) {
      state.postRunNoted = true;
      const note = document.createElement("div");
      note.className = "console-line info post-run-note";
      note.innerHTML = '<span class="console-time"></span><span class="console-level">INFO</span><span class="console-text">运行结束后输出</span>';
      out.appendChild(note);
    }
    const line = document.createElement("div");
    line.className = "console-line " + (level || "log") + (extraClass ? " " + extraClass : "");
    const time = document.createElement("span");
    time.className = "console-time";
    time.textContent = new Date().toTimeString().slice(0, 8);
    const lv = document.createElement("span");
    lv.className = "console-level";
    lv.textContent = (level || "log").toUpperCase();
    const text = document.createElement("span");
    text.className = "console-text";
    text.textContent = Array.isArray(args) ? args.join(" ") : String(args == null ? "" : args);
    if (options && options.stack) text.textContent += "\n" + options.stack;
    line.append(time, lv, text);
    if (options && options.line) {
      line.classList.add("clickable");
      line.title = "点击定位到第 " + options.line + " 行";
      line.addEventListener("click", () => jumpToLine(options.line, options.ch || 0));
      markRuntimeLine(options.line);
    }
    out.appendChild(line);
    if (state.consoleAutoScroll) out.scrollTop = out.scrollHeight;
    return line;
  }

  function clearRuntimeMarks() {
    if (!cm) return;
    for (const line of state.runtimeLines) cm.removeLineClass(line, "background", "cm-runtime-line");
    state.runtimeLines.clear();
  }

  function markRuntimeLine(line) {
    if (!cm || !line) return;
    const zero = Math.max(0, line - 1);
    if (zero >= cm.lineCount()) return;
    cm.addLineClass(zero, "background", "cm-runtime-line");
    state.runtimeLines.add(zero);
  }

  function jumpToLine(line, ch) {
    if (!cm) return;
    setBottomTab("console");
    const zero = Math.max(0, Number(line || 1) - 1);
    cm.setCursor({ line: zero, ch: Math.max(0, Number(ch || 0)) });
    cm.focus();
    cm.scrollIntoView({ line: zero, ch: Math.max(0, Number(ch || 0)) }, 140);
  }

  function mapRunStack(stack) {
    const meta = state.runMeta;
    if (!stack) return { stack: "", line: 0, ch: 0 };
    let firstLine = 0;
    let firstCh = 0;
    const mapped = String(stack).split("\n").map((row) => {
      return row.replace(/(?:about:srcdoc|lyra-user-code\.js|lyra-user-worker\.js|blob:[^\s]+?):(\d+):(\d+)/g, (all, lineNo, colNo) => {
        if (!meta) return all;
        const userLine = Number(lineNo) - meta.sourceStartLine + 1;
        if (userLine < 1 || userLine > meta.lineCount) return all;
        if (!firstLine) { firstLine = userLine; firstCh = Number(colNo); }
        return "用户代码:" + userLine + ":" + colNo;
      });
    });
    return { stack: mapped.join("\n"), line: firstLine, ch: firstCh };
  }

  function appendRuntimeError(message, stack) {
    const mapped = mapRunStack(stack || "");
    appendConsole("error", [message || "运行错误"], "runtime-error", { stack: mapped.stack, line: mapped.line, ch: mapped.ch });
    if (mapped.line) setStatus("运行错误：第 " + mapped.line + " 行");
  }

  function appendRunSeparator() {
    const out = $("consoleOutput");
    if (!out.querySelector(".console-line")) return;
    const sep = document.createElement("div");
    sep.className = "console-run-sep";
    out.appendChild(sep);
    out.scrollTop = out.scrollHeight;
  }

  function clearConsole() {
    $("consoleOutput").innerHTML = '<div class="console-empty">点击「运行文件」或「运行选中」执行 JavaScript，console.log 会输出到这里。</div>';
    $("statusRun").textContent = "";
    clearRuntimeMarks();
    state.lastRunEnded = false;
    state.postRunNoted = false;
    clearTimeout(state.runDoneTimer);
    state.pendingRunDone = null;
  }

  function copyConsole() {
    const out = $("consoleOutput");
    const text = Array.from(out.querySelectorAll(".console-line")).map((line) => line.innerText.replace(/\n+/g, " ").trim()).filter(Boolean).join("\n");
    if (!text) { toast("Console 还是空的", true); return; }
    const fallback = () => {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.cssText = "position:fixed;left:-9999px;top:0;";
      document.body.appendChild(area);
      area.select();
      let ok = false;
      try { ok = document.execCommand("copy"); } catch { }
      area.remove();
      toast(ok ? "已复制 Console 输出" : "复制失败", !ok);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => toast("已复制 Console 输出")).catch(fallback);
    } else fallback();
  }

  function setRunUi(running) {
    const btn = $("runBtn");
    btn.classList.toggle("running", running);
    btn.textContent = running ? "■ 停止运行" : "▶ 运行文件";
    $("runBadge").hidden = !running;
    $("statusRun").textContent = running ? "运行中…" : "";
  }

  function buildRunner(code, runId) {
    const safeCode = String(code || "").replace(/<\/script/gi, "<\\/script");
    const hooks = [
      "var __runId=" + Number(runId) + ";",
      "var __hadError=false;",
      "var __send=function(level,args,meta){try{parent.postMessage({type:'js-run-console',runId:__runId,level:level,args:args.map(function(v){try{if(v instanceof Error)return v.stack||v.message;if(typeof v==='object')return JSON.stringify(v);return String(v);}catch(e){return String(v);}}),runtime:!!(meta&&meta.runtime),stack:(meta&&meta.stack)||''},'*');}catch(e){}};",
      "['log','info','warn','error','debug'].forEach(function(level){var orig=console[level];console[level]=function(){__send(level,Array.prototype.slice.call(arguments));try{if(orig)orig.apply(console,arguments);}catch(e){}};});",
      "window.addEventListener('error',function(e){var err=e.error;var msg=err&&err.message?err.message:(e.message||'运行错误');var stack=err&&err.stack?err.stack:(e.message||'')+(e.lineno?(' ('+e.lineno+':'+e.colno+')'):'');__hadError=true;__send('error',[msg],{runtime:true,stack:stack});});",
      "window.addEventListener('unhandledrejection',function(e){var r=e.reason;var msg=r&&r.message?r.message:String(r);__hadError=true;__send('error',['Unhandled rejection: '+msg],{runtime:true,stack:(r&&r.stack)?r.stack:('Unhandled rejection: '+msg)});});",
    ].join("\n");
    const prefix = "<!DOCTYPE html><html><head><meta charset=\"utf-8\"></head><body><script>\n(function(){\n" + hooks + "\ntry {\n";
    const done = "setTimeout(function(){parent.postMessage({type:'js-run-done',runId:__runId,hadError:__hadError},'*');},0);";
    const suffix = "\n} catch (e) { __hadError=true; __send('error',[e && e.message ? e.message : String(e)], {runtime:true, stack:e && e.stack ? e.stack : String(e)}); }\n" + done + "\n})();\n//# sourceURL=lyra-user-code.js\n</" + "script></body></html>";
    return { html: prefix + safeCode + suffix, sourceStartLine: prefix.split("\n").length, lineCount: safeCode.split("\n").length };
  }

  function collectDebugNames(ast, source) {
    const names = new Set();
    function addPattern(pattern, out) {
      if (!pattern) return;
      if (pattern.type === "Identifier") { if (typeof out.add === "function") out.add(pattern.name); else out.push(pattern.name); }
      else if (pattern.type === "ObjectPattern") for (const prop of pattern.properties || []) addPattern(prop.value || prop.argument, out);
      else if (pattern.type === "ArrayPattern") for (const el of pattern.elements || []) addPattern(el, out);
      else if (pattern.type === "AssignmentPattern") addPattern(pattern.left, out);
      else if (pattern.type === "RestElement") addPattern(pattern.argument, out);
    }
    function visitStatements(body) {
      for (const stmt of body || []) {
        if (!stmt) continue;
        if (stmt.type === "VariableDeclaration") for (const decl of stmt.declarations || []) addPattern(decl.id, names),
          decl.init && visitExpression(decl.init);
        else if (stmt.type === "FunctionDeclaration") { if (stmt.id) names.add(stmt.id.name); }
        else if (stmt.type === "ClassDeclaration") { if (stmt.id) names.add(stmt.id.name); }
        else if (stmt.type === "ImportDeclaration") for (const spec of stmt.specifiers || []) if (spec.local) names.add(spec.local.name);
        else if (stmt.type === "ForStatement") {
          if (stmt.init && stmt.init.type === "VariableDeclaration") for (const decl of stmt.init.declarations || []) addPattern(decl.id, names);
          visitStatements(stmt.body && stmt.body.type === "BlockStatement" ? stmt.body.body : [stmt.body]);
        } else if (stmt.type === "ForInStatement" || stmt.type === "ForOfStatement") {
          if (stmt.left && stmt.left.type === "VariableDeclaration") for (const decl of stmt.left.declarations || []) addPattern(decl.id, names);
          visitStatements(stmt.body && stmt.body.type === "BlockStatement" ? stmt.body.body : [stmt.body]);
        } else if (stmt.type === "BlockStatement") visitStatements(stmt.body);
        else if (stmt.type === "IfStatement") { visitStatements(stmt.consequent && stmt.consequent.type === "BlockStatement" ? stmt.consequent.body : []); visitStatements(stmt.alternate && stmt.alternate.type === "BlockStatement" ? stmt.alternate.body : []); }
        else if (stmt.type === "WhileStatement" || stmt.type === "DoWhileStatement" || stmt.type === "LabeledStatement") visitStatements(stmt.body && stmt.body.type === "BlockStatement" ? stmt.body.body : [stmt.body]);
        else if (stmt.type === "TryStatement") { visitStatements(stmt.block && stmt.block.body); visitStatements(stmt.handler && stmt.handler.body && stmt.handler.body.body); visitStatements(stmt.finalizer && stmt.finalizer.body); }
        else if (stmt.type === "SwitchStatement") for (const c of stmt.cases || []) visitStatements(c.consequent);
      }
    }
    function visitExpression(node) {
      if (!node || typeof node !== "object") return;
      if (node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression" || node.type === "ClassExpression") return;
      for (const key of Object.keys(node)) {
        if (key === "loc" || key === "range" || key === "start" || key === "end") continue;
        const value = node[key];
        if (Array.isArray(value)) for (const item of value) if (item && item.type) visitExpression(item);
        else if (value && value.type) visitExpression(value);
      }
    }
    visitStatements(ast.body || []);
    return names;
  }

  function buildDebugRunner(code, runId, breakpoints) {
    const safeCode = String(code || "").replace(/<\/script/gi, "<\\/script");
    const hooks = [
      "var __runId=" + Number(runId) + ";",
      "var __hadError=false;",
      "var __send=function(level,args,meta){try{parent.postMessage({type:'js-run-console',runId:__runId,level:level,args:args.map(function(v){try{if(v instanceof Error)return v.stack||v.message;if(typeof v==='object')return JSON.stringify(v);return String(v);}catch(e){return String(v);}}),runtime:!!(meta&&meta.runtime),stack:(meta&&meta.stack)||''},'*');}catch(e){}};",
      "['log','info','warn','error','debug'].forEach(function(level){var orig=console[level];console[level]=function(){__send(level,Array.prototype.slice.call(arguments));try{if(orig)orig.apply(console,arguments);}catch(e){}};});",
      "window.addEventListener('error',function(e){var err=e.error;var msg=err&&err.message?err.message:(e.message||'运行错误');var stack=err&&err.stack?err.stack:(e.message||'')+(e.lineno?(' ('+e.lineno+':'+e.colno+')'):'');__hadError=true;__send('error',[msg],{runtime:true,stack:stack});});",
      "window.addEventListener('unhandledrejection',function(e){var r=e.reason;var msg=r&&r.message?r.message:String(r);__hadError=true;__send('error',['Unhandled rejection: '+msg],{runtime:true,stack:(r&&r.stack)?r.stack:('Unhandled rejection: '+msg)});});",
    ].join("\n");
    const breakpointJson = JSON.stringify((breakpoints || []).slice());
    const debugHook = [
      "var __lyraBreakpoints=" + breakpointJson + ";",
      "var __lyraStep=false;var __lyraPauseRequested=false;var __lyraPause=null;",
      "function __lyraVal(v){try{if(v===undefined)return 'undefined';if(v===null)return 'null';if(typeof v==='string')return JSON.stringify(v);if(typeof v==='function')return 'ƒ '+(v.name||'anonymous');if(typeof v==='object'){var s=JSON.stringify(v);return s&&s.length>300?s.slice(0,300)+'…':s;}return String(v);}catch(e){return String(v);}}",
      "function __lyraDebug(line,getters,evalFn){if(!__lyraStep&&!__lyraPauseRequested&&__lyraBreakpoints.indexOf(line)<0)return Promise.resolve();__lyraStep=false;__lyraPauseRequested=false;var vars={};for(var i=0;i<getters.length;i++){try{vars[getters[i][0]]=__lyraVal(getters[i][1]());}catch(e){vars[getters[i][0]]='<错误>';}}return new Promise(function(resolve){__lyraPause={resolve:resolve,evalFn:evalFn,line:line};parent.postMessage({type:'js-debug-paused',runId:__runId,line:line,vars:vars},'*');});}",
      "window.addEventListener('message',function(e){var d=e.data||{};if(d.type!=='js-debug-command'||d.runId!==__runId)return;if(d.command==='eval'&&__lyraPause){try{parent.postMessage({type:'js-debug-eval',runId:__runId,value:__lyraVal(__lyraPause.evalFn(d.expression)),ok:true},'*');}catch(err){parent.postMessage({type:'js-debug-eval',runId:__runId,value:String(err),ok:false},'*');}return;}if(d.command==='pause'){__lyraPauseRequested=true;return;}var p=__lyraPause;if(!p)return;__lyraPause=null;if(d.command==='step')__lyraStep=true;else if(d.command==='resume')__lyraStep=false;p.resolve();});",
    ].join("\n");
    const prefix = "<!DOCTYPE html><html><head><meta charset=\"utf-8\"></head><body><script>\n(async function(){\n" + hooks + "\n" + debugHook + "\ntry {\n";
    const done = "setTimeout(function(){parent.postMessage({type:'js-run-done',runId:__runId,hadError:__hadError},'*');},0);";
    const suffix = "\n} catch (e) { __hadError=true; __send('error',[e && e.message ? e.message : String(e)], {runtime:true, stack:e && e.stack ? e.stack : String(e)}); }\n" + done + "\n})();\n//# sourceURL=lyra-user-code.js\n</" + "script></body></html>";
    let body = safeCode;
    try {
      const acorn = window.acorn;
      if (!acorn || !acorn.parse) throw new Error("acorn unavailable");
      const ast = acorn.parse(code, { ecmaVersion: "latest", sourceType: "script", locations: true, allowHashBang: true });
      if ((ast.body || []).some((n) => n.type === "ImportDeclaration" || n.type.startsWith("Export"))) throw new Error("module");
      const names = collectDebugNames(ast, code);
      const inserts = [];
      function debugCall(line) {
        const getters = Array.from(names).slice(0, 120).map((name) => "[\"" + name.replace(/\\/g, "\\\\").replace(/"/g, "\\\"") + "\",function(){try{return " + name + "}catch(e){return undefined}}]").join(",");
        return "await __lyraDebug(" + line + ",[" + getters + "],function(expr){try{return eval(expr)}catch(e){return e&&e.message?e.message:String(e)}});";
      }
      function addStmt(stmt) {
        if (!stmt || stmt.type === "EmptyStatement") return;
        if (stmt.type === "FunctionDeclaration" || stmt.type === "ClassDeclaration") {
          const lineStart = code.lastIndexOf("\n", stmt.start - 1) + 1;
          if (/^\s*$/.test(code.slice(lineStart, stmt.start))) inserts.push({ pos: stmt.start, text: debugCall(stmt.loc.start.line) });
          return;
        }
        if (stmt.type === "ImportDeclaration" || stmt.type.startsWith("Export")) return;
        if (stmt.type === "ExpressionStatement" && stmt.directive) return;
        const lineStart = code.lastIndexOf("\n", stmt.start - 1) + 1;
        if (/^\s*$/.test(code.slice(lineStart, stmt.start))) inserts.push({ pos: stmt.start, text: debugCall(stmt.loc.start.line) });
        const bodyOf = (node) => node && node.type === "BlockStatement" ? node.body : node && node.type ? [node] : [];
        if (stmt.type === "BlockStatement") bodyOf(stmt).forEach(addStmt);
        else if (stmt.type === "IfStatement") { bodyOf(stmt.consequent).forEach(addStmt); bodyOf(stmt.alternate).forEach(addStmt); }
        else if (stmt.type === "ForStatement" || stmt.type === "ForInStatement" || stmt.type === "ForOfStatement" || stmt.type === "WhileStatement" || stmt.type === "DoWhileStatement" || stmt.type === "LabeledStatement") bodyOf(stmt.body).forEach(addStmt);
        else if (stmt.type === "TryStatement") { bodyOf(stmt.block).forEach(addStmt); if (stmt.handler && stmt.handler.body) bodyOf(stmt.handler.body).forEach(addStmt); if (stmt.finalizer) bodyOf(stmt.finalizer).forEach(addStmt); }
        else if (stmt.type === "SwitchStatement") for (const c of stmt.cases || []) bodyOf({ type: "BlockStatement", body: c.consequent }).forEach(addStmt);
      }
      (ast.body || []).forEach(addStmt);
      inserts.sort((a, b) => b.pos - a.pos);
      for (const ins of inserts) body = body.slice(0, ins.pos) + ins.text + body.slice(ins.pos);
    } catch (e) {
      console.error("debug instrument failed", e);
    }
    return { html: prefix + body + suffix, sourceStartLine: prefix.split("\n").length, lineCount: body.split("\n").length };
  }

  function buildWorkerRunner(code, runId) {
    const safeCode = String(code || "").replace(/<\/script/gi, "<\\/script");
    const hooks = [
      "var __runId=" + Number(runId) + ";",
      "var __hadError=false;",
      "var __send=function(level,args,meta){try{postMessage({type:'js-run-console',runId:__runId,level:level,args:args.map(function(v){try{if(v instanceof Error)return v.stack||v.message;if(typeof v==='object')return JSON.stringify(v);return String(v);}catch(e){return String(v);}}),runtime:!!(meta&&meta.runtime),stack:(meta&&meta.stack)||''});}catch(e){}};",
      "['log','info','warn','error','debug'].forEach(function(level){var orig=console[level];console[level]=function(){__send(level,Array.prototype.slice.call(arguments));try{if(orig)orig.apply(console,arguments);}catch(e){}};});",
      "self.addEventListener('error',function(e){var err=e.error;var msg=err&&err.message?err.message:(e.message||'Worker 运行错误');var stack=err&&err.stack?err.stack:(e.message||'')+(e.lineno?(' ('+e.lineno+':'+e.colno+')'):'');__hadError=true;__send('error',[msg],{runtime:true,stack:stack});});",
      "self.addEventListener('unhandledrejection',function(e){var r=e.reason;var msg=r&&r.message?r.message:String(r);__hadError=true;__send('error',['Unhandled rejection: '+msg],{runtime:true,stack:(r&&r.stack)?r.stack:('Unhandled rejection: '+msg)});});",
    ].join("\n");
    const prefix = "(function(){\n" + hooks + "\ntry {\n";
    const done = "setTimeout(function(){postMessage({type:'js-run-done',runId:__runId,hadError:__hadError});},0);";
    const suffix = "\n} catch (e) { __hadError=true; __send('error',[e && e.message ? e.message : String(e)], {runtime:true, stack:e && e.stack ? e.stack : String(e)}); }\n" + done + "\n})();\n//# sourceURL=lyra-user-worker.js";
    return { code: prefix + safeCode + suffix, sourceStartLine: prefix.split("\n").length, lineCount: safeCode.split("\n").length };
  }

  function codeNeedsDom(code) {
    return /\b(document|window|localStorage|sessionStorage|indexedDB|location|navigator|history|HTMLElement|Element|Node|XMLHttpRequest|alert|confirm|prompt|getComputedStyle|requestAnimationFrame|cancelAnimationFrame|MutationObserver|ResizeObserver|IntersectionObserver)\b/.test(String(code || ""));
  }

  function workerFailure(error) {
    clearTimeout(state.runWatchdog);
    state.runWatchdog = 0;
    if (state.runWorker) {
      try { state.runWorker.terminate(); } catch { }
      state.runWorker = null;
    }
    if (state.runWorkerUrl) { try { URL.revokeObjectURL(state.runWorkerUrl); } catch { } state.runWorkerUrl = ""; }
    const message = error && error.message ? error.message : String(error || "Worker 运行失败");
    const stack = error && error.error && error.error.stack ? error.error.stack : (error && error.stack ? error.stack : message);
    appendRuntimeError(message, stack);
    appendConsole("error", ["✕ 运行结束（Worker 启动失败）"], "run-done");
    state.running = false;
    setRunUi(false);
  }

  async function startRun(label, code, allowDebug = true) {
    if (state.running) stopRun();
    appendRunSeparator();
    clearTimeout(state.runDoneTimer);
    state.pendingRunDone = null;
    state.lastRunEnded = false;
    state.postRunNoted = false;
    state.runSeq += 1;
    state.running = true;
    state.runStartedAt = Date.now();
    appendConsole("info", ["▶ " + label + "  ·  " + fullPath(state.currentRel)], "run-start");
    setRunUi(true);
    clearRuntimeMarks();
    try {
      const debugging = allowDebug && state.debug.active;
      if (debugging) {
        const runner = buildDebugRunner(code, state.runSeq, Array.from(currentBreakpoints()));
        state.runMeta = { sourceStartLine: runner.sourceStartLine, lineCount: runner.lineCount };
        await debugPrepare(runner);
        $("runFrame").srcdoc = runner.html;
        return;
      }
      const useWorker = state.workerSandbox && !codeNeedsDom(code);
      if (state.workerSandbox && codeNeedsDom(code)) toast("代码使用 DOM API，已使用 iframe 沙箱");
      if (useWorker && typeof Worker !== "undefined") {
        const runner = buildWorkerRunner(code, state.runSeq);
        state.runMeta = { sourceStartLine: runner.sourceStartLine, lineCount: runner.lineCount };
        const blob = new Blob([runner.code], { type: "text/javascript" });
        const url = URL.createObjectURL(blob);
        const worker = new Worker(url);
        state.runWorker = worker;
        state.runWorkerUrl = url;
        worker.onmessage = (event) => handleRunnerMessage(event.data || {});
        worker.onerror = (event) => {
          try { event.preventDefault(); } catch { }
          workerFailure(event);
        };
        state.runWatchdog = setTimeout(() => {
          if (!state.running) return;
          try { worker.terminate(); } catch { }
          state.runWorker = null;
          appendRuntimeError("运行超时（8 秒），已终止 Worker（可能是死循环或未结束的任务）", "");
          state.running = false;
          setRunUi(false);
        }, 8000);
      } else {
        const runner = buildRunner(code, state.runSeq);
        state.runMeta = { sourceStartLine: runner.sourceStartLine, lineCount: runner.lineCount };
        $("runFrame").srcdoc = runner.html;
      }
    } catch (e) {
      appendConsole("error", [String(e && e.message ? e.message : e)]);
      state.running = false;
      setRunUi(false);
    }
  }

  function endRun(hadError) {
    if (!state.running || state.pendingRunDone) return;
    state.pendingRunDone = { hadError: !!hadError };
    clearTimeout(state.runDoneTimer);
    state.runDoneTimer = setTimeout(finalizeRun, 460);
  }

  function finalizeRun() {
    const pending = state.pendingRunDone;
    if (!pending || !state.running) return;
    state.pendingRunDone = null;
    clearTimeout(state.runDoneTimer);
    state.running = false;
    state.lastRunEnded = true;
    clearTimeout(state.runWatchdog);
    state.runWatchdog = 0;
    const ms = Math.max(0, Date.now() - state.runStartedAt);
    appendConsole(pending.hadError ? "error" : "info", [(pending.hadError ? "✕ 运行结束（有错误）" : "✓ 运行结束") + "  ·  " + ms + " ms"], "run-done");
    setRunUi(false);
  }

  function stopRun() {
    if (!state.running) return;
    clearTimeout(state.runDoneTimer);
    state.pendingRunDone = null;
    state.lastRunEnded = false;
    state.running = false;
    state.runSeq += 1;
    clearTimeout(state.runWatchdog);
    state.runWatchdog = 0;
    if (state.runWorker) { try { state.runWorker.terminate(); } catch { } state.runWorker = null; }
    if (state.runWorkerUrl) { try { URL.revokeObjectURL(state.runWorkerUrl); } catch { } state.runWorkerUrl = ""; }
    $("runFrame").srcdoc = "";
    appendConsole("error", ["■ 已停止运行"], "run-stop");
    setRunUi(false);
  }

  function runFile() {
    if (!cm || !state.currentRel) { toast("先打开一个 .js 文件", true); return; }
    startRun("运行文件", cm.getValue());
  }

  function runSelection() {
    if (!cm) return;
    const code = cm.getSelection();
    if (!code || !code.trim()) { toast("先在编辑器里选中一段 JavaScript", true); cm.focus(); return; }
    startRun("运行选中代码", code, false);
  }

  function runRepl(expression) {
    const expr = String(expression || "").trim();
    if (!expr) return;
    const code = "try { var __r = (" + expr + "); __send('log', [typeof __r === 'object' ? JSON.stringify(__r) : String(__r)]); } catch (__e) { __send('error', [__e && __e.stack ? __e.stack : String(__e)]); }";
    startRun("REPL  " + expr, code);
  }

  function findOptions() { return { query: $("findInput").value, caseSensitive: $("findCase").checked }; }

  function rebuildFindMatches(preserveIndex) {
    const opts = findOptions();
    state.find.query = opts.query;
    state.find.caseSensitive = opts.caseSensitive;
    state.find.matches = [];
    $("findCount").textContent = "0/0";
    if (!opts.query) return;
    const text = cm.getValue();
    const hay = opts.caseSensitive ? text : text.toLowerCase();
    const needle = opts.caseSensitive ? opts.query : opts.query.toLowerCase();
    if (!needle) return;
    let at = 0;
    while (at <= hay.length) {
      const idx = hay.indexOf(needle, at);
      if (idx < 0) break;
      state.find.matches.push({ from: idx, to: idx + needle.length });
      at = idx + Math.max(1, needle.length);
      if (state.find.matches.length >= 5000) break;
    }
    if (!preserveIndex) state.find.index = -1;
    if (state.find.index >= state.find.matches.length) state.find.index = state.find.matches.length - 1;
    updateFindCount();
  }

  function updateFindCount() {
    const n = state.find.matches.length;
    const i = state.find.index;
    $("findCount").textContent = n ? ((i >= 0 ? i + 1 : 0) + "/" + n) : "0/0";
  }

  function showFindMatch(index) {
    if (!state.find.matches.length) { updateFindCount(); return; }
    state.find.index = index;
    const m = state.find.matches[index];
    cm.setSelection(cm.posFromIndex(m.from), cm.posFromIndex(m.to), { scroll: true });
    cm.focus();
    updateFindCount();
  }

  function findNext(dir) {
    if (!state.find.query) rebuildFindMatches(false);
    if (!state.find.matches.length) { toast("没有找到：" + ($("findInput").value || ""), true); return; }
    let next = state.find.index + (dir || 1);
    if (next >= state.find.matches.length) next = 0;
    if (next < 0) next = state.find.matches.length - 1;
    showFindMatch(next);
  }

  function nearestMatchFromCursor() {
    const pos = cm.indexFromPos(cm.getCursor());
    for (let i = 0; i < state.find.matches.length; i += 1) if (state.find.matches[i].from >= pos) return i;
    return 0;
  }

  function openFind(replaceMode) {
    state.find.open = true;
    $("findBar").hidden = false;
    const sel = cm.getSelection();
    if (sel && !sel.includes("\n") && sel.length < 200) $("findInput").value = sel;
    rebuildFindMatches(false);
    if (state.find.query && state.find.matches.length) {
      state.find.index = nearestMatchFromCursor();
      showFindMatch(state.find.index);
    }
    if (replaceMode) { $("replaceInput").focus(); $("replaceInput").select(); }
    else { $("findInput").focus(); $("findInput").select(); }
    updateFindCount();
  }

  function closeFind() {
    state.find.open = false;
    $("findBar").hidden = true;
    if (cm) cm.focus();
  }

  function replaceCurrent() {
    if (!state.find.matches.length) rebuildFindMatches(false);
    if (!state.find.matches.length) { findNext(1); return; }
    if (state.find.index < 0) state.find.index = nearestMatchFromCursor();
    const m = state.find.matches[state.find.index];
    const value = $("replaceInput").value;
    cm.replaceRange(value, cm.posFromIndex(m.from), cm.posFromIndex(m.to));
    rebuildFindMatches(true);
    findNext(1);
    setStatus("已替换");
  }

  function replaceAll() {
    rebuildFindMatches(false);
    const matches = state.find.matches;
    if (!matches.length) { toast("没有找到：" + ($("findInput").value || ""), true); return; }
    const value = $("replaceInput").value;
    cm.operation(() => {
      for (let i = matches.length - 1; i >= 0; i -= 1) {
        cm.replaceRange(value, cm.posFromIndex(matches[i].from), cm.posFromIndex(matches[i].to));
      }
    });
    const count = matches.length;
    rebuildFindMatches(false);
    toast("已替换 " + count + " 处");
    setStatus("已替换 " + count + " 处");
  }


  // ---------- JavaScript 自动补全 ----------
  const JS_HINT_KEYWORDS = ["async", "await", "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do", "else", "export", "extends", "false", "finally", "for", "from", "function", "get", "if", "import", "in", "instanceof", "let", "new", "null", "of", "return", "set", "static", "super", "switch", "this", "throw", "true", "try", "typeof", "undefined", "var", "void", "while", "with", "yield"];
  const JS_HINT_GLOBALS = ["console", "document", "window", "globalThis", "Math", "JSON", "Object", "Array", "String", "Number", "Boolean", "Date", "RegExp", "Promise", "Map", "Set", "WeakMap", "WeakSet", "Symbol", "Proxy", "Reflect", "Error", "TypeError", "RangeError", "Intl", "localStorage", "sessionStorage", "location", "navigator", "history", "fetch", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "requestAnimationFrame", "cancelAnimationFrame", "queueMicrotask", "structuredClone", "crypto", "performance", "alert", "confirm", "prompt"];
  const JS_HINT_SNIPPETS = [
    { label: "function", text: "function name() {\n  \n}", detail: "function" },
    { label: "function (args)", text: "function name(args) {\n  \n}", detail: "function" },
    { label: "arrow function", text: "const name = (args) => {\n  \n};", detail: "arrow" },
    { label: "async function", text: "async function name() {\n  \n}", detail: "async" },
    { label: "if", text: "if (condition) {\n  \n}", detail: "control" },
    { label: "for", text: "for (let i = 0; i < length; i += 1) {\n  \n}", detail: "control" },
    { label: "for…of", text: "for (const item of items) {\n  \n}", detail: "control" },
    { label: "try/catch", text: "try {\n  \n} catch (error) {\n  \n}", detail: "control" },
    { label: "class", text: "class Name {\n  constructor() {\n  }\n}", detail: "class" },
    { label: "console.log", text: "console.log(value)", detail: "log" },
    { label: "querySelector", text: "document.querySelector(selector)", detail: "DOM" },
    { label: "getElementById", text: "document.getElementById(id)", detail: "DOM" },
    { label: "addEventListener", text: "addEventListener(\"click\", (event) => {\n  \n})", detail: "event" },
  ];
  const JS_MEMBERS = {
    console: ["log", "info", "warn", "error", "debug", "table", "dir", "trace", "assert", "time", "timeEnd", "group", "groupEnd", "count", "clear"],
    document: ["addEventListener", "removeEventListener", "querySelector", "querySelectorAll", "getElementById", "getElementsByClassName", "getElementsByTagName", "createElement", "createTextNode", "createDocumentFragment", "body", "head", "documentElement", "title", "URL", "location", "cookie", "readyState", "write", "writeln", "execCommand", "getSelection"],
    window: ["addEventListener", "removeEventListener", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "requestAnimationFrame", "cancelAnimationFrame", "fetch", "alert", "confirm", "prompt", "localStorage", "sessionStorage", "location", "navigator", "history", "console", "document", "innerWidth", "innerHeight", "scrollX", "scrollY", "scrollTo", "open", "close", "postMessage", "matchMedia"],
    Math: ["abs", "ceil", "floor", "round", "max", "min", "pow", "sqrt", "random", "trunc", "sign", "log", "exp", "sin", "cos", "tan", "atan2", "PI", "E", "LN2", "LN10", "SQRT2"],
    JSON: ["parse", "stringify"],
    Array: ["from", "isArray", "of"],
    Object: ["keys", "values", "entries", "assign", "freeze", "seal", "create", "defineProperty", "defineProperties", "getOwnPropertyNames", "getOwnPropertyDescriptor", "fromEntries", "hasOwn", "is", "prototype"],
    String: ["fromCharCode", "fromCodePoint", "raw", "prototype"],
    Number: ["isFinite", "isInteger", "isNaN", "isSafeInteger", "parseFloat", "parseInt", "MAX_SAFE_INTEGER", "MIN_SAFE_INTEGER", "EPSILON", "POSITIVE_INFINITY", "NEGATIVE_INFINITY", "NaN"],
    Promise: ["all", "allSettled", "any", "race", "resolve", "reject", "prototype"],
    Date: ["now", "parse", "UTC", "prototype"],
    RegExp: ["prototype"],
    localStorage: ["getItem", "setItem", "removeItem", "clear", "key", "length"],
    sessionStorage: ["getItem", "setItem", "removeItem", "clear", "key", "length"],
    location: ["href", "hash", "host", "hostname", "pathname", "port", "protocol", "search", "assign", "reload", "replace", "toString"],
    navigator: ["userAgent", "language", "languages", "platform", "onLine", "clipboard", "geolocation"],
    history: ["back", "forward", "go", "length", "pushState", "replaceState", "state"],
    crypto: ["randomUUID", "getRandomValues", "subtle"],
    performance: ["now", "mark", "measure", "getEntries", "timeOrigin"],
  };
  const JS_GENERIC_MEMBERS = ["length", "push", "pop", "shift", "unshift", "slice", "splice", "map", "filter", "reduce", "reduceRight", "forEach", "find", "findIndex", "findLast", "some", "every", "includes", "indexOf", "lastIndexOf", "join", "sort", "reverse", "concat", "at", "flat", "flatMap", "keys", "values", "entries", "startsWith", "endsWith", "replace", "replaceAll", "split", "trim", "trimStart", "trimEnd", "toLowerCase", "toUpperCase", "padStart", "padEnd", "toString", "valueOf", "then", "catch", "finally", "has", "add", "delete", "clear", "get", "set"];
  const JS_HINT_BADGES = { kw: "KW", fn: "FN", snip: "SNIP", class: "CLS", var: "VAR", method: "FN", global: "GLB", prop: "PROP" };

  function jsHintBadge(kind) { return JS_HINT_BADGES[kind] || "·"; }

  function jsHintItem(kind, text, detail, displayText) {
    return { text: text, displayText: displayText || text, kind: kind, detail: detail || "", render: jsHintRender };
  }

  function jsHintRender(el, completion, item) {
    const data = item || completion || {};
    const row = document.createElement("span");
    row.className = "js-hint-row";
    const badge = document.createElement("span");
    badge.className = "js-hint-kind js-hint-" + (data.kind || "");
    badge.textContent = jsHintBadge(data.kind);
    const name = document.createElement("span");
    name.className = "js-hint-name";
    name.textContent = data.displayText || data.text || "";
    row.append(badge, name);
    if (data.detail) {
      const detail = document.createElement("span");
      detail.className = "js-hint-detail";
      detail.textContent = data.detail;
      row.appendChild(detail);
    }
    el.appendChild(row);
  }

  function jsMemberSuggestions(obj, prefix) {
    const lower = String(prefix || "").toLowerCase();
    const source = JS_MEMBERS[obj] || JS_GENERIC_MEMBERS;
    return source
      .filter((name) => !lower || name.toLowerCase().startsWith(lower))
      .map((name) => jsHintItem(JS_MEMBERS[obj] ? "prop" : "prop", name, obj ? obj + "." : "member"));
  }

  function jsMonacoHint(cm) {
    if (!window.MonacoCompletion) return null;
    const data = window.MonacoCompletion.hintAt(cm);
    if (!data || !data.list || !data.list.length) return null;
    return {
      from: data.from,
      to: data.to,
      list: data.list.map((entry) => jsHintItem(window.MonacoCompletion.kindOf(entry.kind), entry.name, entry.kind || "monaco", entry.name)),
    };
  }

  function jsMergeMonaco(cm, custom) {
    const mono = jsMonacoHint(cm);
    if (!mono) return custom;
    const list = mono.list.slice();
    const seen = new Set(list.map((item) => item.text));
    for (const item of (custom && custom.list) || []) {
      if (seen.has(item.text)) continue;
      seen.add(item.text);
      list.push(item);
    }
    return { list: list, from: mono.from || (custom && custom.from), to: mono.to || (custom && custom.to) };
  }

  function jsHintSymbols(cm) {
    const value = cm.getValue();
    if (state.hintSymbolsValue === value) return state.hintSymbols;
    state.hintSymbolsValue = value;
    state.hintSymbols = collectSymbols(value);
    return state.hintSymbols;
  }

  function jsHintAt(cm) {
    const cursor = cm.getCursor();
    const token = cm.getTokenAt(cursor);
    const tokenType = String(token.type || "");
    if (/\b(comment|string)\b/.test(tokenType)) return null;
    const before = cm.getLine(cursor.line).slice(0, cursor.ch);
    const member = before.match(/([A-Za-z_$][\w$]*)\s*\??\.\s*([A-Za-z_$][\w$]*)?$/);
    if (member) {
      const prefix = member[2] || "";
      const from = { line: cursor.line, ch: cursor.ch - prefix.length };
      const list = jsMemberSuggestions(member[1], prefix);
      const result = list.length ? { list: list, from: from, to: cursor } : null;
      return jsMergeMonaco(cm, result);
    }
    const wordMatch = before.match(/([A-Za-z_$][\w$]*)$/);
    const prefix = wordMatch ? wordMatch[1] : "";
    const lower = prefix.toLowerCase();
    const from = { line: cursor.line, ch: cursor.ch - prefix.length };
    const items = [];
    const seen = new Set();
    const add = (item) => {
      if (!item || seen.has(item.text)) return;
      if (lower && !String(item.displayText || item.text).toLowerCase().startsWith(lower)) return;
      seen.add(item.text);
      items.push(item);
    };
    for (const word of JS_HINT_KEYWORDS) add(jsHintItem("kw", word));
    for (const word of JS_HINT_GLOBALS) add(jsHintItem("global", word));
    if (cm) {
      const symbols = jsHintSymbols(cm);
      for (const sym of symbols) add(jsHintItem(sym.kind === "class" ? "class" : sym.kind === "var" ? "var" : "fn", sym.name, "line " + sym.line));
    }
    for (const snippet of JS_HINT_SNIPPETS) {
      add(jsHintItem("snip", snippet.text, snippet.detail, snippet.label));
    }
    if (!prefix && items.length > 80) items.length = 80;
    return jsMergeMonaco(cm, items.length ? { list: items, from: from, to: cursor } : null);
  }

  function showJsHint(cm) {
    if (!cm || !cm.showHint) return;
    const result = jsHintAt(cm);
    if (!result || !result.list.length) {
      if (cm.state.completionActive) cm.closeHint();
      return;
    }
    try {
      cm.showHint({ hint: () => result, completeSingle: false, closeOnUnfocus: true });
    } catch { }
  }

  function shouldAutoHint(cm) {
    if (!cm || cm.state.completionActive || Date.now() < state.autoHintCooldown) return false;
    if (cm.somethingSelected()) return false;
    const cursor = cm.getCursor();
    const token = cm.getTokenAt(cursor);
    const tokenType = String(token.type || "");
    if (/\b(comment|string)\b/.test(tokenType)) return false;
    const before = cm.getLine(cursor.line).slice(0, cursor.ch);
    if (/\.\s*$/.test(before)) return true;
    if (/\.\s*[A-Za-z_$][\w$]*$/.test(before)) return true;
    const word = (before.match(/[A-Za-z_$][\w$]*$/) || [""])[0];
    return word.length >= 1;
  }

  function scheduleJsHint(cm, delay) {
    clearTimeout(cm._jsHintTimer);
    cm._jsHintTimer = setTimeout(() => {
      if (shouldAutoHint(cm)) showJsHint(cm);
    }, delay || 120);
  }

  // ---------- 可拖动分区 ----------
  function storePaneSize(key, value) {
    try { localStorage.setItem(key, String(value)); } catch { }
  }
  function paneSizeFromStore(key, fallback) {
    try { const n = Number(localStorage.getItem(key)); return Number.isFinite(n) && n > 0 ? n : fallback; } catch { return fallback; }
  }
  function applyPaneSize(target, value, horizontal) {
    if (!target) return;
    const size = Math.round(value);
    target.style.flex = "0 0 " + size + "px";
    if (horizontal) target.style.width = size + "px";
  }
  function initPaneResizers() {
    if (cm) cm.refresh();
    const bottom = $("bottomPanel");
    const sidebar = $("sidebar");
    const outline = $("outlinePanel");
    const savedBottom = paneSizeFromStore("lyra.js.pane.console", bottom ? bottom.getBoundingClientRect().height : 226);
    const savedSidebar = paneSizeFromStore("lyra.js.pane.sidebar", sidebar ? sidebar.getBoundingClientRect().width : 228);
    const savedOutline = paneSizeFromStore("lyra.js.pane.outline", outline ? outline.getBoundingClientRect().width : 216);
    applyPaneSize(bottom, Math.min(savedBottom, Math.max(150, window.innerHeight - 190)), false);
    applyPaneSize(sidebar, Math.min(savedSidebar, Math.max(220, window.innerWidth - 420)), true);
    applyPaneSize(outline, Math.min(savedOutline, Math.max(220, window.innerWidth - 360)), true);

    function attach(resizer, target, axis, direction, min, max, key) {
      if (!resizer || !target) return;
      let startPos = 0;
      let startSize = 0;
      let dragging = false;
      resizer.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        dragging = true;
        startPos = axis === "y" ? event.clientY : event.clientX;
        startSize = target.getBoundingClientRect()[axis === "y" ? "height" : "width"];
        resizer.classList.add("dragging");
        document.body.style.cursor = axis === "y" ? "row-resize" : "col-resize";
        const move = (ev) => {
          if (!dragging) return;
          const pos = axis === "y" ? ev.clientY : ev.clientX;
          const delta = (pos - startPos) * direction;
          const upper = typeof max === "function" ? max() : max;
          const lower = typeof min === "function" ? min() : min;
          const size = Math.max(lower, Math.min(upper, startSize + delta));
          applyPaneSize(target, size, axis === "x");
          if (cm) cm.refresh();
        };
        const up = () => {
          if (!dragging) return;
          dragging = false;
          resizer.classList.remove("dragging");
          document.body.style.cursor = "";
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          storePaneSize(key, target.getBoundingClientRect()[axis === "y" ? "height" : "width"]);
          if (cm) cm.refresh();
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      });
    }
    attach($("bottomResizer"), bottom, "y", -1, 110, () => Math.max(150, window.innerHeight - 190), "lyra.js.pane.console");
    attach($("sidebarResizer"), sidebar, "x", 1, 150, () => Math.max(220, window.innerWidth - 420), "lyra.js.pane.sidebar");
    attach($("outlineResizer"), outline, "x", -1, 150, () => Math.max(220, window.innerWidth - 360), "lyra.js.pane.outline");
  }

  // ---------- 代码格式化 / 检查 ----------
  function resetLint() {
    clearTimeout(state.lintTimer);
    if (cm) {
      for (const [line, cls] of state.lintLineClasses) cm.removeLineClass(line, "background", cls);
    }
    state.lintLineClasses.clear();
    state.problems = [];
    state.problemIndex = -1;
    const count = $("problemsCount");
    if (count) count.textContent = "0";
    const list = $("problemList");
    if (list) list.innerHTML = "";
    const tab = $("problemsTab");
    if (tab) tab.classList.remove("has-error");
    const detail = $("problemDetail");
    if (detail) detail.innerHTML = '<div class="problem-detail-empty">选择一条问题查看详情</div>';
  }

  function applyLintLineClasses() {
    if (!cm) return;
    for (const [line, cls] of state.lintLineClasses) cm.removeLineClass(line, "background", cls);
    state.lintLineClasses.clear();
    const byLine = new Map();
    for (const p of state.problems) {
      const line = Math.max(0, (p.line || 1) - 1);
      const cls = p.severity === "error" ? "cm-lint-line-error" : "cm-lint-line-warning";
      if (!byLine.has(line) || cls === "cm-lint-line-error") byLine.set(line, cls);
    }
    for (const [line, cls] of byLine) {
      cm.addLineClass(line, "background", cls);
      state.lintLineClasses.set(line, cls);
    }
  }

  function shortProblem(problem) {
    const rule = problem && problem.rule || "";
    const message = String(problem && problem.message || "");
    const trim = (text, n) => text.length > n ? text.slice(0, n - 1) + "…" : text;
    let m;
    if (rule === "no-undef") return message.replace(/^未定义的变量[：:]\s*/, "未定义 ");
    if (rule === "no-unused-vars") return message.replace(/^已声明但未使用[：:]\s*/, "未使用 ");
    if (rule === "type-mismatch") {
      m = message.match(/^(number|boolean|string) 类型没有 '([^']+)' 方法$/);
      if (m) return m[1] + " 没有 " + m[2] + " 方法";
    }
    if (rule === "possible-type-error") {
      m = message.match(/^(undefined|null) 不能读取属性 '([^']+)'/);
      if (m) return m[1] + " 不能读取 ." + m[2];
      return trim(message, 46);
    }
    if (rule === "call-non-function") {
      m = message.match(/尝试调用 (\w+) 类型/);
      return m ? "尝试调用非函数 " + m[1] : "尝试调用非函数";
    }
    if (rule === "array-out-of-bounds") {
      m = message.match(/数组长度为 (\d+).*下标 (\d+)/);
      return m ? "数组越界 " + m[2] + " / 长度 " + m[1] : "数组下标越界";
    }
    if (rule === "invalid-array-length") return "new Array 非法长度";
    if (rule === "invalid-uri") return "URI 转义非法";
    if (rule === "invalid-json") return "JSON 字符串非法";
    if (rule === "unhandled-promise") return "Promise 未处理";
    if (rule === "unconditional-recursion") return "递归没有终止条件";
    if (rule === "delete-nonconfigurable") return "不可删除属性";
    if (rule === "symbol-concat") return "Symbol 不能转字符串";
    if (rule === "bigint-mix") return "BigInt/Number 混用";
    if (rule === "reflect-nonobject") return "Reflect.get 需要对象";
    if (rule === "frozen-write") return "冻结对象不能修改";
    if (rule === "invalid-string-arg") return "String 参数为负数";
    if (rule === "new-arrow") return "不能 new 箭头函数";
    if (rule === "invalid-destructure") return "不能解构 null/undefined";
    if (rule === "invalid-spread") return "展开不可迭代值";
    if (rule === "object-assign-null") return "Object.assign 目标为空";
    if (rule === "possible-off-by-one") return "循环可能越界";
    if (rule === "possible-param-type-error") return "参数可能为 undefined";
    if (rule === "no-dupe-args") return trim(message.replace(/^参数重复[：:]\s*/, "参数重复 "), 46);
    if (rule === "no-dupe-keys") return "对象键重复";
    if (rule === "no-debugger") return "残留 debugger";
    if (rule === "eqeqeq") return "建议使用 ===";
    if (rule === "no-unreachable") return "不可达代码";
    if (rule === "syntax") return trim(message.replace(/^语法错误[：:]\s*/, "语法错误 "), 50);
    return trim(message, 58);
  }

  function problemExplanation(rule) {
    const map = {
      "no-undef": "这个标识符没有声明。检查拼写，或用 let / const / var 声明；如果是外部全局变量，需要确认它确实已加载。",
      "no-unused-vars": "声明后没有被使用。删除它，或者如果是有意保留，改成以下划线开头的名字。",
      "type-mismatch": "这个类型没有该成员。确认变量实际是字符串还是数字；number 没有 toUpperCase，string 没有 toFixed。",
      "possible-type-error": "对 null / undefined 读取属性或调用方法会抛出 TypeError。访问前先判空，或给一个默认值。",
      "call-non-function": "被调用的值不是函数。确认变量是否被覆盖，或是否把数字/字符串当成函数调用。",
      "array-out-of-bounds": "访问的下标超出了数组字面量长度，结果是 undefined，继续访问属性通常会抛 TypeError。检查循环边界。",
      "invalid-array-length": "Array 构造器只接受非负整数长度，负数会抛出 RangeError。",
      "invalid-uri": "decodeURIComponent / decodeURI 收到了不完整的百分号转义，会抛出 URIError。",
      "invalid-json": "JSON.parse 的字符串不是合法 JSON，会抛出 SyntaxError。检查引号和括号。",
      "unhandled-promise": "返回 Promise 的函数调用后没有 catch / await；异步失败会变成 Unhandled rejection。补上 catch 或 await。",
      "unconditional-recursion": "递归函数内直接调用自身，没有判断终止条件，最终会栈溢出 RangeError。",
      "possible-off-by-one": "循环条件用了 <= .length，最后一次循环会访问到数组末尾之后。通常应该改为 < .length。",
      "possible-param-type-error": "调用函数时传入了 null / undefined，而函数内部会访问该参数的属性，运行时会抛 TypeError。",
      "syntax": "代码不符合 JavaScript 语法，解析器无法完整生成语法树。修复后其余检查会恢复准确。",
      "delete-nonconfigurable": "Object.defineProperty 把属性设成 configurable: false 后，严格模式下 delete 会抛 TypeError。",
      "symbol-concat": "Symbol 不能隐式转换为字符串；如果确实要显示，使用 String(sym) 或 sym.description。",
      "bigint-mix": "BigInt 和 Number 不能直接相加/相乘；两边统一成 BigInt 或 Number。",
      "reflect-nonobject": "Reflect.get 的第一个参数必须是对象，传入数字/字符串/null 会抛 TypeError。",
      "frozen-write": "Object.freeze 后对象不可修改；严格模式下赋值会抛 TypeError。",
      "invalid-string-arg": "String.repeat / padStart / padEnd 的参数不能是负数，否则抛 RangeError。",
      "new-arrow": "箭头函数没有 [[Construct]]，不能用 new 调用，会抛 TypeError。",
      "invalid-destructure": "对 null / undefined 使用对象或数组解构会抛 TypeError；先判空或提供默认值。",
      "invalid-spread": "展开运算要求右侧是可迭代对象；展开数字/布尔/普通对象会抛 TypeError。",
      "object-assign-null": "Object.assign 的目标不能是 null / undefined。",
      "no-const-assign": "const 声明的变量不能重新赋值，运行时会抛 TypeError。",
      "no-delete-var": "delete 不能删除变量名，严格模式下会抛 SyntaxError。",
    };
    return map[rule] || "检查该问题对应的代码，并在运行前确认变量类型、边界和异步分支。";
  }

  function renderProblemDetail() {
    const host = $("problemDetail");
    if (!host) return;
    const problem = state.problems[state.problemIndex];
    host.innerHTML = "";
    if (!problem) {
      host.innerHTML = '<div class="problem-detail-empty">选择一条问题查看详情</div>';
      return;
    }
    const head = document.createElement("div");
    head.className = "problem-detail-head";
    const sev = document.createElement("span");
    sev.className = "problem-detail-sev" + (problem.severity === "error" ? " error" : "");
    sev.textContent = problem.severity === "error" ? "✕" : "!";
    const title = document.createElement("span");
    title.className = "problem-detail-title";
    title.textContent = shortProblem(problem);
    head.append(sev, title);
    host.appendChild(head);

    const meta = document.createElement("div");
    meta.className = "problem-detail-meta";
    meta.textContent = (state.currentRel || "当前文件") + "  ·  Ln " + problem.line + ", Col " + ((problem.ch || 0) + 1) + "  ·  " + (problem.severity === "error" ? "错误" : "警告") + "  ·  " + (problem.rule || "rule");
    host.appendChild(meta);

    const full = document.createElement("div");
    full.className = "problem-detail-full";
    full.textContent = problem.message || "";
    host.appendChild(full);

    const explain = document.createElement("div");
    explain.className = "problem-detail-explain";
    explain.textContent = problemExplanation(problem.rule);
    host.appendChild(explain);

    if (cm && problem.line) {
      const code = document.createElement("pre");
      code.className = "problem-detail-code";
      const start = Math.max(0, (problem.line || 1) - 2);
      const end = Math.min(cm.lineCount(), (problem.line || 1) + 1);
      for (let i = start; i < end; i += 1) {
        const row = document.createElement("span");
        if (i === (problem.line || 1) - 1) row.className = "active";
        row.textContent = String(i + 1).padStart(3, " ") + "  " + (cm.getLine(i) || "").slice(0, 180);
        code.appendChild(row);
      }
      host.appendChild(code);
    }

    const actions = document.createElement("div");
    actions.className = "problem-detail-actions";
    const jump = document.createElement("button");
    jump.type = "button";
    jump.textContent = "跳到源码 Ln " + problem.line;
    jump.addEventListener("click", () => jumpToProblem(state.problemIndex));
    actions.appendChild(jump);
    host.appendChild(actions);
  }

  function jumpToProblem(index) {
    const problem = state.problems[index];
    if (!problem || !cm) return;
    state.problemIndex = index;
    setBottomTab("problems");
    cm.setCursor({ line: Math.max(0, (problem.line || 1) - 1), ch: Math.max(0, problem.ch || 0) });
    cm.focus();
    cm.scrollIntoView({ line: Math.max(0, (problem.line || 1) - 1), ch: Math.max(0, problem.ch || 0) }, 140);
    renderProblemList();
    renderProblemDetail();
  }

  function selectProblem(index) {
    state.problemIndex = index;
    renderProblemList();
    renderProblemDetail();
  }

  function renderProblemList() {
    const list = $("problemList");
    const count = $("problemsCount");
    if (count) count.textContent = String(state.problems.length);
    const tab = $("problemsTab");
    if (tab) tab.classList.toggle("has-error", state.problems.some((p) => p.severity === "error"));
    if (!list || state.bottomTab !== "problems") return;
    if (!state.problems.length) {
      state.problemIndex = -1;
      list.innerHTML = '<div class="problem-empty">没有发现问题</div>';
      renderProblemDetail();
      return;
    }
    list.innerHTML = "";
    state.problems.forEach((problem, index) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "problem-item " + (problem.severity === "error" ? "error" : "warning") + (index === state.problemIndex ? " active" : "");
      const icon = document.createElement("span");
      icon.className = "problem-icon";
      icon.textContent = problem.severity === "error" ? "✕" : "!";
      const body = document.createElement("span");
      body.className = "problem-body";
      const loc = document.createElement("span");
      loc.className = "problem-loc";
      loc.textContent = "Ln " + problem.line + ", Col " + ((problem.ch || 0) + 1);
      const msg = document.createElement("span");
      msg.className = "problem-msg";
      msg.textContent = shortProblem(problem);
      const rule = document.createElement("span");
      rule.className = "problem-rule";
      rule.textContent = problem.rule || "";
      body.appendChild(loc);
      body.appendChild(msg);
      body.appendChild(rule);
      item.appendChild(icon);
      item.appendChild(body);
      item.addEventListener("click", () => { selectProblem(index); });
      item.addEventListener("dblclick", () => jumpToProblem(index));
      list.appendChild(item);
    });
  }

  function setBottomTab(name) {
    state.bottomTab = name === "problems" ? "problems" : name === "debug" ? "debug" : "console";
    state.debug.active = state.bottomTab === "debug";
    $("consoleTab").classList.toggle("active", state.bottomTab === "console");
    $("problemsTab").classList.toggle("active", state.bottomTab === "problems");
    if ($("debugTab")) $("debugTab").classList.toggle("active", state.bottomTab === "debug");
    $("consoleOutput").hidden = state.bottomTab !== "console";
    const repl = document.querySelector(".repl-row");
    if (repl) repl.hidden = state.bottomTab !== "console";
    const layout = $("problemsLayout");
    if (layout) layout.hidden = state.bottomTab !== "problems";
    const debugLayout = $("debugLayout");
    if (debugLayout) debugLayout.hidden = state.bottomTab !== "debug";
    if (state.bottomTab === "problems") { renderProblemList(); renderProblemDetail(); }
    if (state.bottomTab === "debug") {
      setDebugStatus(state.debug.paused ? "已暂停" : "点击代码行号最左侧窄栏，或按 F9 / 点顶部「断点」按钮");
    }
  }

  const ESLINT_GLOBALS = {
    console: "readonly", window: "readonly", document: "readonly", navigator: "readonly", location: "readonly", history: "readonly", screen: "readonly", localStorage: "readonly", sessionStorage: "readonly", indexedDB: "readonly", crypto: "readonly", performance: "readonly",
    Math: "readonly", JSON: "readonly", Object: "readonly", Array: "readonly", String: "readonly", Number: "readonly", Boolean: "readonly", Date: "readonly", RegExp: "readonly", Promise: "readonly", Map: "readonly", Set: "readonly", WeakMap: "readonly", WeakSet: "readonly", Symbol: "readonly", BigInt: "readonly", Proxy: "readonly", Reflect: "readonly", Intl: "readonly", WebAssembly: "readonly",
    Error: "readonly", TypeError: "readonly", RangeError: "readonly", SyntaxError: "readonly", EvalError: "readonly", ReferenceError: "readonly", NaN: "readonly", Infinity: "readonly", undefined: "readonly", globalThis: "readonly",
    setTimeout: "readonly", clearTimeout: "readonly", setInterval: "readonly", clearInterval: "readonly", requestAnimationFrame: "readonly", cancelAnimationFrame: "readonly", queueMicrotask: "readonly", structuredClone: "readonly", fetch: "readonly",
    alert: "readonly", confirm: "readonly", prompt: "readonly", print: "readonly", atob: "readonly", btoa: "readonly", TextEncoder: "readonly", TextDecoder: "readonly", URL: "readonly", URLSearchParams: "readonly", Blob: "readonly", File: "readonly", FileReader: "readonly", FormData: "readonly", Headers: "readonly", Request: "readonly", Response: "readonly", AbortController: "readonly", AbortSignal: "readonly", WebSocket: "readonly", XMLHttpRequest: "readonly", MutationObserver: "readonly", IntersectionObserver: "readonly", ResizeObserver: "readonly", CustomEvent: "readonly", Event: "readonly", EventTarget: "readonly", Node: "readonly", Element: "readonly", HTMLElement: "readonly", DocumentFragment: "readonly", NodeList: "readonly", HTMLCollection: "readonly", DOMParser: "readonly", XMLSerializer: "readonly", Notification: "readonly", Worker: "readonly", Image: "readonly", Audio: "readonly", Option: "readonly", getComputedStyle: "readonly", matchMedia: "readonly",
    require: "readonly", module: "readonly", exports: "readonly", process: "readonly", Buffer: "readonly", __dirname: "readonly", __filename: "readonly",
  };
  const ESLINT_RULES = {
    "no-undef": "error",
    "no-unused-vars": ["warn", { args: "after-used", ignoreRestSiblings: true, caughtErrors: "none", varsIgnorePattern: "^_" }],
    "no-redeclare": "error",
    "no-const-assign": "error",
    "no-delete-var": "error",
    "no-dupe-args": "error",
    "no-dupe-keys": "error",
    "no-dupe-else-if": "error",
    "no-duplicate-case": "error",
    "no-unreachable": "error",
    "no-unreachable-loop": "warn",
    "no-func-assign": "error",
    "no-obj-calls": "error",
    "no-sparse-arrays": "warn",
    "no-unexpected-multiline": "error",
    "no-unsafe-finally": "error",
    "no-unsafe-negation": "error",
    "no-unsafe-optional-chaining": "error",
    "no-constant-binary-expression": "warn",
    "valid-typeof": "error",
    "use-isnan": "error",
    "no-async-promise-executor": "error",
    "no-await-in-loop": "warn",
    "no-prototype-builtins": "warn",
    "no-self-assign": "error",
    "no-self-compare": "error",
    "no-setter-return": "error",
    "no-unmodified-loop-condition": "warn",
    "no-useless-catch": "warn",
    "no-useless-escape": "warn",
    "no-useless-return": "warn",
    "no-with": "error",
    "no-cond-assign": ["error", "except-parens"],
    "no-constant-condition": ["warn", { checkLoops: false }],
    "no-control-regex": "warn",
    "no-debugger": "warn",
    "no-empty-pattern": "warn",
    "no-fallthrough": "error",
    "no-global-assign": "error",
    "no-implied-eval": "warn",
    "no-eval": "warn",
    "no-invalid-regexp": "error",
    "no-loss-of-precision": "warn",
    "no-misleading-character-class": "warn",
    "no-new-wrappers": "warn",
    "no-octal": "error",
    "no-regex-spaces": "warn",
    "no-shadow-restricted-names": "error",
    "no-throw-literal": "warn",
    "no-unused-labels": "warn",
    "no-useless-backreference": "warn",
    "no-useless-call": "warn",
    "no-useless-concat": "warn",
    "no-useless-constructor": "warn",
    "no-useless-rename": "warn",
    "no-unused-private-class-members": "warn",
    "no-extra-boolean-cast": "warn",
    "no-extra-semi": "warn",
    "no-irregular-whitespace": "warn",
    "no-ex-assign": "error",
    "no-import-assign": "error",
    eqeqeq: ["warn", "always", { null: "ignore" }],
  };
  const ESLINT_COVERED_RULES = new Set(["syntax", "no-undef", "no-unused-vars", "no-redeclare", "no-const-assign", "no-delete-var", "no-dupe-args", "no-dupe-keys", "no-dupe-else-if", "no-duplicate-case", "no-unreachable", "no-unreachable-loop", "no-func-assign", "no-obj-calls", "no-sparse-arrays", "no-unexpected-multiline", "no-unsafe-finally", "no-unsafe-negation", "no-unsafe-optional-chaining", "no-constant-binary-expression", "valid-typeof", "use-isnan", "no-async-promise-executor", "no-await-in-loop", "no-prototype-builtins", "no-self-assign", "no-self-compare", "no-setter-return", "no-unmodified-loop-condition", "no-useless-catch", "no-useless-escape", "no-useless-return", "no-with", "no-cond-assign", "no-constant-condition", "no-control-regex", "no-debugger", "no-empty-pattern", "no-fallthrough", "no-global-assign", "no-implied-eval", "no-eval", "no-invalid-regexp", "no-loss-of-precision", "no-misleading-character-class", "no-new-wrappers", "no-octal", "no-regex-spaces", "no-shadow-restricted-names", "no-throw-literal", "no-unused-labels", "no-useless-backreference", "no-useless-call", "no-useless-concat", "no-useless-constructor", "no-useless-rename", "no-unused-private-class-members", "no-extra-boolean-cast", "no-extra-semi", "no-irregular-whitespace", "no-ex-assign", "no-import-assign", "eqeqeq"]);
  let eslintLinter = null;

  function translateEslintMessage(rule, message) {
    const msg = String(message || "");
    if (rule === "no-undef") {
      const m = msg.match(/'([^']+)' is not defined/);
      return m ? "未定义变量：'" + m[1] + "'" : "未定义变量";
    }
    if (rule === "no-unused-vars") {
      const m = msg.match(/'([^']+)'/);
      return m ? "已声明但未使用：'" + m[1] + "'" : "已声明但未使用";
    }
    if (rule === "no-const-assign") return "const 变量不能重新赋值";
    if (rule === "no-delete-var") return "不能 delete 变量";
    if (rule === "no-redeclare") return "变量重复声明";
    if (rule === "no-dupe-keys") return "对象字面量键重复";
    if (rule === "no-dupe-args") return "函数参数重复";
    if (rule === "no-dupe-else-if") return "重复的 else-if 条件";
    if (rule === "no-duplicate-case") return "重复的 case";
    if (rule === "no-unreachable") return "不可达代码";
    if (rule === "no-func-assign") return "函数名被重新赋值";
    if (rule === "valid-typeof") return "typeof 比较值不合法";
    if (rule === "use-isnan") return "判断 NaN 应使用 Number.isNaN";
    if (rule === "no-debugger") return "残留 debugger";
    if (rule === "eqeqeq") return "建议使用 ===";
    if (rule === "no-fallthrough") return "case 可能意外贯穿";
    if (rule === "no-loss-of-precision") return "数字精度可能丢失";
    if (rule === "no-throw-literal") return "throw 应抛出 Error";
    if (rule === "no-eval" || rule === "no-implied-eval") return "eval 存在安全风险";
    return "ESLint：" + msg;
  }

  function runEslint(code) {
    if (!window.eslint || !window.eslint.Linter) return null;
    try {
      if (!eslintLinter) eslintLinter = new window.eslint.Linter();
      const raw = eslintLinter.verify(String(code || ""), {
        languageOptions: { ecmaVersion: 2024, sourceType: "module", globals: ESLINT_GLOBALS },
        rules: ESLINT_RULES,
      }, { filename: state.currentRel || "source.js" });
      return raw.map((item) => {
        const fatal = !!item.fatal;
        const rule = fatal ? "syntax" : (item.ruleId || "eslint");
        const severity = item.severity === 2 ? "error" : "warning";
        return {
          line: item.line || 1,
          ch: Math.max(0, (item.column || 1) - 1),
          severity: severity,
          rule: rule,
          message: fatal ? "语法错误：" + String(item.message || "").replace(/^Parsing error:\s*/i, "") : translateEslintMessage(rule, item.message),
        };
      });
    } catch (e) {
      return null;
    }
  }

  function runLint(opts) {
    opts = opts || {};
    clearTimeout(state.lintTimer);
    if (!cm) return [];
    const rel = state.currentRel || "";
    const kind = classify(rel);
    if (!kind || (kind !== "js" && kind !== "json")) {
      state.problems = [];
      applyLintLineClasses();
      renderProblemList();
      if (opts.open) setBottomTab("problems");
      return [];
    }
    if (/\.tsx?$/i.test(rel)) {
      state.problems = [];
      applyLintLineClasses();
      renderProblemList();
      if (opts.open) { setBottomTab("problems"); toast("TypeScript 文件暂不进行完整语法检查", true); }
      return [];
    }
    let problems = [];
    try {
      if (kind === "json") {
        try { JSON.parse(cm.getValue()); }
        catch (err) {
          const message = String(err && err.message || err);
          const pos = message.match(/position\s+(\d+)/i);
          let line = 1;
          let ch = 0;
          if (pos) {
            const before = cm.getValue().slice(0, Number(pos[1]));
            const lines = before.split("\n");
            line = lines.length;
            ch = lines[lines.length - 1].length;
          }
          problems.push({ line, ch, severity: "error", rule: "json", message: "JSON 语法错误：" + message });
        }
      } else if (window.LyraJSTools || window.eslint) {
        const code = cm.getValue();
        const eslintProblems = runEslint(code);
        const custom = window.LyraJSTools ? window.LyraJSTools.lintCode(code) : [];
        if (eslintProblems) {
          problems = eslintProblems.concat((custom || []).filter((p) => !ESLINT_COVERED_RULES.has(p.rule)));
        } else {
          problems = custom || [];
        }
        const seen = new Set();
        problems = problems.filter((p) => {
          const key = p.rule + ":" + p.line + ":" + p.ch + ":" + p.message;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        }).sort((a, b) => a.line - b.line || a.ch - b.ch).slice(0, 300);
      } else {
        toast("检查库没有加载", true);
      }
    } catch (err) {
      problems = [{ line: 1, ch: 0, severity: "error", rule: "lint", message: String(err && err.message || err) }];
    }
    state.problems = problems;
    state.problemIndex = -1;
    applyLintLineClasses();
    renderProblemList();
    renderProblemDetail();
    if (opts.open) setBottomTab("problems");
    if (opts.manual) setStatus(problems.length ? "检查完成：发现 " + problems.length + " 个问题" : "检查完成：没有发现问题");
    return problems;
  }

  function scheduleLint(delay) {
    clearTimeout(state.lintTimer);
    if (!state.currentRel) return;
    state.lintTimer = setTimeout(() => { runLint({ silent: true }); }, delay == null ? 900 : delay);
  }

  function formatDocument() {
    if (!cm) return;
    const kind = classify(state.currentRel || "");
    if (kind !== "js" && kind !== "json") { toast("当前文件不支持格式化", true); return; }
    try {
      const code = cm.getValue();
      const formatted = window.LyraJSTools.formatCode(code, kind === "json" ? "json" : "js");
      if (formatted === code) { setStatus("格式已经整齐"); return; }
      const cursor = cm.getCursor();
      cm.operation(() => {
        cm.replaceRange(formatted, { line: 0, ch: 0 }, { line: cm.lineCount(), ch: 0 });
      });
      cm.setCursor({ line: Math.min(cursor.line, cm.lineCount() - 1), ch: Math.min(cursor.ch, cm.getLine(Math.min(cursor.line, cm.lineCount() - 1)).length) });
      markDirty();
      scheduleLint(200);
      setStatus("已格式化");
      toast("已格式化当前文件");
    } catch (err) {
      toast("格式化失败：" + String(err && err.message || err), true);
    }
  }

  function currentBreakpoints() {
    const rel = state.currentRel || "";
    if (!state.breakpointsByFile.has(rel)) state.breakpointsByFile.set(rel, new Set());
    return state.breakpointsByFile.get(rel);
  }
  function renderBreakpoints() {
    if (!cm) return;
    try {
      cm.clearGutter("breakpoints");
      for (const line of currentBreakpoints()) {
        const dot = document.createElement("div");
        dot.className = "cm-breakpoint";
        dot.textContent = "●";
        dot.title = "断点：第 " + (line + 1) + " 行";
        cm.setGutterMarker(line, "breakpoints", dot);
      }
    } catch { }
  }
  function toggleBreakpoint(line) {
    if (!cm || line < 0) return;
    const text = cm.getLine(line) || "";
    if (!text.trim()) return;
    const set = currentBreakpoints();
    if (set.has(line)) set.delete(line); else set.add(line);
    renderBreakpoints();
    setStatus(set.has(line) ? "已设置断点：第 " + (line + 1) + " 行" : "已清除断点：第 " + (line + 1) + " 行");
  }
  function codeWithBreakpoints(code) {
    const set = currentBreakpoints();
    if (!set.size) return code;
    return String(code || "").split("\n").map((line, index) => {
      if (!set.has(index) || !line.trim()) return line;
      return "debugger; " + line;
    }).join("\n");
  }
  async function openDebugger() {
    try {
      const res = await hostCall("editor.open-devtools", {});
      if (!res || !res.ok) throw new Error((res && res.error) || "宿主拒绝了调试请求");
      toast("DevTools 已打开；脚本名 lyra-user-code.js / lyra-user-worker.js；行号断点可直接点击代码行号左侧设置");
      setStatus("调试器已打开");
    } catch (e) {
      toast("打开调试器失败：" + (e && e.message ? e.message : e), true);
    }
  }

  function debugValue(value) {
    if (!value) return "undefined";
    if (value.type === "undefined") return "undefined";
    if (value.subtype === "null") return "null";
    if (value.value !== undefined && value.value !== null) return String(value.value);
    if (value.unserializableValue) return String(value.unserializableValue);
    return value.description || value.type || "?";
  }
  async function cdp(method, params) {
    const res = await hostCall("editor.cdp-command", { method: method, params: JSON.stringify(params || {}) });
    if (!res || !res.ok) throw new Error((res && res.error) || ("调试命令失败：" + method));
    if (!res.result) return {};
    try { return JSON.parse(res.result); } catch { return {}; }
  }
  async function debugEnsure() {
    if (state.debug.enabled) return;
    await cdp("Debugger.enable");
    await cdp("Runtime.enable");
    try { await cdp("Debugger.setPauseOnExceptions", { state: "uncaught" }); } catch { }
    state.debug.enabled = true;
  }
  async function debugClearBreakpoints() {
    for (const id of state.debug.breakpointIds || []) {
      try { await cdp("Debugger.removeBreakpoint", { breakpointId: id }); } catch { }
    }
    state.debug.breakpointIds = [];
  }
  async function debugPrepare(runner) {
    state.debug.paused = false;
    state.debug.line = null;
    state.debug.vars = {};
    state.debug.frames = [];
    clearDebugLine();
    setDebugStatus("调试器已就绪，运行中…");
    setDebugButtons(false);
  }
  function setDebugStatus(text) { const el = $("debugStatus"); if (el) el.textContent = text; }
  function setDebugButtons(paused) {
    const on = !!paused;
    ["debugResume", "debugStepOver", "debugStepInto", "debugStepOut", "debugEvalBtn"].forEach((id) => { const el = $(id); if (el) el.disabled = !on; });
    const pause = $("debugPause"); if (pause) pause.disabled = !state.running || on;
  }
  function debugFrameSourceLine(frame) {
    if (!frame || !frame.location) return -1;
    const offset = Math.max(0, (state.runMeta && state.runMeta.sourceStartLine ? state.runMeta.sourceStartLine : 1) - 1);
    return (frame.location.lineNumber || 0) - offset;
  }
  function clearDebugLine() {
    if (cm && state.debug.pausedLine != null) {
      try { cm.removeLineClass(state.debug.pausedLine, "background", "cm-debug-paused"); } catch { }
    }
    state.debug.pausedLine = null;
  }
  function debugOnPausedLocal(d) {
    state.debug.paused = true;
    state.debug.line = Number(d.line) || 0;
    state.debug.vars = d.vars || {};
    clearDebugLine();
    if (cm && state.debug.line >= 0 && state.debug.line < cm.lineCount()) {
      state.debug.pausedLine = state.debug.line;
      cm.addLineClass(state.debug.pausedLine, "background", "cm-debug-paused");
      cm.setCursor({ line: state.debug.pausedLine, ch: 0 });
      cm.scrollIntoView({ line: state.debug.pausedLine, ch: 0 }, 100);
    }
    setBottomTab("debug");
    setDebugButtons(true);
    setDebugStatus("已暂停 · 第 " + (state.debug.line + 1) + " 行");
    renderDebugCallStackLocal();
    renderDebugVariablesLocal();
  }
  function debugOnResumed() {
    state.debug.paused = false;
    state.debug.vars = {};
    clearDebugLine();
    setDebugButtons(false);
    setDebugStatus("运行中…");
    renderDebugCallStackLocal();
    const box = $("debugVariables"); if (box) box.innerHTML = '<div class="debug-empty">暂停后显示变量</div>';
  }
  function renderDebugCallStackLocal() {
    const box = $("debugCallStack");
    if (!box) return;
    box.innerHTML = "";
    const item = document.createElement("button");
    item.type = "button";
    item.className = "debug-stack-item active";
    item.textContent = "脚本顶层  ·  L" + ((state.debug.line || 0) + 1);
    box.appendChild(item);
  }
  function renderDebugVariablesLocal() {
    const box = $("debugVariables");
    if (!box) return;
    const vars = state.debug.vars || {};
    const keys = Object.keys(vars);
    if (!keys.length) { box.innerHTML = '<div class="debug-empty">当前行没有可读取变量</div>'; return; }
    box.innerHTML = '<div class="debug-scope"><div class="debug-scope-title">局部</div>' + keys.map((name) => '<div class="debug-var"><span class="debug-var-name">' + escapeHtml(name) + '</span><span class="debug-var-value">' + escapeHtml(vars[name]) + '</span></div>').join("") + '</div>';
  }
  function sendDebugCommand(command, extra) {
    const frame = $("runFrame");
    if (!frame || !frame.contentWindow) return;
    frame.contentWindow.postMessage(Object.assign({ type: "js-debug-command", runId: state.runSeq, command: command }, extra || {}), "*");
  }
  function debugEval() {
    const input = $("debugEvalInput");
    const expression = input ? input.value.trim() : "";
    if (!expression || !state.debug.paused) return;
    sendDebugCommand("eval", { expression: expression });
  }
  function debugCommand(command) {
    if (command === "resume") { sendDebugCommand("resume"); debugOnResumed(); }
    else if (command === "step") { sendDebugCommand("step"); setDebugStatus("单步执行中…"); }
    else if (command === "pause") sendDebugCommand("pause");
    else sendDebugCommand(command);
  }
  function handleCdpEvent(method, params) {
    if (method === "Debugger.paused") debugOnPaused(params || {});
    else if (method === "Debugger.resumed") debugOnResumed();
  }
  function renderDebugCallStack() {
    const box = $("debugCallStack");
    if (!box) return;
    box.innerHTML = "";
    if (!state.debug.frames.length) {
      box.innerHTML = '<div class="debug-empty">运行中，无暂停栈帧</div>';
      return;
    }
    state.debug.frames.forEach((frame, index) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "debug-stack-item" + (index === state.debug.selectedFrame ? " active" : "");
      const line = debugFrameSourceLine(frame);
      btn.textContent = (frame.functionName || "(anonymous)") + (line >= 0 ? "  ·  L" + (line + 1) : "");
      btn.addEventListener("click", () => {
        state.debug.selectedFrame = index;
        state.debug.frameId = frame.callFrameId;
        renderDebugCallStack();
        renderDebugVariables().catch(() => { });
      });
      box.appendChild(btn);
    });
  }
  async function renderDebugVariables() {
    const box = $("debugVariables");
    if (!box) return;
    const frame = state.debug.frames[state.debug.selectedFrame || 0];
    if (!frame) { box.innerHTML = '<div class="debug-empty">暂停后显示变量</div>'; return; }
    box.innerHTML = '<div class="debug-empty">读取变量…</div>';
    const scopes = Array.isArray(frame.scopeChain) ? frame.scopeChain : [];
    const html = [];
    for (const scope of scopes) {
      if (!scope.object || !scope.object.objectId) continue;
      let props = [];
      try {
        const res = await cdp("Runtime.getProperties", { objectId: scope.object.objectId, ownProperties: true, nonIndexedPropertiesOnly: false });
        props = Array.isArray(res.result) ? res.result : [];
      } catch { }
      if (!props.length) continue;
      html.push('<div class="debug-scope"><div class="debug-scope-title">' + escapeHtml(scope.type || "scope") + '</div>');
      for (const prop of props.slice(0, 120)) {
        if (!prop || prop.name === "__proto__") continue;
        html.push('<div class="debug-var"><span class="debug-var-name">' + escapeHtml(prop.name) + '</span><span class="debug-var-value">' + escapeHtml(debugValue(prop.value)) + '</span></div>');
      }
      html.push('</div>');
    }
    box.innerHTML = html.join("") || '<div class="debug-empty">没有可显示变量</div>';
  }

  async function debugControl(method) {
    try {
      await cdp(method, {});
    } catch (e) {
      setDebugStatus("调试命令失败：" + (e && e.message ? e.message : e));
    }
  }
  function bindDebuggerUi() {
    $("debugTab").addEventListener("click", () => setBottomTab("debug"));
    $("debugResume").addEventListener("click", () => debugCommand("resume"));
    $("debugPause").addEventListener("click", () => debugCommand("pause"));
    $("debugStepOver").addEventListener("click", () => debugCommand("step"));
    $("debugStepInto").addEventListener("click", () => debugCommand("step"));
    $("debugStepOut").addEventListener("click", () => debugCommand("step"));
    $("debugEvalBtn").addEventListener("click", debugEval);
    $("debugEvalInput").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); debugEval(); } });
  }
  function escapeHtml(text) {
    return String(text == null ? "" : text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function initEditor() {
    cm = CodeMirror.fromTextArea($("code"), {
      mode: { name: "javascript" },
      theme: "jsdark",
      lineNumbers: true,
      foldGutter: true,
      gutters: ["breakpoints", "CodeMirror-linenumbers", "CodeMirror-foldgutter"],
      indentUnit: 2,
      tabSize: 2,
      lineWrapping: false,
      autoCloseBrackets: true,
      matchBrackets: true,
      styleActiveLine: true,
      extraKeys: {
        "Ctrl-S": () => saveNow({ manual: true }).catch(showError),
        "Cmd-S": () => saveNow({ manual: true }).catch(showError),
        "Ctrl-Enter": runFile,
        "Cmd-Enter": runFile,
        "Ctrl-Space": () => showJsHint(cm),
        "Alt-Space": () => showJsHint(cm),
        "Shift-Alt-F": formatDocument,
        "Alt-Shift-F": formatDocument,
        "Ctrl-Shift-M": () => runLint({ open: true, manual: true }),
        "F9": () => toggleBreakpoint(cm.getCursor().line),
        "Ctrl-F": () => openFind(false),
        "Cmd-F": () => openFind(false),
        "Ctrl-H": () => openFind(true),
        "Cmd-Alt-F": () => openFind(true),
        "Ctrl-Shift-Z": "redo",
        "Cmd-Shift-Z": "redo",
        "Ctrl-Y": "redo",
        "Ctrl-Shift-[": "fold",
        "Ctrl-Shift-]": "unfold",
        "Ctrl-Alt-[": "foldAll",
        "Ctrl-Alt-]": "unfoldAll",
      },
    });
    cm.on("change", () => {
      if (!state.suppressChange) { markDirty(); scheduleOutline(); }
    });
    cm.on("cursorActivity", () => {
      const pos = cm.getCursor();
      $("statusPos").textContent = "Ln " + (pos.line + 1) + ", Col " + (pos.ch + 1);
    });
    cm.on("gutterClick", (editor, line, gutter) => { if (gutter === "breakpoints") toggleBreakpoint(line); });
    try {
      const breakGutter = cm.getWrapperElement().querySelector(".CodeMirror-gutter.breakpoints");
      if (breakGutter) breakGutter.addEventListener("click", (event) => {
        if (event.target && event.target.closest && event.target.closest(".CodeMirror-foldgutter, .CodeMirror-linenumbers")) return;
        let line = -1;
        try { line = cm.lineAtHeight(event.clientY, "window"); } catch { }
        if (line >= 0) toggleBreakpoint(line);
      });
    } catch { }
    renderBreakpoints();
    cm.on("changes", updateHistoryButtons);
    cm.on("inputRead", (editor, change) => {
      if (state.suppressChange) return;
      const typed = change && change.text ? change.text.join("") : "";
      if (!/[\w$\.]$/.test(typed)) {
        if (editor.state.completionActive) editor.closeHint();
        return;
      }
      if (editor.state.completionActive) {
        // 补全弹窗不会自动按新前缀重新过滤，输入新字符时重建一次候选
        state.hintRefresh = true;
        try { editor.closeHint(); } catch { }
        setTimeout(() => { state.hintRefresh = false; }, 0);
        scheduleJsHint(editor, 40);
        return;
      }
      clearTimeout(editor._jsHintTimer);
      scheduleJsHint(editor);
    });
    cm.on("endCompletion", () => {
      if (state.hintRefresh) return;
      state.autoHintCooldown = Date.now() + 260;
    });
    updateHistoryButtons();
    renderOutline();
  }

  function handleRunnerMessage(d) {
    if (!d || d.runId !== state.runSeq) return;
    if (d.type === "js-run-console") {
      if (d.runtime) appendRuntimeError(Array.isArray(d.args) ? d.args.join(" ") : String(d.args || ""), d.stack || "");
      else appendConsole(d.level, d.args);
      return;
    }
    if (d.type === "js-debug-paused") { debugOnPausedLocal(d); return; }
    if (d.type === "js-debug-eval") { const out = $("debugEvalResult"); if (out) out.textContent = String(d.value == null ? "" : d.value); return; }
    if (d.type === "js-run-done") endRun(!!d.hadError);
  }

  function bind() {
    $("themeSelect").addEventListener("change", () => applyTheme($("themeSelect").value));
    $("saveBtn").addEventListener("click", () => saveNow({ manual: true }).catch(showError));
    $("runBtn").addEventListener("click", () => { if (state.running) stopRun(); else runFile(); });
    $("runSelectionBtn").addEventListener("click", runSelection);
    $("clearConsoleBtn").addEventListener("click", clearConsole);
    $("refreshBtn").addEventListener("click", () => loadProject().catch(showError));
    $("undoBtn").addEventListener("click", () => { cm.undo(); cm.focus(); updateHistoryButtons(); });
    $("redoBtn").addEventListener("click", () => { cm.redo(); cm.focus(); updateHistoryButtons(); });
    $("foldAllBtn").addEventListener("click", () => { try { cm.execCommand("foldAll"); } catch (e) { toast("折叠失败：" + e.message, true); } });
    $("unfoldAllBtn").addEventListener("click", () => { try { cm.execCommand("unfoldAll"); } catch (e) { toast("展开失败：" + e.message, true); } });
    $("hintBtn").addEventListener("click", () => { cm.focus(); showJsHint(cm); });
    $("formatBtn").addEventListener("click", formatDocument);
    $("lintBtn").addEventListener("click", () => runLint({ open: true, manual: true }));
    $("breakpointBtn").addEventListener("click", () => { cm.focus(); toggleBreakpoint(cm.getCursor().line); });
    $("consoleTab").addEventListener("click", () => setBottomTab("console"));
    $("problemsTab").addEventListener("click", () => setBottomTab("problems"));
    $("consoleAutoScroll").addEventListener("change", () => { state.consoleAutoScroll = $("consoleAutoScroll").checked; });
    $("workerSandbox").addEventListener("change", () => { state.workerSandbox = $("workerSandbox").checked; });
    $("copyConsoleBtn").addEventListener("click", copyConsole);
    initPaneResizers();
    $("findBtn").addEventListener("click", () => { if (state.find.open) closeFind(); else openFind(false); });
    $("findClose").addEventListener("click", closeFind);
    $("findPrev").addEventListener("click", () => findNext(-1));
    $("findNext").addEventListener("click", () => findNext(1));
    $("replaceBtn").addEventListener("click", replaceCurrent);
    $("replaceAllBtn").addEventListener("click", replaceAll);
    $("findInput").addEventListener("input", () => {
      rebuildFindMatches(false);
      if (state.find.query && state.find.matches.length) {
        state.find.index = nearestMatchFromCursor();
        showFindMatch(state.find.index);
      }
    });
    $("findCase").addEventListener("change", () => rebuildFindMatches(false));
    $("findInput").addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); findNext(event.shiftKey ? -1 : 1); }
      else if (event.key === "Escape") { event.preventDefault(); closeFind(); }
    });
    $("replaceInput").addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); replaceCurrent(); }
      else if (event.key === "Escape") { event.preventDefault(); closeFind(); }
    });
    $("replInput").addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      const value = $("replInput").value;
      if (!value.trim()) return;
      $("replInput").value = "";
      runRepl(value);
    });
    window.addEventListener("message", (event) => {
      if (event.source !== $("runFrame").contentWindow) return;
      handleRunnerMessage(event.data || {});
    });
    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && state.find.open) { event.preventDefault(); closeFind(); }
    });
  }

  async function init() {
    if (SHELL_MODE) document.documentElement.dataset.shell = "1";
    setupFoldHelpers();
    initTheme();
    initEditor();
    bindDebuggerUi();
    language = window.createLyraLanguageService({
      getCm: () => cm,
      getState: () => state,
      hostCall: hostCall,
      switchFile: switchFile,
      toast: toast,
      setStatus: setStatus,
      encodeText: encodeText,
      decodeText: decodeText,
      afterMutation: async () => { if (cm) { cm.focus(); } },
    });
    if (language) { language.attachEditor(cm); language.bindUi(); }
    bind();
    updateChrome();
    setStatus("正在读取项目…");
    try { await loadProject(); setStatus("就绪"); }
    catch (e) { showError(e); }
  }

  init();
})();
