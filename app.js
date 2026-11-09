(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const host = window.chrome && window.chrome.webview ? window.chrome.webview : null;
  const params = new URLSearchParams(location.search);
  const JS_EXT = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx"]);
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
    runSeq: 0,
  };
  let cm = null;

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
  function dirOf(rel) {
    const s = String(rel || "");
    const i = s.lastIndexOf("/");
    return i >= 0 ? s.slice(0, i) : "";
  }
  function classify(rel) {
    const ext = extOf(rel);
    if (JS_EXT.has(ext) || ext === ".json") return ext === ".json" ? "json" : "js";
    if (ext === ".html" || ext === ".htm") return "html";
    if (ext === ".css") return "css";
    return "other";
  }

  function hostCall(type, payload) {
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

  function languageFor(rel) {
    const kind = classify(rel);
    if (kind === "json") return { mode: { name: "javascript", json: true }, badge: "JSON" };
    if (kind === "js") return { mode: { name: "javascript" }, badge: JS_EXT.has(extOf(rel)) && (extOf(rel) === ".ts" || extOf(rel) === ".tsx") ? "TypeScript" : "JavaScript" };
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
    if (kind === "css") {
      toast("还没有 CSS 编辑器插件，暂时不能编辑 " + rel, true);
      return;
    }
    toast("没有适配这个文件类型的编辑器插件：" + rel, true);
  }

  function updateChrome() {
    $("projectName").textContent = state.projectName || "";
    $("currentFile").textContent = state.currentRel || "未打开文件";
    $("currentFile").classList.toggle("dirty", state.dirty);
    $("dirtyBadge").hidden = !state.dirty;
    $("statusFile").textContent = state.currentRel || "";
    const lang = languageFor(state.currentRel);
    $("languageBadge").textContent = lang.badge;
    if (cm) {
      const pos = cm.getCursor();
      $("statusPos").textContent = "Ln " + (pos.line + 1) + ", Col " + (pos.ch + 1);
    }
  }

  function markDirty() {
    if (!state.currentRel) return;
    state.dirty = cm.getValue() !== state.cleanValue;
    $("dirtyBadge").hidden = !state.dirty;
    $("currentFile").classList.toggle("dirty", state.dirty);
    setStatus(state.dirty ? "未保存" : "已保存");
    scheduleOutline();
  }

  async function saveNow() {
    if (!state.currentRel || !cm) return;
    if (!state.dirty) { setStatus("已保存"); return; }
    const value = cm.getValue();
    await hostCall("host.workspace.save", { path: state.currentRel, data: encodeText(value) });
    state.cleanValue = value;
    state.dirty = false;
    $("dirtyBadge").hidden = true;
    $("currentFile").classList.remove("dirty");
    setStatus("已保存");
  }

  async function switchFile(rel) {
    if (!rel || rel === state.currentRel) return;
    if (state.dirty) { try { await saveNow(); } catch (e) { toast("切换文件前保存失败：" + e.message, true); return; } }
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
    function add(name, kind, index) {
      if (!name || seen.has(name)) return;
      seen.add(name);
      out.push({ name, kind, line: index + 1 });
    }
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

  function appendConsole(level, args) {
    const out = $("consoleOutput");
    const empty = out.querySelector(".console-empty");
    if (empty) empty.remove();
    const line = document.createElement("div");
    line.className = "console-line " + (level || "log");
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

  function clearConsole() {
    $("consoleOutput").innerHTML = '<div class="console-empty">点击「运行文件」或「运行选中」执行 JavaScript，console.log 会输出到这里。</div>';
    $("statusRun").textContent = "";
  }

  function buildRunner(code) {
    const safeCode = String(code || "").replace(/<\/script/gi, "<\\/script");
    const hooks = [
      "var __send=function(level,args){try{parent.postMessage({type:'js-run-console',level:level,args:args.map(function(v){try{if(v instanceof Error)return v.stack||v.message;if(typeof v==='object')return JSON.stringify(v);return String(v);}catch(e){return String(v);}})} ,'*');}catch(e){}};",
      "['log','info','warn','error','debug'].forEach(function(level){var orig=console[level];console[level]=function(){__send(level,Array.prototype.slice.call(arguments));try{if(orig)orig.apply(console,arguments);}catch(e){}};});",
      "window.addEventListener('error',function(e){__send('error',[e.message+(e.lineno?(' (line '+e.lineno+')'):'')]);});",
      "window.addEventListener('unhandledrejection',function(e){__send('error',['Unhandled rejection: '+String(e.reason)]);});",
    ].join("\n");
    return "<!DOCTYPE html><html><head><meta charset=\"utf-8\"></head><body><script>\n(function(){\n" +
      hooks + "\ntry {\n" + safeCode + "\n} catch (e) { __send('error', [e && e.stack ? e.stack : String(e)]); }\n})();\n<\/script></body></html>";
  }

  function executeSnippet(code, label) {
    $("consoleOutput").querySelectorAll(".console-empty").forEach((n) => n.remove());
    state.runSeq += 1;
    const seq = state.runSeq;
    appendConsole("info", ["▶ " + label]);
    $("statusRun").textContent = "运行中";
    try { $("runFrame").srcdoc = buildRunner(code); }
    catch (e) { appendConsole("error", [String(e && e.message ? e.message : e)]); }
    setTimeout(() => { if (seq === state.runSeq) { $("statusRun").textContent = ""; } }, 600);
  }

  function runFile() {
    if (!cm || !state.currentRel) { toast("先打开一个 .js 文件", true); return; }
    executeSnippet(cm.getValue(), "运行文件 " + state.currentRel);
  }

  function runSelection() {
    if (!cm) return;
    const code = cm.getSelection();
    if (!code || !code.trim()) { toast("先在编辑器里选中一段 JavaScript", true); cm.focus(); return; }
    executeSnippet(code, "运行选中代码");
  }

  function runRepl(expression) {
    const expr = String(expression || "").trim();
    if (!expr) return;
    appendConsole("info", ["> " + expr]);
    const code = "try { var __r = (" + expr + "); __send('log', [typeof __r === 'object' ? JSON.stringify(__r) : String(__r)]); } catch (__e) { __send('error', [__e && __e.stack ? __e.stack : String(__e)]); }";
    try { $("runFrame").srcdoc = buildRunner(code); }
    catch (e) { appendConsole("error", [String(e && e.message ? e.message : e)]); }
  }

  function initEditor() {
    cm = CodeMirror.fromTextArea($("code"), {
      mode: { name: "javascript" },
      theme: "jsdark",
      lineNumbers: true,
      indentUnit: 2,
      tabSize: 2,
      lineWrapping: false,
      autoCloseBrackets: true,
      matchBrackets: true,
      styleActiveLine: true,
      extraKeys: {
        "Ctrl-S": () => saveNow().catch(showError),
        "Cmd-S": () => saveNow().catch(showError),
        "Ctrl-Enter": runFile,
        "Cmd-Enter": runFile,
      },
    });
    cm.on("change", () => {
      if (!state.suppressChange) { markDirty(); scheduleOutline(); }
    });
    cm.on("cursorActivity", () => {
      const pos = cm.getCursor();
      $("statusPos").textContent = "Ln " + (pos.line + 1) + ", Col " + (pos.ch + 1);
    });
  }

  function bind() {
    $("saveBtn").addEventListener("click", () => saveNow().catch(showError));
    $("runBtn").addEventListener("click", runFile);
    $("runSelectionBtn").addEventListener("click", runSelection);
    $("clearConsoleBtn").addEventListener("click", clearConsole);
    $("refreshBtn").addEventListener("click", () => loadProject().catch(showError));
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
      if (d.type !== "js-run-console") return;
      appendConsole(d.level, d.args);
      if (d.level === "error") $("statusRun").textContent = "运行错误";
    });
  }

  async function init() {
    initEditor();
    bind();
    updateChrome();
    setStatus("正在读取项目…");
    try { await loadProject(); setStatus("就绪"); }
    catch (e) { showError(e); }
  }

  init();
})();
