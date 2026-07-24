# Iteration 7：可安装的 Microsoft Word / WPS Writer 公式加载项

> **Iteration 9 后续说明：** 本文保留 FastAPI `1.7.17` 的可安装公式加载项、
> Word/WPS 公式按钮实机证据与兼容修复。当前 FastAPI `1.7.19` 已在同一任务窗格中
> 加入与网页端同构的来源优先翻译和本地朗读，并为 WPS PDF 增加模型辅助公式
> LaTeX 复制；现行边界见
> [`iteration-9-2026-07-23-wps-pdf-addin.md`](iteration-9-2026-07-23-wps-pdf-addin.md)。

**状态：** userscript `1.15.3` 不变；FastAPI 升级为 `1.7.17`。共享任务窗格、
Office XML manifest、WPS ribbon/package、回环宿主、安装/卸载脚本，以及 Word 与
WPS 的按钮级双向实机验收已经完成。

Iteration 6 的公式交换契约保持不变：对外复制只使用 LaTeX；Word/WPS 内部继续
使用可编辑原生公式。Iteration 7 把该核心装进真实加载项壳层，并修复 Word 选区
Flat OPC 在反向转换中的兼容问题，以及 WPS WebView 二进制导出损坏和临时文档
重复选区问题。

## 1. 用户工作流

加载项只提供两个主操作，避免把翻译来源、Ollama 状态和文档公式混在一起：

1. **转为文档公式**
   - 在 Word/WPS 中选择含正文与 `$...$` / `$$...$$` 的 LaTeX 段落；
   - 点击一次后，选区替换为宿主内部可编辑的原生公式；
   - 正文与段落结构保留。
2. **复制为 LaTeX**
   - 选择含 Word/WPS 原生公式的正文；
   - 点击后，剪贴板只包含规范纯文本；
   - 行内公式为 `$...$`，独立公式为 `$$...$$`。

任务窗格在初始化时检查一次 Pandoc；正常按钮操作复用该状态，不会在每次点击前
重新显示 “Checking translation sources”。只有服务离线或用户主动点击“重试”时
才重新检查。

## 2. 交付内容

### 2.1 共享任务窗格

- `addons/taskpane/taskpane.html`
- `addons/taskpane/taskpane.css`
- `addons/taskpane/taskpane.js`

同一 UI 根据 `?host=office` / `?host=wps` 选择宿主适配器。界面采用紧凑的
两动作结构，显示宿主、一次性公式服务状态、选区 LaTeX 结构预览和本次操作结果。

### 2.2 Microsoft Word

- `addons/office-word/manifest.xml`
- `addons/office-word/office-adapter.js`

manifest ID 为 `74d95f3f-f8d0-4a33-95d8-2f0b637df535`，权限为
`ReadWriteDocument`。Word 通过 Office.js：

- `Range.getOoxml()` 导出当前选区；
- `Range.insertFileFromBase64(..., "Replace")` 插入原生 DOCX/OMML 片段。

安装器只写当前用户的开发加载项注册，不要求管理员权限。

### 2.3 WPS Writer

- `addons/wps-word/ribbon.xml`
- `addons/wps-word/main.js`
- `addons/wps-word/js/ribbon.js`
- `addons/wps-word/wps-adapter.js`
- `addons/wps-word/manifest.xml`

WPS ribbon 创建或切换一个共享任务窗格。反向导出时，适配器先对原选区执行
`Range.Copy()`，再在临时文档的 `Range(0, 0)` 执行 `Paste()`，保存为当前用户
临时目录下随机命名的一次性 DOCX。任务窗格只把 `docx-local-path` 交给回环 API；
控制器在成功、API 失败或剪贴板失败时都执行清理。插入时使用 `Range.InsertFile`。

本地 API 不接受任意 WPS 文件路径：文件必须直接位于当前用户临时目录，名称必须
匹配 `localreadtranslate-selection-<时间>-<随机值>.docx`，并继续通过 8 MiB 文件
上限、ZIP 条目/展开大小和 DOCX 必需结构校验。

`addin_registration.py` 对
`%APPDATA%\kingsoft\wps\jsaddons\publish.xml` 做解析、去重、合并和精确删除：

- 保留所有无关加载项和属性；
- 重复安装保持一个 LocalReadTranslate 项；
- 修改前由 PowerShell 安装器创建时间戳备份；
- XML 损坏时失败关闭，不覆盖原文件。

