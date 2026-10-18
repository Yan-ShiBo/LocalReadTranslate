# Iteration 19：原始 TeX 保留与剪贴板字体参数

**版本：** userscript `1.15.12`；FastAPI 保持 `1.7.21`。
本次区分“读取原始 TeX”与“从渲染字形恢复公式”，修复 TeX 命令前缀被错误
替换的问题，并仅对单公式剪贴板中的明确字体参数补充花括号。`1.15.11` 的
复制事件隔离、成功反馈与 `1.15.10` 的包装边界修复继续保留。

## 1. 精确输入与已证实的根因

用户提供的完整 KaTeX DOM 保存于
[`tests/fixtures/reported-deepseek-lie-derivative.html`](../tests/fixtures/reported-deepseek-lie-derivative.html)。
其中 MathML annotation 已经包含原始 TeX：

```latex
\mathcal L_{F_p}B
=\nabla B(x,\mathbf b)^\top f(x,p(x)).
```

旧 `normalizeMathFormulaText` 对原始 TeX 也运行了用于渲染文本的替换。
其中箭头正则未限制完整命令边界，并把多个不同语义的箭头统一成 `\to`：

| 输入 | 旧错误结果 | 正确处理 |
|---|---|---|
| `\top` | `\to p` | 原始命令保留，不能把转置符号拆成箭头与字母 |
| `\mapsto` | `\to` | 保留映射箭头命令 |
| `\rightarrowtail` | `\to tail` | 保留完整命令，不能替换其前缀 |
| 原始 TeX / 纯字形中的 `⇒`、`↦` | 都合并为 `\to` | 原始来源保留，不把不同箭头合并 |

这处前缀误替换可以从输入、代码与输出直接复现。它与上一轮宿主页面复制
事件改写是不同阶段的问题，不能把所有异常都归因于剪贴板事件。

用户随后把实际复制内容粘贴到记事本，提供的原文为：

```latex
\mathcal L_{F_p}B=\nabla B(x,\mathbf b)^ \to p f(x,p(x)).
```

这份现场文本确认了用户实际剪贴板中的 `\top` 已损坏成 `\to p`，不只是
隔离环境里模拟的可能性。它证明源码命令在到达 WPS 之前就已被改写，但不
等于已经在 WPS GUI 中确认字体渲染问题的根因。

## 2. 原始 TeX 与字形恢复分流

MathML 的 TeX annotation、`script[type^="math/tex"]` 和明确来源属性中的
内容走源码保留路径：只规范 CRLF/CR 换行为 LF，并去掉整段首尾空白；不再
用渲染字形的空白/标点整理或箭头替换改写 TeX 命令、内部空格与换行。

没有原始 TeX 时，MathML/MathJax 等字形恢复路径仍可构造 LaTeX，但移除旧的
错误箭头合并。MathML 操作符按自身语义映射，例如 `→` 为 `\to`、`⇒` 为
`\Rightarrow`、`↦` 为 `\mapsto`，不把不同符号都压成一个箭头。

这不改变规范数学包装契约：内部翻译、朗读和文档写回继续保留 `$...$` /
`$$...$$`。已有单原子 `\bar` 简写规范化仍保留；不能把“源码保留”理解为
取消所有既有的包装和兼容规则。

## 3. 字体参数只在单公式剪贴板处分组

原始 `\mathcal L`、`\mathbf b` 都是带单参数的 TeX 简写。为了向公式编辑框
传递更明确的参数边界，单公式最终复制时将其改为：

```latex
\mathcal{L}_{F_p}B
=\nabla B(x,\mathbf{b})^\top f(x,p(x)).
```

这只给已有字体命令的明确单原子参数加花括号，不增加字体样式，不把普通字母
改成粗体，也不吞掉后续上下标。已有分组、文字命令和逐字内容保持各自边界；
不猜测未知宏的参数数量。

