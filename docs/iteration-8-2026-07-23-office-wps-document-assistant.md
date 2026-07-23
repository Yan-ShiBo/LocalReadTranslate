# Iteration 8：Word / WPS 选区翻译、朗读与公式文档助手

**状态：** userscript 继续为 `1.15.3`；FastAPI 升级为 `1.7.18`；Office
manifest 升级为 `1.1.0.0`。Word/WPS 共用任务窗格已经加入选区翻译、本地朗读、
译文复制/替换和来源感知模型管理，同时完整保留 iteration 7 的双向公式/LaTeX
能力。

本轮没有修改网页端来源/模型协议。加载项复用同一份后台事实：

- 默认来源是本地；
- 本地 Ollama 与项目服务器是明确分开的来源；
- 只有当前选中、可达来源实际发现的文本生成模型可以进入下拉框；
- `remote:<source-id>:<model>` 始终保留完整显式引用；
- 切换来源或模型不会静默改用另一个来源；
- 远程连接凭据和生命周期仍只属于托盘程序。

## 1. 用户可见布局

任务窗格改为与网页端脚本相同的信息层级和深色设置面板：

1. **翻译**是唯一默认展开的主区。
   - 先显示纵向“本地 Ollama / 项目服务器”来源行；
   - 当前来源行显示运行、已连接、未启动或未连接状态；
   - 离线来源只显示一个真实恢复动作；
   - 模型下拉框占整行，只显示当前来源的后台发现模型；
   - 主动作只有“翻译选区”；
   - 结果可复制，或直接替换当前 Word/WPS 选区。
2. **高级**折叠保存目标语言和模型生命周期动作。
   - 未固定的模型显示“加载并保持/保持加载”；
   - 只有运行或固定的模型才显示“卸载”；
   - 当前状态不适用的动作不占界面空间。
3. **朗读**折叠保存文档服务状态、声音、语速和“朗读选区”。
4. **公式与 LaTeX**折叠保存公式结构预览、转为文档公式、复制选区为
   LaTeX。

隔离浏览器用 390 px 和 280 px 两种任务窗格宽度检查。两者均没有横向溢出；
280 px 时结果与公式双按钮自动改为单列。

## 2. 来源、模型与设置状态

任务窗格使用 `/translate/health` 的 `sources[]` 和
`available_model_options` 作为唯一模型目录。它不会添加默认模型名、自定义静态
列表、embedding/reranking 模型或另一个来源的模型。

浏览器存储键
`localreadtranslate-document-assistant-settings-v1` 保存：

- `translationSource`；
- 每个来源各自的 `translationModels`；
- `targetLanguage`；
- `voice`；
- `speed`。

恢复时会重新验证来源 ID 与模型所属来源；模型还必须继续存在于这次后台发现结果
中，才能成为实际选中项。回归测试专门把 `qwen3:122b` 放在服务器列表第一位、
把上次选择保存为 `remote:project-server:qwen3:30b`，确认任务窗格恢复的是
30B，而不是误选更大的第一项。

初始化或主动点击“重试”时，任务窗格只执行一次并行发现：

- `GET /document/latex/health`；
- `GET /translate/health`；
- `GET /voices`。

普通翻译、朗读、公式转换、来源切换和模型切换直接使用缓存状态，不会在每次按钮
前重新显示 “Checking translation sources...” 或重复访问健康接口。只有以下明确
动作会刷新：

- 用户点击离线来源的“启动/连接”后，每秒串行轮询一次来源，最长 120 秒；
- 用户明确执行模型常驻或卸载后，刷新一次模型运行状态；
- 用户点击“重试”后，重新执行完整并行发现。

## 3. 翻译链路

Word 通过 Office.js `Range.text` 读取选区，WPS 通过
`Application.Selection.Range.Text` 读取选区。翻译请求为：

```json
{
  "text": "<当前选区>",
  "model": "<当前精确模型引用>",
  "target_language": "<目标语言>"
}
```

任务窗格不会在请求前重新发现来源。返回的 `translated_text` 进入只读结果卡片；
“复制译文”只写纯文本剪贴板，“替换选区”分别使用：

- Word `insertText(text, "Replace")`；
- WPS `Selection.Range.Text = text`。

翻译错误继续使用来源中性的公开文案，不把远程服务器失败误称为本地 Ollama
失败。

## 4. 朗读链路

朗读使用 `/voices` 返回的声音、默认值和语速范围，不在任务窗格维护第二份声音
目录。

- 纯英文且不含公式时，可以直接清理空白并调用 `/tts`；
- 中文、CJK 或含 LaTeX 公式时，必须存在当前选中的真实文本生成模型，先调用
  `/read/prepare`；
- 没有模型时会显示明确提示，不会静默切换来源或使用隐藏回退模型；
- `/tts` 通过加载项代理返回 `audio/wav`；
- 任务窗格使用临时 blob URL 播放，再次点击可停止，结束或替换音频时会撤销旧
  URL。

加载项宿主的 CSP 增加 `media-src 'self' blob:`，代理只透传受限的
`audio/wav`、`audio/ogg` 或 `application/json` Accept 类型。查询字符串也会原样
传给本地 FastAPI，因此 `/tts?format=...` 等受支持接口不会被截断。

## 5. 公式链路保持不变

Iteration 7 的安全边界继续成立：

- LaTeX 是唯一外部公式交换格式；
- Word 选区反向导出使用 Flat OPC；
- WPS 使用原生 `Range.Copy/Paste` 建立随机一次性 DOCX；
- `docx-local-path` 只允许当前用户临时目录直属、匹配专用名称的文件；
- 服务校验大小、ZIP 条目、展开大小和 DOCX 结构；
- 控制器在成功、API 失败和剪贴板失败后都执行清理；
- 正向插入仍产生 Word/WPS 内部可编辑的 OMML 公式。

