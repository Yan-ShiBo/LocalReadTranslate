# Iteration 11：网页设置面板视觉修复与跨站样式隔离

**状态：** userscript 升级为 `1.15.5`，FastAPI 保持 `1.7.19`。来源发现、
模型过滤、翻译、朗读、常驻和卸载契约没有改变；本轮只修复网页设置面板的视觉层级、
表单样式污染和窄屏定位。

## 1. 问题

`1.15.1` 把翻译来源改为后台驱动时，同时把设置面板从双栏结构改成了 390px
单栏结构。功能状态更真实，但首版视觉实现存在两个问题：

1. 每个来源、状态、测试结果、Advanced 和 Read aloud 都使用独立边框与背景，
   形成“卡片套卡片”，面板纵向过长；
2. 面板通过 `GM_addStyle` 注入普通页面 DOM，没有独立的级联边界。部分网站对
   `button`、`select`、`label`、`details` 或 `summary` 使用全局
   `!important` 样式后，会把下拉框改成白色、放大标签与按钮并破坏间距。

截图中深色面板、状态色和选中边框仍然存在，说明 userscript 样式已经加载；白色
下拉框和巨大表单控件来自页面样式覆盖，而不是 CSS 文件完全失效。

## 2. 设计目标

设置面板是阅读和翻译工具，不是服务器管理后台：

- 首屏只强调当前来源、模型和测试翻译；
- Local Ollama 与 Project Server 始终是明确的两个来源入口；
- 来源入口本身就是交互，因此可以保留轻量边框，其他区域不再使用装饰性卡片；
- 模型选择与测试翻译位于同一工作行；
- Advanced 与 Read aloud 只使用分隔线和折叠标题；
- 页面自身的表单样式不能改变面板的字号、颜色、间距、外观或可见状态；
- 390px 窄屏下不允许内部横向滚动，来源名称与 Start/Connect 动作必须完整可见。

视觉令牌采用深墨蓝背景、冷蓝交互色、薄荷绿可达状态、琥珀色提醒和粉红色错误。
标题使用 Windows 可用的 Segoe UI Variable / Microsoft YaHei UI，模型名称使用
Cascadia Mono / Consolas。唯一的识别元素是标题左侧的细蓝色阅读标记和双来源状态轨。

## 3. 实现

### 3.1 高优先级样式边界

设置面板获得稳定 ID `local-read-translate-settings`。所有关键选择器以该 ID 为边界，
并只对容易被宿主页面污染的几何、字体、背景、边框、原生外观和可见状态使用
`!important`：

- 根节点声明 `color-scheme: dark`；
- `button`、`select`、`input`、`label`、`details` 和 `summary` 显式恢复项目字体、
  大小写、间距、边框与背景；
- select 使用一致的深色背景和 CSS 箭头；
- `[hidden]` 使用高于普通按钮规则的级联优先级，避免已隐藏动作重新出现；
- 齿轮入口也完整重置尺寸、边框、字体和原生按钮外观。

没有改用 Shadow DOM，因为当前 userscript 的状态刷新和交互代码仍通过
`document.getElementById` 与页面级事件委托访问控件。此次边界修复避免扩大功能改动，
同时覆盖已复现的全局 `!important` 污染。

### 3.2 紧凑布局

- 面板常规宽度为 420px；
- 两个来源在同一双列状态轨中；
- 模型选择占剩余宽度，Test translation 使用 128px 操作列；
- 默认测试提示改为无背景的一行辅助文本；
- Advanced/Read aloud 去掉外层圆角卡片，只保留水平分隔线；
- Advanced 的目标语言使用标签/控件双列布局，Keep loaded 与 Unload 并排；
- 设置面板内隐藏 emoji 图标，按钮只保留稳定的动作文本；
- 520px 以下面板宽度改用 `calc(100% - 24px)`，避免 Windows 可见滚动条造成
  `100vw` 计算越界；
- 极窄的 350px 以下视口再把来源与主要操作切回单列。

### 3.3 可访问性

`appendLabeledControl()` 现在为每个有 ID 的控件设置对应的 `label.htmlFor`。键盘
焦点仍使用清晰的 2px 冷蓝色轮廓，`prefers-reduced-motion` 继续关闭面板、按钮和
折叠箭头动画。

## 4. 可复现视觉夹具

新增
`tests/fixtures/userscript-settings-hostile.html`。该页面故意使用红色虚线、米黄色背景、
20px Georgia 字体、大写转换和大内边距，并对所有表单元素声明 `!important`。
userscript 必须在这个页面上保持自己的深色紧凑布局。

生产脚本只在主机名为 `127.0.0.1` 或 `localhost` 且页面显式设置
`window.__LOCAL_READ_TRANSLATE_VISUAL_FIXTURE__ = true` 时自动打开设置面板。
普通网页不能触发该夹具入口，齿轮点击仍保留 `event.isTrusted` 防注入检查。

## 5. 验证结果

### 自动化

- `node --test tests/userscript-core.test.cjs`：`51/51` 通过；
- 新增回归断言覆盖面板 ID、label 关联、dark color-scheme、控件重置、双来源布局、
  模型/测试工作行、并排模型动作以及仅限 loopback 的视觉夹具入口。
- `node --check tts-userscript.js` 与完整 Node 回归：
  `78/78` 通过；
- 目录同步、Python 编译和 bundled FFmpeg 检查通过；
- 完整 Python 回归：`264 passed, 1 warning, 17 subtests passed`；
- `python -m pip check`：`No broken requirements found`。

### 浏览器视觉复核

在 hostile 样式页面上使用生产 userscript：

- 常规视口：面板 `420 × 459.47px`，内部横向溢出 `0`；
- 模型 select 计算背景为 `rgb(22, 29, 43)`，不再被改成白色；
- 模型标签为 10px、透明背景、无边框、零内边距；
- 已隐藏的 Start local service 计算 `display: none`；
- 齿轮稳定为 `40 × 40px`、无边框、零内边距；
- 390 × 844 测试中，Windows 滚动条使文档可用宽度为 375px，面板最终为
  351px 宽、左边距 12px、内部横向溢出 `0`；
- 选择离线 Local Ollama 后，来源名称 `clientWidth = scrollWidth = 75px`，
  “Local Ollama” 与 Start 同时完整显示。
- 340 × 740 极窄测试中，文档可用宽度为 325px，面板为 301px 宽、左边距
  12px，来源自动切为 271px 单列且内部横向溢出仍为 `0`。

该视觉夹具全部使用本地 stub 状态，没有启动本地 Ollama，也没有向项目服务器发送
模型请求。

## 6. 发布边界

本轮发布文件包括：

- `tts-userscript.js`；
- `tests/userscript-core.test.cjs`；
- `tests/fixtures/userscript-settings-hostile.html`；
- README、中文说明、Greasy Fork 附加信息和相关历史设计文档。

推送 GitHub 后，Tampermonkey 与 Greasy Fork 仍需分别确认安装/发布版本为 `1.15.5`。
仅修改仓库不会自动替换浏览器中已安装的副本。
