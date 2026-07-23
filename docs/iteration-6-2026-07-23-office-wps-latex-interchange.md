# Iteration 6：Office / WPS 公式 LaTeX 统一交换层

> **Iteration 7 后续说明：** 本文保留 FastAPI `1.7.16` 的公式引擎与宿主适配器
> 原型历史。Office manifest、WPS 注册、共享任务窗格、严格回环宿主和安装器已经在
> FastAPI `1.7.17` 中实现。当前 FastAPI `1.7.18` 的文档助手边界见
> [`iteration-8-2026-07-23-office-wps-document-assistant.md`](iteration-8-2026-07-23-office-wps-document-assistant.md)，
> iteration 7 继续保存公式按钮实机证据。

**状态：** userscript `1.15.3` / FastAPI `1.7.16` 的公式交换核心、Word/WPS
宿主适配器原型、自动化测试与文档已经完成。50 个公式已在 Microsoft Word 16.0
和 WPS Writer 12.0 中验证为原生可编辑公式。可安装任务窗格、Office manifest、
WPS 加载项注册和按钮级实机验收尚未实现，因此本轮不能称为“完整插件已经发布”。

## 目标与固定契约

本轮把浏览器、Word 和 WPS 的外部公式交换格式统一为 LaTeX：

- 复制出去的行内公式统一为 `$...$`；
- 复制出去的独立公式统一为 `$$...$$`；
- 段落、中文/英文正文和公式相对位置必须保留；
- Word/WPS 的 OMML 等原生格式只用于文档内部插入、显示和编辑；
- 不把图片、MathML、OMML 或厂商私有格式放进外部剪贴板契约；
- 不支持或转换失败时明确报错/返回 warning，不静默降级成图片或错误近似。

浏览器历史格式 `[[MATH: ...]]` 继续兼容，并新增
`[[MATH_BLOCK: ...]]` 区分独立公式。`\(...\)`、`\[...\]`、美元分隔符和常见
display environment 会在进入原生转换前统一规范化。

## 实现

### 1. 共享 LaTeX 文档模型

新增 `document_formula.py`：

- 解析混合正文与 LaTeX，保护转义美元符和类似 `$5 and $10` 的货币文本；
- 保留段落并输出唯一规范形式；
- 使用 Pandoc 把规范文本转换成 DOCX/OMML；
- 校验 DOCX 大小、ZIP 展开大小、条目数量和条目路径；
- 支持 Word Flat OPC 与 WPS DOCX 反向转换为 LaTeX；
- 临时公式片段一小时后过期，健康接口不暴露本机 Pandoc 路径。

### 2. 后端接口

新增：

- `GET /document/latex/health`：报告转换器是否可用，以及交换/原生格式；
- `POST /document/latex-fragment`：混合正文与 LaTeX → 规范 LaTeX +
  DOCX base64 + 本机短期 DOCX 路径；
- `POST /document/native-to-latex`：Word Flat OPC 或 WPS DOCX →
  纯文本规范 LaTeX。

缺少 Pandoc 时返回来源中性的 `503`；输入或转换不合法时返回 `422`。公式健康
响应不会回传可执行文件路径。

### 3. Word / WPS 宿主适配器

新增 `addons/`：

- 共享控制器只定义“把选中 LaTeX 转成原生公式”和“把选中原生公式复制为
  LaTeX”两个动作；
- Word 适配器使用 `Range.getOoxml()` 导出 Flat OPC，使用
  `insertFileFromBase64(..., "Replace")` 插入 DOCX 片段；
- WPS 适配器用临时 DOCX 导出选区，再用 `Range.InsertFile` 插入生成片段；
- 共享复制控制器只调用纯文本剪贴板写入，确保不会同时复制图片或私有公式格式。

本轮只交付公式引擎与宿主适配器。任务窗格 UI、Office manifest、HTTPS 静态
宿主、WPS ribbon/注册脚本和安装包留在下一阶段。

### 4. 浏览器复制修正

`tts-userscript.js` 的 `Copy` 现在：

- 保留段落，不再把所有换行压平成一行；
- 行内公式统一为 `$...$`；
- 独立公式统一为 `$$...$$`；
- 能从 MathML `display=block`、MathJax display、KaTeX display 和 display
  script 节点识别独立公式；
- 保留部分公式选区扩展与 MathJax/MathML/KaTeX 语义提取能力。

## 验证证据

### 自动化

- `tests/test_document_formula.py` 与
  `tests/test_document_formula_api.py`：15 项公式解析、API、安全校验和 Pandoc
  回环测试通过；
- `tests/office-addins-core.test.cjs` 与
  `tests/userscript-core.test.cjs`：55 项共享控制器、宿主适配器和 userscript
  核心测试通过；
- `tests/fixtures/latex-formula-corpus.md` 包含 50 个常见公式，Pandoc 生成
  50 个 OMML 公式，反向转换仍识别 50 个公式。
- 完整 Python 回归为 **228 passed, 17 subtests passed**；完整 Node 核心回归为
  **55 passed**；Python 编译、JavaScript 语法、catalog 同步与 `pip check`
  均通过。

### 桌面应用实机

同一份 50 公式 DOCX 探针分别在隐藏 Microsoft Word 与 WPS Writer 自动化会话中
打开：

| 应用 | 原生公式数 | 段落数 |
|---|---:|---:|
| Microsoft Word 16.0 | 50 | 61 |
| WPS Writer 12.0 | 50 | 61 |

此前的小型探针还确认生成包中存在原生分式和积分 OMML，且中文正文保留。

## 当前边界

- 已验证“生成的 DOCX 在两种应用中成为原生公式”，尚未在已安装 task pane 中
  点击真实按钮验证 Office.js/WPS JSAPI 的完整运行链路；
- 对厂商专有或 Pandoc 不认识的复杂公式，必须显示 warning/失败，不能假定
  无损；
- 当前只处理选区，不批量重写整篇文档；
- WPS 使用本机临时路径插入，不能跨机器或交给远程网页直接访问；
- 油猴脚本升级、GitHub Raw 和 Greasy Fork 发布副本仍需分别确认。

## 下一阶段验收门

只有同时完成以下项目，才可以把它描述为“可安装的 Office/WPS 插件”：

1. Word task pane、manifest 与本地 HTTPS 宿主可安装；
2. WPS task pane/ribbon 与注册流程可安装；
3. 两个宿主都能通过真实按钮完成 LaTeX → 原生公式；
4. 两个宿主都能通过真实按钮完成原生公式 → 唯一 LaTeX 剪贴板；
5. 混合段落、撤销、空选区、只含正文、复杂公式和转换失败都有明确行为；
6. 安装、卸载、依赖和故障排查文档与实际包一致。
