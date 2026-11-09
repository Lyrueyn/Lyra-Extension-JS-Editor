# JavaScript 编辑器（编辑器扩展插件）

JavaScript 编辑器是「编辑器」扩展的 editor-plugin 插件。

安装条件：

- 主程序 2.1.2+
- 编辑器扩展 1.1.1+
- HTML 阅读器扩展（编辑器扩展的前置）

功能：

- 项目文件树（js/json/html/css/md/txt 等文本文件）
- CodeMirror 语法高亮、行号、括号匹配、自动补全括号
- 保存（Ctrl+S）
- 运行当前文件（Ctrl+Enter）
- Console 输出
- Preview 运行结果
- 深色黄色主题，与 HTML 编辑器插件 UI 区分

插件说明：

- 这个插件不提供独立 Tab；它由「编辑器」扩展的项目库选择打开。
- 编辑器扩展会根据项目内容选择 HTML 编辑器或 JavaScript 编辑器；也可以在项目卡片上右键手动选择。


## 1.1.0

- JS 专属 UI 重新设计：
  - 文件 / 代码 / Outline 三栏
  - Console + REPL 输入行
  - 运行文件 / 运行选中
  - 移除通用 Preview，改成 JS 运行控制台
- 文件类型路由：
  - .js/.json 在 JS 编辑器内打开
  - .html 自动交给 HTML 编辑器插件
  - .css 提示等待 CSS 编辑器插件
- 编辑器扩展对带 package.json 的项目优先选择 JavaScript 编辑器。