### 2.4 回环加载项宿主

`addon_host.py` 默认监听 `127.0.0.1:5443`，职责只有：

- 返回显式允许的加载项静态资源；
- 把 `/api/*` 同源代理到 `127.0.0.1:5000`；
- 返回 `/health`；
- 设置 CSP、`X-Content-Type-Options: nosniff`、`Referrer-Policy:
  no-referrer` 和 `Cache-Control: no-store`。

宿主拒绝非回环绑定，静态资源不存在目录遍历或任意文件回退，API 上游也只接受
带有效端口的 HTTP 回环 URL。它不读取 SSH 凭据、不解析远程 Ollama 配置，也不
把 FastAPI 暴露到局域网。

默认安装使用严格回环 HTTP。原因是本次 Word/WPS 桌面宿主已经实机通过，同时
安装器不应静默修改 Windows 根证书信任。`addon_host.py` 仍支持调用者显式提供
`--cert` / `--key` 的 TLS 模式；项目安装器不会创建、自签或信任证书。

### 2.5 安装与卸载

- `install-document-addins.bat`
- `uninstall-document-addins.bat`
- `scripts/install_document_addins.ps1`
- `scripts/uninstall_document_addins.ps1`

安装器可重复执行，支持 `-OfficeOnly`、`-WpsOnly` 和 `-NoStart`。如果托盘程序
还没有管理回环加载项宿主，安装器启动一个隐藏的独立宿主并记录其 PID。

卸载器只删除精确 Office manifest 注册、精确 WPS 配置项和安装器拥有的独立宿主。
它不清空 Office/WPS 全部配置，不停止 LocalReadTranslate FastAPI，不关闭托盘，
不停止远程隧道，也不启动或停止 Ollama。

## 3. Word Flat OPC 修复

Word `Range.getOoxml()` 返回的是选区包，并不保证包含完整 DOCX 的
`[Content_Types].xml`、根关系、样式、设置和主题。直接把这些零散部件打成 ZIP
会让 Pandoc 返回 `DocxError`。

当前处理流程：

1. 限制 Flat OPC 输入大小、部件数、解压后大小和安全路径；
2. 只提取选区的 `word/document.xml`，不信任选区外关系；
3. 从当前 Pandoc 可执行文件读取完整 `reference.docx`，进程内缓存；
4. 用选区 `document.xml` 替换参考包中的正文；
5. 在 XML 序列化前注册标准 `w:`、`m:`、`r:` 等 Word 命名空间；
6. 再交给 Pandoc 转成规范 LaTeX。

标准命名空间是本次关键兼容修复。通用 `ns0:` / `ns1:` 前缀虽然在 XML 语义上
等价，但当前 Pandoc DOCX reader 会拒绝该选区包；恢复 `w:` / `m:` 后自动测试和
Word 实机复制都通过。

## 4. 实机验收

### 4.1 Microsoft Word 16.0

安装后，在 **开始 → 加载项** 中成功打开
`LocalReadTranslate 公式工作台`。在未保存的空白测试文档中：

```text
测试公式 $x^2 + y^2 = z^2$ 和 $\frac{a}{b}$。
```

点击 **转为文档公式**：

- 显示“已转换 2 个公式”；
- 两个公式成为 Word 原生可编辑对象；
- Word 显示公式上下文选项卡；
- 正文和句号保留。

重新选择该段并点击 **复制为 LaTeX**：

- 显示“已复制 2 个公式”；
- 实际 Windows 剪贴板内容为：

```text
测试公式 $x^{2} + y^{2} = z^{2}$ 和 $\frac{a}{b}$。
```

测试文档未保存，用户的真实文档未修改。

### 4.2 WPS Writer 12.1.0.26895

安装后重启 WPS，在新的未保存测试文档中输入：

```text
WPS 测试：$x^2 + y^2 = z^2$，以及 $\frac{a}{b}$。
```

点击 **转为文档公式**：

- 显示“已转换 2 个公式”；
- 两个公式成为 WPS 原生可编辑对象；
- 正文与中文标点保留。

重新选择该段并点击 **复制为 LaTeX**：

- 显示“已复制 2 个公式”；
- Windows 剪贴板长度为 48 个字符；
- 实际内容只有一份：

```text
WPS 测试：$x^{2} + y^{2} = z^{2}$，以及 $\frac{a}{b}$。
```