公式按钮不调用 Ollama，不启动本地 Ollama，也不改变远程隧道。

## 6. 加载项宿主与超时

`addon_host.py` 继续只绑定 `127.0.0.1:5443`，只提供静态白名单和
`/api/*` 代理，不启用 CORS，也不暴露仓库或远程配置。

冷启动一个用户明确选择的 Ollama 模型可能超过一分钟。原 75 秒代理超时会先于
合理的模型初始化结束，表现为加载项收到 502。当前上限改为 150 秒，与网页端长
翻译操作的等待量级一致，同时仍保持有界。自动化测试要求该值不低于 120 秒。

## 7. 精确 30B 真实链路验证

运行时边界：

- FastAPI：`127.0.0.1:5000`，PID 24156；
- 加载项宿主重启后：`127.0.0.1:5443`，PID 7312；
- 项目服务器/托盘隧道：`127.0.0.1:8685`，PID 1000，全程未停止；
- 本地 Ollama：`127.0.0.1:11434` 无监听，全程未启动。

测试前 `/api/translate/health` 确认：

- `project-server.reachable = true`；
- 服务器报告 6 个模型；
- 精确引用 `remote:project-server:qwen3:30b` 存在。

本轮所有真实大模型请求都只使用
`remote:project-server:qwen3:30b`，没有调用任何 100B+ 模型。

### 7.1 翻译

通过插件实际路径 `http://127.0.0.1:5443/api/translate` 发送：

```text
The Pythagorean theorem states that $x^2 + y^2 = z^2$.
```

目标为 `Simplified Chinese`。18 秒内返回：

```text
勾股定理表述为 $x^2 + y^2 = z^2$
```

响应模型仍是 `remote:project-server:qwen3:30b`，服务端计时
`17.285` 秒，公式保持原样。

### 7.2 朗读稿与 WAV

同一精确 30B 模型处理中文公式选区后：

- `/read/prepare` 响应模型仍为该 30B 引用；
- 朗读稿为英文且包含公式口语信息；
- `/tts` 返回 HTTP 200；
- Content-Type 为 `audio/wav`；
- 响应为 307,244 字节；
- 前四字节为 `RIFF`。

### 7.3 清理

测试结束后通过
`POST /api/translate/model/unload` 精确卸载该 30B 模型：

- `status = unloaded`；
- `model_running = false`；
- `model_pinned = false`；
- Project Server 仍 `reachable = true`；
- `8685` 监听仍属于 PID 1000；
- 本地 `11434` 仍无监听。

## 8. 自动化覆盖

共享 Node 回归集现有 20 个子测试，覆盖：

- 翻译/朗读/声音/音频/模型生命周期 API 客户端；
- Word/WPS 选区读取与文本替换；
- 只显示当前可达来源的真实模型；
- CJK/公式朗读准备判断；
- 初始化一次发现、普通动作不重复检查；
- 保存的 30B 模型优先于列表第一项的 122B；
- 显式来源连接后才自动轮询刷新；
- 翻译结果复制与文档替换；
- 公式控制器、剪贴板回退和 WPS ribbon。

Python 加载项宿主测试覆盖静态白名单、路径穿越拒绝、JSON 大小限制、查询参数、
音频 Accept/响应类型、CSP `media-src` 和冷启动超时下限。发布元数据测试要求：

- FastAPI `1.7.18`；
- Office manifest `1.1.0.0`；
- Word 显示名 `LocalReadTranslate 文档工作台`；
- WPS 按钮 `阅读与公式`。

完整本地回归结果：

- Python：`252 passed`，另有 `17 subtests passed`；
- Word/WPS 加载项 Node：`20 passed`；
- 网页 userscript Node：`49 passed`。

Python 仅报告现有 Starlette/httpx 迁移弃用警告，没有测试失败。

## 9. CI 更新

GitHub Actions 工作流从 Node 20 运行时的旧 Action 主版本升级为：

- `actions/checkout@v7`；
- `actions/setup-python@v7`；
- `actions/setup-node@v7`；
- 测试 Node `24`；
- `permissions: contents: read`；
- `package-manager-cache: false`。

同时补齐 `addon_host.py`、`addin_registration.py` 和
`scripts/sync_catalog.py` 的 CI Python 语法检查。

## 10. 验证边界

本轮可以确认：

- 共用任务窗格实现了网页端同构布局与来源/模型规则；
- API、代理、30B 翻译、朗读稿、WAV 和卸载链路真实通过；
- 远程服务未被关闭，本地 Ollama 未被启动；
- 窄任务窗格布局无横向溢出；
- 先前 Word/WPS 原生公式按钮实机证据仍有效。

本轮没有在真实 Word/WPS 文档内重新点击新增的“翻译选区”和“朗读选区”按钮。
因此不能把 API/代理集成测试写成宿主按钮级实机验收。下次需要在保存前的测试文档
中分别点击这两个按钮，核对文档替换、音频播放和停止操作，再升级这一证据等级。

## 11. 安装与入口

```powershell
.\install-document-addins.bat
```

- Word：**开始 → 加载项 → LocalReadTranslate 文档工作台**；
- WPS Writer：**LocalReadTranslate → 阅读与公式**。

修改加载项文件后，保存真实文档，再完整关闭并重开 Word/WPS。卸载仍使用：

```powershell
.\uninstall-document-addins.bat
```

卸载器只删除精确注册和安装器拥有的独立加载项宿主，不关闭 FastAPI、远程隧道或
本地 Ollama。
