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


## 1.2.0

- 代码折叠：折叠 gutter + 折叠全部/展开全部 + 快捷键。
- 查找替换：Ctrl+F，支持大小写、上一个/下一个、替换、全部替换。
- 撤销/重做按钮 + Ctrl+Shift+Z / Ctrl+Y 重做。
- 自动保存：停止输入约 0.9 秒后自动保存，底部显示自动保存时间。
- 运行增强：显示完整文件路径；Console 每次运行自动空行分隔；运行结束有 ✓ / ✕ 标记；运行中可停止。
- 界面风格：JavaScript / 经典蓝 / 深空紫 / 森林绿 / 暖阳橙 / 樱花粉 / 极简白，主题记忆。

## 1.2.1

- 支持编辑器外壳 embedded 模式：文件树由外壳统一提供，插件 UI 内嵌显示。


## 1.2.2

- 编辑器外壳模式同步外壳主题；隐藏插件顶栏重复的项目名/品牌。

## 1.3.0

- JavaScript 自动补全：关键字、全局对象、当前文件函数/类/变量、DOM/Console 等成员、代码片段。
- 自动弹出补全 + Ctrl+Space 手动补全；成员补全支持 console. / document. / Math. 等。
- 补全列表带类型徽标和详细信息，跟随编辑器主题。

## 1.3.1

- 工具栏新增「补全」按钮（等同 Ctrl+Space）。

## 1.3.2

- 补全符号解析增加缓存，避免每次自动补全都重新扫描整个文件。

## 1.3.3

- 自动补全提前到输入 1 个字符就弹出（对齐 VS Code 体验）。

## 1.3.4

- 修复补全弹窗已打开时继续输入，候选仍停留在旧前缀的问题（i → in → ins 现在会实时重新过滤）。

## 1.4.0

- 函数参数提示：调用时显示签名、JSDoc 参数说明，当前参数高亮。
- 悬停提示：鼠标停在符号上显示类型、签名、JSDoc、定义位置。
- 跳转定义：F12 / Ctrl+点击；支持当前文件和 import 的模块。
- 查找引用：Shift+F12，右侧引用面板，点击跳到对应文件行。
- 重命名符号：F2，自定义对话框确认，项目内批量替换。
- 自动导入：Actions 菜单 / Ctrl+. / Ctrl+Alt+I，从项目导出符号中选择并插入 import。
- 代码操作菜单：跳转定义、查找引用、重命名、自动导入集中入口。
- 右侧面板增加「大纲 / 引用」切换。

## 1.4.1

- 修复编辑器在 shell iframe 中悬停坐标偏移，鼠标悬停现在能准确命中当前行符号。
- 悬停范围扩展：函数参数、函数内局部变量、内置全局对象和内置 API（console.log 等）。
- 悬停计时器先清理旧任务，避免快速移动鼠标时显示上一个符号的旧卡片。

## 1.4.2

- 修复 shell iframe 中鼠标坐标与编辑器字符位置偏移：改用 DOM 光标位置（caretRangeFromPoint）定位并校验，悬停现在准确显示鼠标下的符号。
- 悬停覆盖函数参数、局部变量、内置全局对象和 console.log 等内置 API。

## 1.4.3

- 重新实现悬停位置定位：用 lineAtHeight 取行、coordsChar 取列，修复中间字符没有提示/提示错符号。
- 悬停覆盖任何标识符：未找到声明时也给基础提示，不再完全无声。
- addEventListener、map、filter、querySelector 等常见内置成员支持通用悬停签名。

## 1.4.4

- 参数提示不再固定在编辑区底部，改为跟随光标显示，并加「参数」标签，避免和悬停提示混淆。
- 悬停支持对象字面量属性：如 once: true 显示 PROP once: boolean。
- 悬停位置使用 lineAtHeight + coordsChar 的稳定组合，整个标识符每个字符都能命中。

## 1.5.0

- 多变量声明：var raf = null, last = 0, running = false, t = 0 中每个变量分别推断类型。
- 类型推断增强：字符串/数字/布尔/null/数组元素类型/对象/函数/三元/逻辑/比较/算术/`new`/常见调用返回类型。
- 内置属性类型：document.readyState / window.innerWidth / element.scrollTop 等。
- 对象字面量属性、类字段、析构变量、函数 return 推断、最近符号定位。

## 1.5.1

- 修复浅色主题下补全项鼠标悬停时，hover 背景覆盖 active 背景但文字仍是白色，导致白字看不清。
- active 项 hover 现在保持深蓝底 + 白字。

## 1.6.0

- 代码格式化：内置 js-beautify，支持 JS 文档格式化；快捷键 Shift+Alt+F；JSON 走 JSON.parse + 2 空格缩进。
- 代码检查：内置 acorn 解析器；语法错误、未使用变量、未定义变量、重复参数、重复对象键、==/!=、debugger、不可达代码。
- 底部面板新增「问题」标签：显示行号/规则/信息，点击跳到对应代码；编辑器行背景同步标记。
- 自动检查：编辑后 900ms 自动检查；工具栏「检查」按钮 / Ctrl+Shift+M 手动检查。
- 「格式化」「检查」加入工具栏。

