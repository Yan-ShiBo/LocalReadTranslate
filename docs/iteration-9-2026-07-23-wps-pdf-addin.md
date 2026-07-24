# Iteration 9：WPS 365 PDF 阅读、翻译与公式 LaTeX 复制加载项

**状态：** userscript 保持 `1.15.3`，FastAPI 升级为 `1.7.19`。已完成独立
`pdf` 包、只读宿主适配器、Writer/PDF 原子注册、
静态白名单、能力感知任务窗格、模型辅助公式识别和自动化回归。WPS 365
`12.1.0.26895` 已完成正式包实机验收：功能区、任务窗格、选区读取、本地朗读
和使用 `remote:project-server:qwen3:30b` 的“识别并复制为 LaTeX”按钮均已通过。

## 1. 问题与结论

WPS 365 把文字、演示和 PDF 放在同一个桌面外壳中，但加载项不是按外壳统一加载：
每个组件仍有自己的插件类型和对象模型。原项目只注册了 `type="wps"` 的 Writer
包，因此它只会在文字文档中出现。

本轮通过真实 WPS PDF 运行时确认：

- `publish.xml` 中的 `type="pdf"` 条目会被 WPS PDF 组件读取；
- PDF 会依次请求包的 `manifest.xml`、`ribbon.xml`、`index.html`、`main.js`
  和 ribbon 脚本；
- PDF 可以创建 WPS 任务窗格；
- PDF 选区文本入口是
  `Application.ActiveDocument.Selection.Text()`；
- 官方 ActivePDF 文档列出 `GetTextSelection()` / `GetSelectionPicture()`，
  但没有 PDF `Copy()`；公开的 `Selection.Copy()` 属于 Writer 对象；
- Writer 使用的 `Application.Selection` 在 PDF 中不存在；
- `Application.ribbonUI` 在 PDF 运行时不可重新定义，ribbon 回调句柄必须保存在
  模块内部；
- PDF 对图标回调值使用包地址进行解析，根相对路径
  `/assets/icon-32.png` 可以避免把完整 URL 错拼到 `/wps-pdf/` 后面。

因此，PDF 不能直接复用 Writer 适配器，但可以复用同一任务窗格、翻译 API、
朗读 API、来源/模型状态和设置存储。公式识别直接读取 PDF 选区文本保留的视觉
换行，不读取 Windows 剪贴板、不调用 Writer `Selection.Copy()`，也不注入
`Ctrl+C`。

## 2. 功能边界

| 能力 | Word | WPS Writer | WPS PDF |
|---|---:|---:|---:|
| 读取当前选区 | 支持 | 支持 | 支持 |
| 翻译并复制译文 | 支持 | 支持 | 支持 |
| 本地朗读 | 支持 | 支持 | 支持 |
| 用译文替换文档选区 | 支持 | 支持 | 不显示 |
| LaTeX 转内部可编辑公式 | 支持 | 支持 | 不显示 |
| 原生内部公式复制为 LaTeX | 支持 | 支持 | 不适用 |
| 可选择 PDF 公式识别并复制为 LaTeX | 不适用 | 不适用 | 支持，使用所选模型 |

PDF 的限制是宿主能力限制，不是前端临时禁用。任务窗格从适配器读取
`capabilities`：

```json
{
  "formulaTools": true,
  "convertFormula": false,
  "copyFormula": true,
  "requiresFormulaHealth": false,
  "formulaRecognition": true,
  "replaceSelectionText": false
}
```

因此 PDF 仍保留网页端一致的来源选择、真实模型列表、翻译、复制译文、声音、
语速和朗读；公式区只显示 **识别并复制为 LaTeX**，不会诱导用户点击必然
失败的 PDF 写回或内部公式插入动作。当前识别只支持可选择/矢量文本；扫描图片
公式需要后续 OCR/视觉模型链路。

## 3. 包与适配器

新增独立包：

- `addons/wps-pdf/manifest.xml`；
- `addons/wps-pdf/ribbon.xml`；
- `addons/wps-pdf/index.html`；
- `addons/wps-pdf/main.js`；
- `addons/wps-pdf/js/ribbon.js`；
- `addons/wps-pdf/pdf-adapter.js`。

正式包名为 `LocalReadTranslatePdf`，入口地址为：

```text
http://localhost:5443/wps-pdf/
```

PDF 功能区只包含一个 **阅读与翻译** 按钮。按钮创建：

```text
http://localhost:5443/taskpane/taskpane.html?host=wps-pdf
```

PDF 适配器公开 `readSelectionText()` 和只读的
`exportSelectionForLatex()`：后者返回
`{source_format: "wps-pdf-selection", content: text}`，不执行复制或写入。
它不会提供 `replaceSelectionWithText()` 或
`replaceSelectionWithFragment()`，从接口层阻止调用者绕过 UI 执行 PDF 写入。

