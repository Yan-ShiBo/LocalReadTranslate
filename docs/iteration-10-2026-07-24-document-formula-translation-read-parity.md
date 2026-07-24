# Iteration 10：文档译文 LaTeX 与公式朗读一致性

**状态：** userscript 升级为 `1.15.4`，FastAPI 保持 `1.7.19`。Word、WPS
Writer 与 WPS PDF 的任务窗格已经把公式识别接入翻译和朗读入口；译文显示、复制与
可编辑文档替换统一保留规范 LaTeX。英文加公式的朗读改为与网页端同构的渐进队列。

## 1. 本轮修复的问题

此前公式按钮本身可以把选区复制为 LaTeX，但文档助手的 **翻译选区** 和
**朗读选区** 仍直接使用宿主返回的普通文本：

- Word/WPS Writer 原生公式可能在进入 `/translate` 前已经丢失结构；
- WPS PDF 的视觉上下标文本没有经过现有 30B 公式恢复链路；
- 译文虽然由后端保护公式，但任务窗格没有统一规范模型返回的 `\(...\)`、
  `\[...\]` 或 `[[MATH:...]]` 包装；
- 文档任务窗格会先等待整段 `/read/prepare`，没有复用网页端“正文先读、公式后台
  生成读法”的时序。

本轮不新增模型目录，也不改变来源选择规则。仍只使用当前明确选择、由后台真实发现
且可达的模型。

## 2. 翻译前的公式统一

任务窗格现在先执行共享公式预检：

1. 已经包含 LaTeX 的选区只做规范化，行内公式统一为 `$...$`，独立公式统一为
   `$$...$$`。
2. Word/WPS Writer 的公式式选区调用原有 `selectionAsLatex()`：
   Word 导出 Flat OPC，WPS Writer 生成一次性 DOCX，本机 Pandoc 返回正文加规范
   LaTeX；WPS 临时文件仍在 `finally` 中清理。
3. WPS PDF 的公式式选区调用 `/document/pdf-selection-to-latex`，并显式传入
   当前选择的真实模型。测试契约固定使用
   `remote:project-server:qwen3:30b`，不会选择 100B+ 模型。
4. 服务返回 422（选区实际上没有公式）时退回规范化后的原始正文，不把普通文本
   伪装成公式；连接、模型或转换错误则如实显示。
5. `/translate` 继续使用服务端公式占位保护。任务窗格收到译文后再次规范包装，
   显示、复制和 Word/Writer 替换都使用同一份规范 LaTeX 文本。

WPS PDF 仍是只读宿主：可以翻译、复制译文、朗读和识别公式，但不显示选区替换或
公式写回。

## 3. 与网页端一致的公式朗读

新增 `addons/shared/reading-core.js`，把网页端已经验证的纯函数复制为文档加载项可
独立加载的共享核心，并通过等价性测试防止两端漂移。它负责：

- LaTeX 包装规范化和公式/正文分段；
- 网页噪声、链接、代码与不可读文本清理；
- 英文公式段落的渐进朗读计划；
- 小模型的保守公式字面规则；
- 复杂公式读法的清理与安全回退。

英文加公式的实际时序如下：

1. 先生成正文/公式顺序不变的分段计划；
2. 立即在后台请求 `/formula/verbalize`；
3. 正文段落不等待公式请求，直接调用本机 `/tts` 并播放；
4. 播放到公式位置时才读取后台结果；失败时使用与网页端相同的保守本地读法或
   `formula omitted`；
5. 每段 WAV 按原文顺序播放并及时撤销 blob URL；
6. 点击 **停止朗读** 会增加播放 generation，迟到的公式或 TTS 响应不能恢复播放。

选择不超过 4.5B 的模型且所有公式都能由本地规则处理时，不发送不必要的公式大模型
请求。中文或中英/公式混合内容继续走 `/read/prepare`，保持网页端现有边界。

## 4. 网页端译文复制

