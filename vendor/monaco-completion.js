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

  function displayParts(parts) { return (parts || []).map((p) => p.text || "").join(""); }

  function referencesAt(cm, pos) {
    if (!cm || !ts) return null;
    try {
      const handle = getService(cm.getValue());
      const refs = handle.instance.findReferences(handle.fileName, cm.indexFromPos(pos || cm.getCursor()), {});
      if (!refs || !refs.length) return null;
      const out = [];
      for (const symbol of refs) for (const ref of symbol.references || []) {
        if (ref.isDefinition && false) continue;
        out.push(cm.posFromIndex(ref.textSpan.start));
      }
      return out.length ? out : null;
    } catch { return null; }
  }

  function renameAt(cm, pos, newName) {
    if (!cm || !ts) return null;
    try {
      const handle = getService(cm.getValue());
      const locations = handle.instance.findRenameLocations(handle.fileName, cm.indexFromPos(pos || cm.getCursor()), false, false);
      if (!locations || !locations.length) return null;
      return locations.map((loc) => ({ start: cm.posFromIndex(loc.textSpan.start), end: cm.posFromIndex(loc.textSpan.start + loc.textSpan.length) }));
    } catch { return null; }
  }

  function signatureAt(cm) {
    if (!cm || !ts) return null;
    try {
      const handle = getService(cm.getValue());
      const help = handle.instance.getSignatureHelpItems(handle.fileName, cm.indexFromPos(cm.getCursor()), {});
      if (!help || !help.items || !help.items.length) return null;
      const item = help.items[0];
      const label = (parts) => (parts || []).map((p) => p.text || "").join("");
      return {
        prefix: label(item.prefixDisplayParts),
        params: (item.parameters || []).map((p) => ({ label: label(p.displayParts) })),
        suffix: label(item.suffixDisplayParts),
        active: help.argumentIndex || 0,
      };
    } catch { return null; }
  }

  function definitionAt(cm, pos) {
    if (!cm || !ts) return null;
    try {
      const handle = getService(cm.getValue());
      const at = pos || cm.getCursor();
      const defs = handle.instance.getDefinitionAtPosition(handle.fileName, cm.indexFromPos(at));
      if (!defs || !defs.length) return null;
      const def = defs.find((d) => d.fileName === handle.fileName) || defs[0];
      if (def.fileName !== handle.fileName) return null;
      return cm.posFromIndex(def.textSpan.start);
    } catch { return null; }
  }

  function hoverAt(cm, pos, word) {
    if (!cm || !ts) return null;
    try {
      const handle = getService(cm.getValue());
      const at = word ? word.from : pos;
      const qi = handle.instance.getQuickInfoAtPosition(handle.fileName, cm.indexFromPos(at));
      if (!qi || !qi.displayParts || !qi.displayParts.length) return null;
      const docs = [];
      if (qi.documentation) docs.push(displayParts(qi.documentation));
      for (const tag of qi.tags || []) docs.push("@" + tag.name + (tag.text ? " " + displayParts(tag.text) : ""));
      const lineText = cm.getLine(pos.line) || "";
      const before = lineText.slice(0, word ? word.from.ch : pos.ch);
      const owner = (before.match(/([A-Za-z_$][\w$]*)\s*\.\s*$/) || [])[1];
      return {
        name: word ? (owner ? owner + "." + (word.text || word.name) : (word.text || word.name)) : "",
        display: displayParts(qi.displayParts),
        documentation: docs.filter(Boolean).join("\n"),
        kind: qi.kind || "",
        line: pos.line + 1,
      };
    } catch { return null; }
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

  window.MonacoCompletion = { hintAt: hintAt, hoverAt: hoverAt, signatureAt: signatureAt, definitionAt: definitionAt, referencesAt: referencesAt, renameAt: renameAt, kindOf: kindOf };
})();