网页与文档共享核心采用同一最终剪贴板规则。只有整个待复制内容是单个公式
时应用字体参数分组；规范结果、正文或多个公式继续保留源码字体写法，既有
`\bar` 规范化例外不变。

证据边界：字体分组是数学语义不变的兼容处理；**本轮没有通过 WPS GUI 实贴
证实某种字体显示问题的根因**，不能把新增花括号描述成已经实机证明的 WPS
字体修复。

## 4. 升级方式

1. 将 Tampermonkey 中实际安装的脚本更新为 **`1.15.12`**，核对版本并刷新
   来源网页。
2. 选择目标公式，使用本插件的 **Copy**，等到 **Copied** 后再粘贴到 WPS
   自带公式框并转换为专业格式；若该版本提供输入格式选择，选 LaTeX。
   不同版本不保证自动互认，也不要求寻找界面中不存在的 LaTeX/UnicodeMath 切换。
3. 检查 `^\top` 仍是完整的转置命令，而不是 `^\to p`；字体命令可显示为
   `\mathcal{L}`、`\mathbf{b}`，但原有数学内容和字体选择不变。
4. 文档插件使用更新后的共享核心时，关闭并重新打开任务窗格。后台仍为
   `1.7.21`，无需为本次复制修复重启同版本后台、启动模型或连接服务器。

仓库、GitHub Raw、Tampermonkey 已安装副本和 Greasy Fork 仍需分别核对版本。
网页自身复制按钮与普通 `Ctrl+C` 不会被本插件全局接管；正文或多个公式仍应
粘贴到正文，再使用文档插件的原生公式转换。

## 5. 验证范围与限制

本轮完整验证结果：

- JavaScript：`280/280` 通过，其中选区/DOM 测试 `99` 项；
- Python：`306` 项测试与 `30` 项子测试通过，保留一条已有的
  Starlette/httpx 弃用警告；
- 两个 JavaScript 核心的 `node --check`、`sync_catalog.py --check` 与
  `git diff --check` 通过。

本轮回归覆盖用户完整 DOM、原始 annotation/script/来源属性、完整与局部
选区、`\top` 及箭头命令前缀、MathML 箭头语义，以及字体参数只作用于单公式
剪贴板的边界。既有复制隔离、包装、矩阵和 `\bar` 回归继续保留。

新增完整 fixture 的 **DOM → 剪贴板 → Pandoc OMML** 测试，与直接由原始
annotation 生成的 OMML 完全一致。结构断言包含 script 字体的 `L`、bold
字体的 `b`、`F_p` 嵌套下标，以及上标 U+22A4（`⊤`）。这证明转换后的原生
公式结构保留了这些元素，不是 WPS GUI 字体渲染验收。

真实独立 Chrome 也使用当前 Lie-derivative 完整 fixture，执行可信点击插件
**Copy** 并读回系统剪贴板。原生 Clipboard API 路径与强制原生拒绝后的
iframe 回退均保留公式；普通 `Ctrl+C` 仍走宿主页 handler，二次插件 Copy
正常，关闭工具条会清理 iframe。Windows 原生读回使用 CRLF、回退使用 LF，
断言按换行等价比较；这个平台差异不被当成公式命令变化，也不因此改写源码。

上述统计与浏览器证据属于本次验证，不挪用 `1.15.11` 的历史结果。验证没有
启动本地后台或模型。源码、DOM、系统剪贴板与 Pandoc OMML 检查均不等于
WPS GUI 的专业模式转换与字体渲染验收；本记录不宣称已经完成用户 WPS 中
的实际粘贴，也不承诺所有 Word/WPS 版本支持全部 LaTeX 命令。

相关记录：

- [Iteration 18：复制事件隔离与成功反馈](iteration-18-2026-10-18-clipboard-event-isolation.md)
- [Iteration 17：包装与方括号边界](iteration-17-2026-10-18-formula-wrapper-boundaries.md)
- [中文使用说明](../说明.md)
- [文档插件与两种粘贴路径](../addons/README.md)