网页翻译卡仍可以把公式渲染成易读形式，但 `1.15.4` 的 **Copy** 不再复制渲染节点
的 `textContent`。它改为直接对服务返回的 `translated_text` 执行
`normalizeCopyTextWithLatex()`，因此剪贴板保留 `$...$` / `$$...$$` 结构。

## 5. 主要文件

| 文件 | 变更 |
|---|---|
| `addons/shared/reading-core.js` | 文档端 LaTeX 规范化、渐进朗读与公式读法核心 |
| `addons/shared/formula-controller.js` | 抽出不写剪贴板的 `selectionAsLatex()`，供翻译和朗读复用 |
| `addons/shared/localreadtranslate-client.js` | 增加 `/formula/verbalize` 客户端 |
| `addons/taskpane/taskpane.js` | 公式预检、译文 LaTeX、渐进播放、停止 generation |
| `addons/taskpane/taskpane.html` / `addon_host.py` | 加载并白名单提供共享朗读核心 |
| `tts-userscript.js` | 版本 `1.15.4`；译文 Copy 保留规范 LaTeX |

## 6. 验证边界

自动化覆盖以下关键契约：

- 文档共享核心与 userscript 对同一组输入产生相同的 LaTeX、朗读计划和清理结果；
- WPS PDF 原始文本先由明确选择的 `qwen3:30b` 恢复为 LaTeX，再发送翻译；
- `\(...\)` 译文在任务窗格、复制结果中统一为 `$...$`；
- `/formula/verbalize` 在第一段正文 TTS 之前启动，但公式 TTS 保持在原文位置；
- 30B 路径不会误用 100B+ 模型；
- 新静态资源位于显式白名单中，并在任务窗格主脚本之前加载。

最终自动化结果：

- 文档加载项与 userscript Node：`77/77 passed`（文档加载项 27，网页脚本 50）；
- Python：`264 passed`，另有 `17 subtests passed`；
- Python/JavaScript 语法、catalog 同步、bundled FFmpeg、`pip check` 与
  `git diff --check`：全部通过；
- 唯一 warning 是已有 FastAPI TestClient 的 Starlette `httpx2` 迁移提示，不影响
  本轮功能或发布。

本轮也在 WPS Office `12.1.0.26895` 的真实 PDF 组件中重启加载项宿主并完成界面级
复验：

1. 任务窗格显示 `Project Server` 已连接，当前模型为 `qwen3:30b`，本地 Ollama
   保持关闭；
2. 在第 4 页选择英文正文及其显示公式后点击 **翻译选区**，结果卡返回中文，同时
   把 `p(x,c)`、`uSAC(x)`、`\min c` 和不等式保留在 `$...$` LaTeX 包装中；
3. 对同一选区点击 **朗读选区**，按钮切换为 **停止朗读**，正文和公式按原文顺序
   播放，结束后按钮自动恢复；
4. 测试与实机请求均只使用
   `remote:project-server:qwen3:30b`，未选择任何 100B/122B 模型；
5. 验证结束后已精确卸载 `qwen3:30b`；最终健康快照确认该模型
   `running: false`、`pinned: false`，Project Server 仍可达，本地 Ollama 仍关闭。

因此本轮不仅验证了端点和纯函数，也验证了 WPS PDF WebView 中实际加载的新脚本、
公式译文显示和渐进朗读状态机。PDF 仍保持只读，没有执行公式写回。

## 7. 发布与刷新

- 浏览器脚本发布时，Tampermonkey 与 Greasy Fork 都需要更新到 `1.15.4`；
  修改 GitHub 仓库不会自动覆盖两处已安装副本。
- `addon_host.py` 增加了新的静态白名单项，正在运行的旧宿主必须重启。
- WPS/Word 已打开的旧任务窗格可能缓存脚本；重启宿主后关闭并重新打开任务窗格，
  必要时完整退出并重开 Office/WPS。
- FastAPI API 契约没有变化，因此服务版本保持 `1.7.19`。