## 4. 共享任务窗格

任务窗格现在识别三个明确宿主：

- `host=office`；
- `host=wps`；
- `host=wps-pdf`。

初始化顺序保持不变：

1. 解析宿主并创建适配器；
2. 应用适配器能力；
3. 并行发现当前宿主适用的服务；PDF 只检查翻译和声音，不请求 Pandoc
   公式健康接口，模型辅助识别复用翻译来源发现；
4. 恢复来源级设置和真实模型选择；
5. 读取当前选区预览。

PDF 初始化时隐藏“替换选区”和 LaTeX 写回按钮，但保留折叠的
“公式与 LaTeX”区及 **识别并复制为 LaTeX**。按钮动作会重新读取当前选区，
把文本、空 `html` 字段和精确模型引用发送到普通
`/document/pdf-selection-to-latex` API；服务返回内容必须先通过规范 LaTeX
校验，随后才写入纯文本剪贴板。翻译、朗读和公式按钮都复用缓存的来源状态，
不会在每次点击前重新显示 “Checking translation sources...”。

如果没有保存过服务器模型，任务窗格优先选择精确的 `qwen3:30b`；没有该模型
时再选择真实发现且不超过 32B 的候选，避免仅因 122B 模型排在第一项就默认
加载它。

## 5. Writer 与 PDF 原子注册

`addin_registration.py` 默认一次安装两个 WPS 条目：

```xml
<jspluginonline
  name="LocalReadTranslateFormula"
  type="wps"
  url="http://localhost:5443/wps-word/"
  ... />
<jspluginonline
  name="LocalReadTranslatePdf"
  type="pdf"
  url="http://localhost:5443/wps-pdf/"
  ... />
```

合并规则继续保证：

- 解析失败时不覆盖原文件；
- 保留所有无关加载项；
- 删除同名或同 URL 的旧条目；
- Writer 与 PDF 在一次临时文件替换中共同写入；
- 重复安装字节级幂等；
- 默认卸载只删除本项目的 Writer/PDF 条目。

Office manifest 仍是第三个、独立的当前用户注册。安装脚本会在修改 WPS
`publish.xml` 前备份原文件。

## 6. 回环宿主与安全边界

`addon_host.py` 只新增六个明确的 `/wps-pdf/*` 静态资源，不开放目录浏览或任意
仓库文件。其余边界不变：

- 只绑定 `127.0.0.1:5443`；
- 只代理 `/api/*` 到 `127.0.0.1:5000`；
- 不向加载项暴露 SSH 凭据、远程地址或认证信息；
- 远程模型由托盘和 FastAPI 既有路由选择；
- PDF 适配器只读取用户当前选中的文本；
- 选择项目服务器模型时，只有当前选区和已有请求参数会发送到该服务器；
- PDF 不创建 DOCX 临时文件，不调用 Pandoc，不写回 PDF。
- PDF 公式请求走现有 `/api/document/pdf-selection-to-latex` 同源代理，不新增
  任意按键/窗口控制入口；
- 加载项宿主不读取 Windows 剪贴板；最终 LaTeX 只由任务窗格在模型结果通过
  后写入。

## 7. 真实兼容性探针

为了先回答“WPS 365 内置 PDF 是否可以拥有加载项”，本轮建立了一个临时
`LocalReadTranslatePdfProbe`，地址指向独立的 `127.0.0.1:5444` 探针宿主。

WPS 365 `12.1.0.26895` 的实际结果：

1. WPS 为该条目建立了 `authaddin.json` 的 `pdf` 分区；
2. 启用后，PDF 请求了完整加载项入口资源；
3. PDF 功能区出现 `LocalReadTranslate`；
4. 点击按钮成功打开任务窗格；
5. Writer 任务窗格在 PDF 中精确报错
   `WPS Writer JavaScript API is unavailable`；
6. JS 调试器确认 `Application.ActiveDocument.Selection` 存在，
   `Selection.Text` 是函数，未选择文字时返回空字符串；
7. 旧 Writer ribbon 还暴露了两个 PDF 专属兼容问题：
   `Cannot redefine property: ribbonUI` 和绝对图标 URL 错拼；
8. 正式 PDF ribbon 已分别修复这两个问题。

这个探针证明 PDF 宿主能力真实存在，同时也证明必须使用独立适配器。探针本身
不被当成正式安装验收；后续已经替换临时注册、重启 WPS，并在正式
`LocalReadTranslatePdf` 包上完成第 9 节的按钮级验收。

## 8. 自动化验证

当前已完成：

- Node 文档加载项核心：`25 passed`；
- Python 加载项宿主与公式 API 聚焦回归：`27 passed`；
- 完整 Python 回归：`263 passed`，另有 `17 subtests passed`；
- 完整 Node 回归：`74 passed`（文档加载项 25，网页脚本 49）；
- Python 语法、用户脚本语法、catalog 同步、bundled FFmpeg、依赖完整性和
  `git diff --check` 均通过。

