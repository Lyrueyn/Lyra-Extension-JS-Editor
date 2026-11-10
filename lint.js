(() => {
  "use strict";

  const GLOBALS = new Set([
    "console", "window", "document", "globalThis", "self", "top", "parent", "frames",
    "Math", "JSON", "Object", "Array", "String", "Number", "Boolean", "Date", "RegExp",
    "Promise", "Map", "Set", "WeakMap", "WeakSet", "Symbol", "BigInt", "Proxy", "Reflect",
    "Error", "TypeError", "RangeError", "SyntaxError", "EvalError", "ReferenceError",
    "NaN", "Infinity", "undefined", "eval", "isFinite", "isNaN", "parseFloat", "parseInt",
    "encodeURI", "decodeURI", "encodeURIComponent", "decodeURIComponent", "escape", "unescape",
    "setTimeout", "clearTimeout", "setInterval", "clearInterval", "requestAnimationFrame",
    "cancelAnimationFrame", "requestIdleCallback", "cancelIdleCallback", "queueMicrotask",
    "fetch", "alert", "confirm", "prompt", "localStorage", "sessionStorage", "indexedDB",
    "location", "navigator", "history", "screen", "devicePixelRatio", "innerWidth", "innerHeight",
    "outerWidth", "outerHeight", "scrollX", "scrollY", "pageXOffset", "pageYOffset",
    "addEventListener", "removeEventListener", "dispatchEvent", "getComputedStyle", "matchMedia",
    "atob", "btoa", "TextEncoder", "TextDecoder", "URL", "URLSearchParams", "Blob", "File",
    "FileReader", "FormData", "Headers", "Request", "Response", "AbortController", "AbortSignal",
    "Image", "Audio", "Option", "WebSocket", "XMLHttpRequest", "MutationObserver",
    "IntersectionObserver", "ResizeObserver", "CustomEvent", "Event", "EventTarget", "Node",
    "Element", "HTMLElement", "HTMLDocument", "DocumentFragment", "NodeList", "HTMLCollection",
    "DOMParser", "XMLSerializer", "Notification", "Worker", "SharedWorker", "ServiceWorker",
    "crypto", "performance", "structuredClone", "arguments", "require", "module", "exports",
    "process", "Buffer", "__dirname", "__filename", "WebAssembly", "Intl", "reportError",
    "CSS", "CSSStyleSheet", "HTMLCanvasElement", "CanvasRenderingContext2D",
  ]);
  const TERMINATORS = new Set(["ReturnStatement", "ThrowStatement", "BreakStatement", "ContinueStatement"]);
  const PARAM_KINDS = new Set(["param", "catch"]);

  function analyzeAst(code) {
    const acorn = window.acorn || (typeof acorn !== "undefined" ? acorn : null);
    if (!acorn || typeof acorn.parse !== "function") throw new Error("语法解析库没有加载");
    return acorn.parse(code, {
      ecmaVersion: "latest",
      sourceType: "module",
      locations: true,
      allowHashBang: true,
      allowAwaitOutsideFunction: true,
    });
  }

  function lintCode(code) {
    const problems = [];
    let ast;
    try {
      ast = analyzeAst(code);
    } catch (err) {
      const line = err && err.loc ? err.loc.line : 1;
      const col = err && err.loc ? err.loc.column : 0;
      problems.push({ line, ch: col, severity: "error", rule: "syntax", message: "语法错误：" + String(err && err.message || err).replace(/\s*\(\d+:\d+\)$/, "") });
      return problems;
    }

    const declarations = [];
    const declaredNodes = new Set();
    const refs = new Map();

    function addDecl(name, kind, node, isExported) {
      if (!name || declaredNodes.has(node)) return;
      declaredNodes.add(node);
      declarations.push({ name, kind, node, line: node.loc.start.line, ch: node.loc.start.column, exported: !!isExported });
    }

    function collectPattern(node, kind, isExported) {
      if (!node) return;
      switch (node.type) {
        case "Identifier": addDecl(node.name, kind, node, isExported); break;
        case "ObjectPattern":
          for (const prop of node.properties || []) {
            if (prop.type === "RestElement") collectPattern(prop.argument, kind, isExported);
            else {
              if (prop.shorthand && prop.key && prop.key.type === "Identifier") declaredNodes.add(prop.key);
              if (prop.value) collectPattern(prop.value, kind, isExported);
            }
          }
          break;
        case "ArrayPattern":
          for (const item of node.elements || []) collectPattern(item, kind, isExported);
          break;
        case "AssignmentPattern": collectPattern(node.left, kind, isExported); break;
        case "RestElement": collectPattern(node.argument, kind, isExported); break;
      }
    }

    function forEachChild(node, callback) {
      for (const key in node) {
        if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
        if (key === "loc" || key === "start" || key === "end" || key === "range" || key === "type") continue;
        const value = node[key];
        if (Array.isArray(value)) {
          for (const child of value) if (child && typeof child.type === "string") callback(child, node, key);
        } else if (value && typeof value.type === "string") {
          callback(value, node, key);
        }
      }
    }

    function visitDecls(node, ancestors) {
      const isExported = ancestors.some((a) => a.type === "ExportNamedDeclaration" || a.type === "ExportDefaultDeclaration");
      switch (node.type) {
        case "FunctionDeclaration":
        case "FunctionExpression":
        case "ArrowFunctionExpression":
          if (node.id) addDecl(node.id.name, "function", node.id, isExported);
          for (const param of node.params || []) collectPattern(param, "param", isExported);
          break;
        case "ClassDeclaration":
        case "ClassExpression":
          if (node.id) addDecl(node.id.name, "class", node.id, isExported);
          break;
        case "VariableDeclarator":
          collectPattern(node.id, "variable", isExported);
          break;
        case "ImportSpecifier":
        case "ImportDefaultSpecifier":
        case "ImportNamespaceSpecifier":
          if (node.local) addDecl(node.local.name, "import", node.local, false);
          break;
        case "CatchClause":
          if (node.param) collectPattern(node.param, "catch", false);
          break;
      }
      ancestors.push(node);
      forEachChild(node, (child) => visitDecls(child, ancestors));
      ancestors.pop();
    }
    visitDecls(ast, []);

    function isReference(node, parent) {
      if (!parent) return true;
      switch (parent.type) {
        case "MemberExpression": return parent.object === node || !!parent.computed;
        case "Property":
          if (parent.shorthand) return true;
          if (parent.key === node && !parent.computed) return false;
          return true;
        case "MethodDefinition":
        case "PropertyDefinition": return parent.key !== node || !!parent.computed;
        case "LabeledStatement":
        case "BreakStatement":
        case "ContinueStatement":
        case "ImportSpecifier":
        case "ImportDefaultSpecifier":
        case "ImportNamespaceSpecifier":
        case "MetaProperty":
        case "ObjectPattern":
        case "ArrayPattern":
        case "AssignmentPattern":
        case "RestElement":
          return false;
        case "ExportSpecifier": return parent.local === node;
        case "VariableDeclarator": return parent.id !== node;
        case "FunctionDeclaration":
        case "FunctionExpression":
        case "ArrowFunctionExpression":
          if (parent.id === node) return false;
          if (parent.params && parent.params.includes(node)) return false;
          return true;
        case "ClassDeclaration":
        case "ClassExpression": return parent.id !== node;
      }
      return true;
    }

    function addRef(node) {
      const item = refs.get(node.name);
      if (item) item.count += 1;
      else refs.set(node.name, { count: 1, node });
    }

    function visitRefs(node, parent) {
      if (node.type === "Identifier") {
        if (!declaredNodes.has(node) && isReference(node, parent)) addRef(node);
        return;
      }
      if (node.type === "PrivateIdentifier") return;
      forEachChild(node, (child, childParent) => visitRefs(child, childParent));
    }
    visitRefs(ast, null);

    const reported = new Set();
    function pushProblem(line, ch, severity, rule, message) {
      const key = rule + ":" + line + ":" + ch + ":" + message;
      if (reported.has(key) || problems.length >= 300) return;
      reported.add(key);
      problems.push({ line, ch, severity, rule, message });
    }

    for (const decl of declarations) {
      const name = decl.name;
      if (!name || name.startsWith("_") || decl.exported || PARAM_KINDS.has(decl.kind)) continue;
      const used = refs.get(name);
      if (!used || used.count === 0) pushProblem(decl.line, decl.ch, "warning", "no-unused-vars", "已声明但未使用：'" + name + "'");
    }

    for (const [name, item] of refs) {
      if (GLOBALS.has(name) || name.startsWith("_")) continue;
      if (!declarations.some((d) => d.name === name)) pushProblem(item.node.loc.start.line, item.node.loc.start.column, "warning", "no-undef", "未定义的变量：'" + name + "'");
    }

    function checkFunction(node) {
      if (!node || !node.params) return;
      const seen = new Set();
      for (const param of node.params) {
        const names = [];
        (function collect(p) {
          if (!p) return;
          if (p.type === "Identifier") names.push(p.name);
          else if (p.type === "AssignmentPattern") collect(p.left);
          else if (p.type === "RestElement") collect(p.argument);
          else if (p.type === "ObjectPattern") for (const prop of p.properties || []) collect(prop.value || prop.argument);
          else if (p.type === "ArrayPattern") for (const item of p.elements || []) collect(item);
        })(param);
        for (const name of names) {
          if (seen.has(name)) pushProblem(param.loc.start.line, param.loc.start.column, "warning", "no-dupe-args", "参数重复：'" + name + "'");
          seen.add(name);
        }
      }
    }

    function walkChecks(node) {
      if (!node || typeof node.type !== "string") return;
      if (node.type === "BinaryExpression" && (node.operator === "==" || node.operator === "!=")) {
        const isNull = (n) => n && n.type === "Literal" && n.value === null;
        if (!isNull(node.left) && !isNull(node.right)) pushProblem(node.loc.start.line, node.loc.start.column, "warning", "eqeqeq", "建议使用 " + node.operator + "= 而不是 " + node.operator);
      }
      if (node.type === "DebuggerStatement") pushProblem(node.loc.start.line, node.loc.start.column, "warning", "no-debugger", "不要在生产代码中留下 debugger");
      if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") checkFunction(node);
      if (node.type === "ObjectExpression") {
        const keys = new Set();
        for (const prop of node.properties || []) {
          if (prop.type !== "Property" || prop.computed) continue;
          const key = prop.key;
          const name = key && (key.type === "Identifier" ? key.name : key.type === "Literal" ? String(key.value) : "");
          if (!name) continue;
          if (keys.has(name)) pushProblem(prop.key.loc.start.line, prop.key.loc.start.column, "warning", "no-dupe-keys", "对象字面量键重复：'" + name + "'");
          keys.add(name);
        }
      }
      if (node.type === "BlockStatement" || node.type === "Program") {
        let terminated = false;
        for (const stmt of node.body || []) {
          if (terminated && !["FunctionDeclaration", "EmptyStatement"].includes(stmt.type)) pushProblem(stmt.loc.start.line, stmt.loc.start.column, "warning", "no-unreachable", "这行代码不可达");
          if (TERMINATORS.has(stmt.type)) terminated = true;
        }
      }
      forEachChild(node, (child) => walkChecks(child));
    }
    walkChecks(ast);

    problems.sort((a, b) => a.line - b.line || a.ch - b.ch);
    return problems;
  }

  function formatCode(code, kind) {
    const text = String(code || "");
    if (kind === "json") return JSON.stringify(JSON.parse(text), null, 2) + "\n";
    const beautify = window.js_beautify || (typeof js_beautify !== "undefined" ? js_beautify : null);
    if (typeof beautify !== "function") throw new Error("代码格式化库没有加载");
    let out = beautify(text, { indent_size: 2, indent_char: " ", brace_style: "collapse", preserve_newlines: true, max_preserve_newlines: 2, end_with_newline: true, space_before_conditional: true, wrap_line_length: 0 });
    out = out.replace(/(^\s*(?:import|export)\s*)\{\s*([\s\S]*?)\s*\}\s*(from\s+["'][^"']+["'])/gm, (match, head, body, tail) => {
      const names = body.split(",").map((x) => x.trim()).filter(Boolean);
      const oneLine = head.trim() + " { " + names.join(", ") + " } " + tail.trim();
      return oneLine.length <= 110 && !body.includes("//") && !body.includes("/*") ? oneLine : match;
    });
    return out;
  }

  window.LyraJSTools = { lintCode: lintCode, formatCode: formatCode };
})();
