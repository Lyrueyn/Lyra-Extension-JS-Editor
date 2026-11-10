(function () {
  "use strict";
  const MONACO = window.MonacoTS;
  const ts = MONACO && MONACO.ts && (MONACO.ts.typescript || MONACO.ts);
  const LIB = MONACO && MONACO.libFileMap;
  if (!ts) return;

  function libText(file) {
    if (!LIB) return undefined;
    if (LIB[file]) return LIB[file];
    const base = String(file || "").split("/").pop();
    const candidates = ["lib." + base + ".d.ts", "lib." + base.replace(/^lib\./, "").replace(/\.d\.ts$/, "") + ".d.ts", base + ".d.ts"];
    for (const name of candidates) if (LIB[name]) return LIB[name];
    return undefined;
  }
  let service = null;
  let serviceValue = null;

  function getService(code) {
    if (service && serviceValue === code) return service;
    const fileName = "editor.js";
    const libs = LIB || {};
    const host = {
      getCompilationSettings: () => ({ allowJs: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, lib: ["dom", "es2022", "dom.iterable", "scripthost"], noEmit: true, allowNonTsExtensions: true }),
      getScriptFileNames: () => [fileName],
      getScriptVersion: () => "1",
      getScriptSnapshot: (f) => {
        if (f === fileName) return ts.ScriptSnapshot.fromString(code);
        const content = libText(f);
        return content === undefined ? undefined : ts.ScriptSnapshot.fromString(content);
      },
      getCurrentDirectory: () => "",
      getDefaultLibFileName: () => libs["lib.es2022.full.d.ts"] ? "lib.es2022.full.d.ts" : "lib.d.ts",
      getScriptKind: () => ts.ScriptKind.JS,
      fileExists: (f) => f === fileName || libText(f) !== undefined,
      readFile: (f) => f === fileName ? code : libText(f),
      getNewLine: () => "\n",
    };
    service = { fileName: fileName, instance: ts.createLanguageService(host) };
    serviceValue = code;
    return service;
  }

  function kindOf(entryKind) {
    const k = String(entryKind || "");
    if (/function|method|constructor/.test(k)) return "fn";
    if (/class|interface|enum/.test(k)) return "class";
    if (/keyword/.test(k)) return "kw";
    if (/property|field|getter|setter/.test(k)) return "prop";
    if (/const|let|var|local/.test(k)) return "var";
    if (/module|alias/.test(k)) return "global";
    return "var";
  }

  function hintAt(cm) {
    if (!cm || !ts) return null;
    const cursor = cm.getCursor();
    const lineText = cm.getLine(cursor.line) || "";
    const before = lineText.slice(0, cursor.ch);
    const word = (before.match(/[A-Za-z_$][\w$]*$/) || [""])[0];
    const from = { line: cursor.line, ch: cursor.ch - word.length };
    const offset = cm.indexFromPos(cursor);
    let comp = null;
    try { comp = getService(cm.getValue()).instance.getCompletionsAtPosition(getService(cm.getValue()).fileName, offset, {}); } catch { }
    if (!comp || !comp.entries || !comp.entries.length) return null;
    const seen = new Set();
    const list = [];
    for (const entry of comp.entries) {
      if (!entry.name || seen.has(entry.name)) continue;
      if (word && !entry.name.toLowerCase().startsWith(word.toLowerCase())) continue;
      seen.add(entry.name);
      list.push(entry);
    }
    if (!list.length) return null;
    return {
      list: list,
      from: from,
      to: cursor,
      render: function (el, self, item) {
        const data = item || self || {};
        const row = document.createElement("span");
        row.className = "js-hint-row";
        const badge = document.createElement("span");
        badge.className = "js-hint-kind js-hint-" + (data.kind || "var");
        badge.textContent = ({ fn: "FN", class: "CLS", kw: "KW", prop: "PROP", var: "VAR", global: "GLB" })[data.kind] || "·";
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
      },
    };
  }

  window.MonacoCompletion = { hintAt: hintAt, kindOf: kindOf };
})();