新增覆盖包括：

- `?host=wps-pdf` 的确定性识别；
- 嵌套 `Selection.Text()` 读取；
- PDF 不暴露文档写入方法；
- PDF 只显示模型辅助的 LaTeX 复制，不显示公式写回和替换按钮；
- PDF 公式请求直接代理选区文本，不依赖剪贴板或 `Copy()`；
- 服务器选区重建提示覆盖视觉换行、上下标、CMEX 下括号和尾随标点；
- 新鲜服务器模型选择优先精确 `qwen3:30b`，不会默认选择排在前面的 122B；
- 翻译与朗读按钮在 PDF 仍可用；
- PDF ribbon 创建、复用和切换任务窗格；
- ribbon 不修改 `Application.ribbonUI`；
- Writer/PDF 一次安装、幂等和精确卸载；
- `/wps-pdf/manifest.xml` 与适配器只通过静态白名单提供；
- 加载项宿主日志对旧版 Windows 控制台编码安全，不会因畸形请求诊断触发
  `UnicodeEncodeError`。

## 9. 正式包实机验收

正式 `LocalReadTranslatePdf` 包已在 WPS 365 Windows
`12.1.0.26895` 完成以下按钮级验证：

1. `type="pdf"` 与 `authaddin.json` 条目启用并加载；
2. 功能区出现 **LocalReadTranslate → 阅读与翻译**；
3. 任务窗格显示 `WPS PDF`，能读取真实段落和公式选区；
4. **朗读选区** 实际开始本地播放、切换为 **停止朗读**，并能正常停止；
5. 项目服务器恢复后，来源显示 **Project Server 已连接**，模型选择明确为
   `Project Server / qwen3:30b`；
6. 对论文中含上下标和 18 项下括号的 92 字符公式点击
   **识别并复制为 LaTeX**，面板显示 **已复制 1 个公式**；
7. `addon-host.log` 记录
   `POST /api/document/pdf-selection-to-latex HTTP/1.1" 200`；
8. Windows 剪贴板只有一份规范显示公式：

   ```latex
   $$
   u_1 = \underbrace{-2.41x_1 + 0.426x_2 + 0.276x_1^2 - \cdots - 0.453x_2^4 - 0.0691}_{18 \text{ terms}},
   $$
   ```

9. 同一时刻远程 `/api/ps` 只列出 `qwen3:30b`，参数规模 `30.5B`、
   量化 `Q4_K_M`；没有调用 100B+ 模型，本机 `11434` 未监听。

该结果同时验证了两层边界：WPS PDF 可以识别并复制 LaTeX，但仍不能把结果写成
PDF 内部可编辑公式；模型调用只在用户点击并明确选择可达来源后发生。

## 10. 安装与入口

保存所有 Word/WPS 文档并完整退出 WPS Office 后运行：

```powershell
.\install-document-addins.bat
```

重新打开后：

- Word：**开始 → 加载项 → LocalReadTranslate 文档工作台**；
- WPS Writer：**LocalReadTranslate → 阅读与公式**；
- WPS PDF：**LocalReadTranslate → 阅读与翻译**。

卸载：

```powershell
.\uninstall-document-addins.bat
```

卸载器不会关闭远程隧道、本地 FastAPI 或本地 Ollama，也不会删除其他 WPS
加载项。

## 11. 版本边界

WPS 公共加载项部署说明列出的主要组件类型仍是 `wps`、`et` 和 `wpp`，没有把
桌面 PDF 类型作为通用兼容承诺。因此本项目只把 WPS PDF 支持声明为：

- 已在 WPS 365 Windows `12.1.0.26895` 实机验证；
- 通过独立 `type="pdf"` 注册启用；
- 公式识别要求 PDF 存在可选择的文本层；扫描图片公式当前不支持；
- 旧版本、企业定制版或关闭 JavaScript 加载项能力的安装包需要重新探测；
- 不把同一 WPS 365 外壳等同于所有组件自动共享 Writer 插件。

参考：

- [WPS 加载项开发说明](https://open.wps.cn/documents/app-integration-dev/wps365/client/wpsoffice/wps-integration-mode/wps-addin-development/wps-addin-development-instructions)
- [WPS Application 对象](https://open.wps.cn/documents/app-integration-dev/wps365/client/wpsoffice/jsapi/addin-api/Application/obj)
- [WPS ActivePDF 选区接口](https://open.wps.cn/documents/app-integration-dev/docs-center/online-preview-edit/client/PDF/ActivePDF)
- [WPS Writer Selection.Copy](https://open.wps.cn/documents/app-integration-dev/wps365/client/wpsoffice/jsapi/wps/Selection/member/Copy)
