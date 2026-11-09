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
    hintSymbolsValue: null,
    hintSymbols: [],
    autoSaveTimer: 0,
    saveInFlight: false,
    saveQueued: false,
    running: false,
    runSeq: 0,
    runStartedAt: 0,
    find: { matches: [], index: -1, query: "", caseSensitive: false, open: false },
  };
  let cm = null;

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
    updateHistoryButtons();
    setStatus("已加载");
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

  function appendConsole(level, args, extraClass) {
    const out = $("consoleOutput");
    const empty = out.querySelector(".console-empty");
    if (empty) empty.remove();
    const line = document.createElement("div");
    line.className = "console-line " + (level || "log") + (extraClass ? " " + extraClass : "");
    const lv = document.createElement("span");
    lv.className = "console-level";
    lv.textContent = (level || "log").toUpperCase();
    const text = document.createElement("span");
    text.className = "console-text";
    text.textContent = Array.isArray(args) ? args.join(" ") : String(args == null ? "" : args);
    line.append(lv, text);
    out.appendChild(line);
    out.scrollTop = out.scrollHeight;
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
      "var __send=function(level,args){try{parent.postMessage({type:'js-run-console',runId:__runId,level:level,args:args.map(function(v){try{if(v instanceof Error)return v.stack||v.message;if(typeof v==='object')return JSON.stringify(v);return String(v);}catch(e){return String(v);}})} ,'*');}catch(e){}};",
      "['log','info','warn','error','debug'].forEach(function(level){var orig=console[level];console[level]=function(){__send(level,Array.prototype.slice.call(arguments));try{if(orig)orig.apply(console,arguments);}catch(e){}};});",
      "window.addEventListener('error',function(e){__hadError=true;__send('error',[e.message+(e.lineno?(' (line '+e.lineno+')'):'')]);});",
      "window.addEventListener('unhandledrejection',function(e){__hadError=true;__send('error',['Unhandled rejection: '+String(e.reason)]);});",
    ].join("\n");
    const done = "setTimeout(function(){parent.postMessage({type:'js-run-done',runId:__runId,hadError:__hadError},'*');},0);";
    return "<!DOCTYPE html><html><head><meta charset=\"utf-8\"></head><body><script>\n(function(){\n" +
      hooks + "\ntry {\n" + safeCode + "\n} catch (e) { __hadError=true; __send('error', [e && e.stack ? e.stack : String(e)]); }\n" + done + "\n})();\n<\/script></body></html>";
  }

  function startRun(label, code) {
    if (state.running) stopRun();
    appendRunSeparator();
    state.runSeq += 1;
    state.running = true;
    state.runStartedAt = Date.now();
    appendConsole("info", ["▶ " + label + "  ·  " + fullPath(state.currentRel)], "run-start");
    setRunUi(true);
    try {
      $("runFrame").srcdoc = buildRunner(code, state.runSeq);
    } catch (e) {
      appendConsole("error", [String(e && e.message ? e.message : e)]);
      state.running = false;
      setRunUi(false);
    }
  }

  function endRun(hadError) {
    if (!state.running) return;
    state.running = false;
    const ms = Math.max(0, Date.now() - state.runStartedAt);
    appendConsole(hadError ? "error" : "info", [(hadError ? "✕ 运行结束（有错误）" : "✓ 运行结束") + "  ·  " + ms + " ms"], "run-done");
    setRunUi(false);
  }

  function stopRun() {
    if (!state.running) return;
    state.running = false;
    state.runSeq += 1;
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
    startRun("运行选中代码", code);
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
      return list.length ? { list: list, from: from, to: cursor } : null;
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
    return items.length ? { list: items, from: from, to: cursor } : null;
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
    return word.length >= 2;
  }

  function scheduleJsHint(cm) {
    clearTimeout(cm._jsHintTimer);
    cm._jsHintTimer = setTimeout(() => {
      if (shouldAutoHint(cm)) showJsHint(cm);
    }, 180);
  }

  function initEditor() {
    cm = CodeMirror.fromTextArea($("code"), {
      mode: { name: "javascript" },
      theme: "jsdark",
      lineNumbers: true,
      foldGutter: true,
      gutters: ["CodeMirror-linenumbers", "CodeMirror-foldgutter"],
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
    cm.on("changes", updateHistoryButtons);
    cm.on("inputRead", (editor, change) => {
      if (state.suppressChange) return;
      const typed = change && change.text ? change.text.join("") : "";
      if (!/[\w$\.]$/.test(typed)) return;
      clearTimeout(editor._jsHintTimer);
      scheduleJsHint(editor);
    });
    cm.on("endCompletion", () => {
      state.autoHintCooldown = Date.now() + 260;
    });
    updateHistoryButtons();
    renderOutline();
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
      const d = event.data || {};
      if (d.type === "js-run-console") { if (d.runId === state.runSeq) appendConsole(d.level, d.args); return; }
      if (d.type === "js-run-done") { if (d.runId === state.runSeq) endRun(!!d.hadError); }
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
    bind();
    updateChrome();
    setStatus("正在读取项目…");
    try { await loadProject(); setStatus("就绪"); }
    catch (e) { showError(e); }
  }

  init();
})();