## License

GPL-3.0-only. See [LICENSE](LICENSE). Bundled third-party libraries are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## 1.7.0

- Console 分区可上下拖动调高，文件树/大纲可左右拖动，尺寸写入 localStorage。
- Console 改为紧凑单行布局：时间 + 级别 + 内容，减少分隔线和空白；新增自动滚动开关与复制按钮。
- 运行结束改为等待最后输出后 460ms 静默才标记，避免异步输出出现在“运行结束”之后；真正晚到的输出会标注“运行结束后输出”。
- 悬停定位增加越界保护，拖动布局时不会报错。

## 1.8.0

- 检查增强：新增未处理 Promise、循环 `<= .length` 越界、undef/null 属性访问、undefined/null 参数传给会访问属性的函数。
- 运行时错误：Worker/iframe 捕获错误后显示堆栈，并把生成代码行号映射回源文件行号；控制台错误行可点击定位，编辑器对应行红色标记。
- Worker 沙箱：无 DOM 的代码默认在 Worker 执行，可强制终止；带 DOM API 的代码自动改用 iframe sandbox。8 秒超时终止死循环。
- Syntax/未定义变量等继续实时检查；问题面板与行背景同步。

## 1.9.1

- 语法错误时使用 acorn-loose 恢复 AST，继续报告其它静态问题，不再只剩一个语法错误。

## 1.10.0

- 问题列表消息精简；完整信息、规则说明和代码片段放进右侧 Detail 面板。
- 单击问题查看详情，双击或 Detail 中的按钮跳到源码行。
- 修复修复语法错误后静态分析被提前终止的问题（acorn-loose 恢复）。

## 1.11.0

- 集成 ESLint browser bundle，使用 ESLint 规则做标准静态检查。
- 新增 no-const-assign、no-delete-var、no-unsafe-*、no-useless-* 等规则。
- 自定义类型规则补充：BigInt/Number 混用、Symbol 隐式转字符串、不可删除属性、冻结对象写入、箭头函数 new、null 解构、不可迭代展开、Object.assign null、Reflect.get 非对象、负数 String 参数。
- 静态问题列表保留短标题 + Detail 详情。

## 1.12.0

- 自动补全改用 Monaco 自带的 TypeScript language service（vendor/monaco-ts.min.js）。
- DOM/ES2022 类型、成员方法、JSDoc、局部变量补全更完整。
- 保留原有悬浮、参数提示、定义、引用、重命名和自动导入。

## 1.13.0

- 悬浮提示也改用 Monaco TypeScript language service，和 HTML 编辑器一致。
- 悬浮卡显示 `FN queue.push`、完整签名、JSDoc、`Monaco TS · Ln`。
- 补全继续使用 Monaco TS 服务；原有本地规则作为回退。

## 1.14.0

- 参数提示和定义跳转也改用 Monaco TypeScript language service。
- 悬浮、补全、参数、定义统一走 Monaco；引用和重命名保留项目级索引。

## 1.15.0

- 新增「调试」按钮：打开 WebView2 DevTools，调试 `lyra-user-code.js` / `lyra-user-worker.js`。
- 代码行号左侧可点击断点 gutter；运行时注入 `debugger;`，在 DevTools 中命中断点。
- 断点按文件保存；DevTools 支持 Sources 断点、单步、作用域变量和 Console。

## 1.16.0

- 移除浏览器 DevTools 弹窗，改为编辑器内嵌调试面板。
- 调试标签：继续、暂停、单步、进入、跳出。
- 调用栈、当前作用域变量、暂停行高亮、栈帧求值。
- 通过 WebView2 CDP 驱动真实 V8 调试器，不弹外部窗口。

## 1.17.0

- 调试器改为纯编辑器内嵌实现，不再依赖 WebView2 DevTools/CDP，也不会弹浏览器窗口。
- 断点：行号左侧红点，运行时暂停在该行。
- 继续/单步/暂停、暂停行高亮、变量面板、表达式求值。
- 当前支持顶层与块级语句（for/if/try/switch 等）；函数体内部暂未插桩。

## 1.17.1

- 顶部新增「断点」按钮，支持 F9 切换当前行断点。
- 断点栏加宽并加背景，行号最左侧窄栏更明显。

## 1.18.0

- 断点支持函数声明、函数表达式和 class 方法；包含断点的函数在调试运行时转为 async 并插入暂停点。
- 变量面板补充函数参数、局部变量和 this。
- 运行结束/停止时调试状态会正确更新，不再一直显示「运行中」。
- 箭头函数回调（如 Promise.then 内部）暂未插桩。

## 1.19.0