实机验收同时确认 `publish.xml`、ribbon、PluginStorage、任务窗格资源和
`Range.InsertFile` 正常；50 公式探针在 WPS 中仍为 50 个原生公式、61 个段落。
测试文档保持未保存并留在 WPS 中，未触碰用户其他文档。

本次实机测试发现并修复两个独立的 WPS 兼容问题：

1. WPS `FileSystem.readAsBinaryString` 的返回值不能按浏览器 Latin-1 字符串直接
   `btoa`，UTF-8 重编码也会破坏 ZIP，因此改为受限的一次性本地路径桥接；
2. `temporaryDocument.Content.FormattedText = source.FormattedText` 会把同一选区
   写入两次，产生 4 个公式；WPS 原生 `Range.Copy/Paste` 只生成一个正文段和
   2 个公式。

路径白名单、DOCX 校验和 `finally` 清理共同保证该桥接不会扩展为任意本地文件读取。

## 5. 运行状态边界

本轮重启仅针对本地 FastAPI `server.py`，用于加载公式解析修复。托盘/远程隧道
监听进程保持不变；本地 Ollama `11434` 没有监听，也没有因公式功能被启动。

文档公式转换只依赖本地 Pandoc。无论选择本地还是远程翻译模型，都不会改变插件的
公式转换结果。

## 6. 自动化验证

新增或扩展：

- `tests/test_addin_host.py`
  - 回环绑定、静态允许列表、安全响应头、API 代理和请求限制；
- `tests/test_addin_registration.py`
  - 空配置、已有配置、重复安装、精确卸载、损坏 XML；
- `tests/test_addin_packaging.py`
  - Office/WPS manifest、ribbon、安装器与 URL 一致性；
- `tests/office-addins-core.test.cjs`
  - 两宿主适配器、控制器、剪贴板、任务窗格一次健康检查、WPS ribbon，以及
    `Copy/Paste` 不重复选区与一次性文件清理；
- `tests/test_document_formula.py`
  - Word 选区 Flat OPC 元数据重建、标准命名空间、Pandoc 回环，以及 WPS
    本地路径直属目录/随机文件名/DOCX 校验；
- `tests/test_document_formula_api.py`
  - API 接受 `docx-local-path`，并继续拒绝未知来源格式；
- `tests/test_tray_app.py`
  - 托盘拥有/启动/停止加载项宿主，且远程隧道生命周期不被混用。

发布前必须继续通过完整 Python 套件、两个 Node 套件、Python/JavaScript 语法检查、
XML 解析、PowerShell 解析、catalog 同步、release metadata 和 `git diff --check`。

本轮在项目实际 `kokoro-tts` Conda 环境中的最终结果：

- Python：`250 passed`，另有 `17 subtests passed`；
- userscript Node：`49 passed`；
- Office/WPS Node：`12 passed`；
- Python/JavaScript 语法、Office/WPS XML、PowerShell AST、catalog、项目环境
  `pip check` 与 `git diff --check`：全部通过；
- 唯一 warning 是现有 FastAPI TestClient 的 Starlette `httpx2` 迁移提示，不影响
  本次功能或发布。

## 7. 使用

```powershell
# 安装 Word + WPS
.\install-document-addins.bat

# 仅安装一个宿主
powershell -ExecutionPolicy Bypass -File scripts\install_document_addins.ps1 -OfficeOnly
powershell -ExecutionPolicy Bypass -File scripts\install_document_addins.ps1 -WpsOnly

# 卸载本项目的两个注册
.\uninstall-document-addins.bat
```

安装或修改注册后，先保存文档，再完整关闭并重开相应应用。

## 8. 厂商依据

- Microsoft XML manifest、Office.js Word Range 和本地旁加载按官方 Office
  Add-ins 文档实现；
- WPS 使用官方 publish 模式、`CreateTaskPane`、`PluginStorage`、
  `Range.Copy/Paste`、`Document.SaveAs2` 与 `Range.InsertFile`。实机证明
  `readAsBinaryString` 不适合作为 WPS DOCX 的 WebView Base64 桥接，因此不再
  位于生产链路。

Office 官方建议生产/网络传输使用 HTTPS；当前 HTTP 仅用于严格的本机开发旁加载。
如果未来发布到 Marketplace、Office 网页版或远程地址，必须换成受信任 HTTPS
部署，而不能复用当前开发注册。