- 调试工具栏新增「逐行运行」：从第一行开始逐行暂停；「单步」可以继续走完全部函数和回调。
- 新增「清空断点」：一次删除所有文件的断点。
- 所有函数声明/表达式/class 方法/块体箭头回调都会插桩并临时转为 async，支持单步进入；表达式体箭头不插桩。
- 调试运行时修改断点会同步到当前 iframe。

## 1.20.0

- 修复暂停行号偏移：不再把第 1 行显示成第 52 行。
- 「逐行运行」从第 1 行开始，而不是第一个可执行的顶层语句。
- 表达式体箭头函数（如 forEach 回调）会改写成块体并插入暂停点。
- 函数/方法/回调整体插桩；单步可进入回调与 class 方法。
- 说明：constructor 不能 async，纯插桩调试无法同步暂停构造函数；完全对齐 VS Code 需要 V8 调试器。

## 1.21.0

- 主程序改用固定版 WebView2 Runtime 144，恢复 V8 CDP 调试。
- JS 编辑器优先使用 V8 CDP：constructor、表达式级单步、作用域按 V8 真实栈帧显示。
- CDP 不可用时自动回退源码插桩调试。
- 调试工具栏保留逐行运行、清空断点。

## 1.21.1

- 调试页新增「输出」面板，运行日志/错误直接显示。
- CDP 断点 URL 改用正则匹配，避免 sourceURL 解析成完整 URL 后断点不命中。
- 「逐行运行」用同样的断点规则。
- 运行结束若断点未命中会显示提示。

## 1.21.2

- 调试输出增加 CDP 诊断：后端、CDP 目标、脚本解析、断点位置。
- 便于定位 iframe 目标/断点 URL 是否匹配。

## 1.21.3

- 主程序 CDP 允许 Target.* 命令，并支持 sessionId，可附加 iframe 调试目标。
- 编辑器自动发现并附加 JS 编辑器 iframe，在会话里注册断点、接收暂停事件。
- 调试输出显示 CDP 目标列表和 iframe 附加结果。

## 1.21.4

- iframe 目标附加改为 WebView2 要求的 flatten:true。
- CDP 事件携带 sessionId，暂停/脚本解析从 iframe 会话正确路由。

## 1.21.5

- iframe 会话开启 Target.setAutoAttach，递归附加 runFrame 子目标。
- 子目标 waitForDebuggerOnStart=true，先装断点再放行脚本。

## 1.21.6

- 调试输出记录所有 scriptParsed URL、autoAttach 返回和子目标事件，用于定位脚本所在目标。

## 1.21.7

- 外壳转发的 editor.cdp-event 走 window message；JS 编辑器补上监听，调试事件终于可达。

## 1.21.8

- 调试运行先注入启动闸门，等 runFrame 子目标附加、断点装好后再放行用户代码，避免 constructor 先执行导致断点来不及命中。

## 1.21.9

- 子目标附加后重试发送闸门放行消息，避免等待消息早于监听器丢失导致一直卡住。

## 1.21.10

- 修正最后一步后状态被 Debugger.resumed 覆盖为「运行中」的问题。
- 增加调试运行 15 秒兜底结束，避免 done 消息丢失后一直运行中。

## 1.21.11

- 每次调试运行重置闸门/暂停/会话/临时断点状态，修复第二次运行断点失效。
- 闸门重试和兜底定时器带 runSeq，旧运行的定时器不会再放行/结束新运行。

## 1.21.12

- 每次调试运行前先清空 runFrame、detach 上一轮 iframe/子目标会话，避免旧目标重复附加和旧断点抢占。

## 1.21.13

- 不再直接附加旧 about:srcdoc 目标，只附加 JS 编辑器 iframe；runFrame 只通过 autoAttach 作为新子目标出现，避免第二次运行命中旧目标。

## 1.21.14

- 复用 JS 编辑器 iframe 调试会话，不再每次运行重新 attach 产生重复会话；只重建 runFrame 子目标。

## 1.21.15

- runFrame 子目标改为每次运行后主动轮询 Target.getTargets 并直接附加，不再依赖 autoAttach 事件；第二次运行也能装断点。

## 1.21.16

- 去重重复的 V8 暂停事件；重复事件自动 resume 对应会话，避免同一脚本被两个会话同时暂停导致后续异步日志丢失。

## 1.21.17

- 关闭 autoAttach，只保留运行时主动附加 runFrame；消除重复暂停会话。

## 1.21.18

- 移除调试运行 15 秒兜底，避免长单步/跳出过程被提前结束导致异步日志缺失。

## 1.21.19

- 复用第一次附加的 runFrame 子会话，后续运行不再 detach/重建，只重新注册断点后更新 srcdoc；修复断点只生效一次。

## 1.21.20

- 每次调试运行替换整个 runFrame iframe 元素，强制创建全新子目标；旧目标/旧会话销毁，避免第二次卡住或断点失效。

## 1.21.21

- 单步进入生成器包装代码（hook/gate/setTimeout 收尾）时自动跳过并 resume，不再显示超出源码行号的第 67/68 行。
