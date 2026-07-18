# Greasy Fork Additional Info

Copy the Markdown below into Greasy Fork's "Additional info" field.

Greasy Fork reads the project links from the userscript metadata:

- `@homepageURL https://github.com/Yan-ShiBo/LocalReadTranslate`
- `@supportURL https://github.com/Yan-ShiBo/LocalReadTranslate/issues`

Keep the GitHub links in both places: metadata makes them appear in Greasy Fork's structured script links, while the text below makes them visible inside the script description.

---

## 本地划词听译助手

选中网页上的文本后，可以直接：

- `Read`：英文含公式时先读正文，同时后台处理公式；播放到公式处如果还没处理好再等待，然后继续交给 Kokoro TTS 朗读
- `Translate`：默认调用本机 Ollama，也可以明确选择由 Windows 托盘程序配置的项目服务器模型
- `Copy`：不翻译，只复制选中原文；MathJax/MathML/KaTeX 公式会尽量扩展到完整公式框并复制为 LaTeX
- UI 使用原生 DOM API 构建，不使用 `innerHTML` 等 HTML 字符串注入，以兼容 Gemini 等启用 Trusted Types 的页面
- 在设置面板里切换并保存声音、语速、翻译模型和目标语言
- 使用 **Use project server** 选择可用的项目服务器模型，使用 **Initialize local model** 初始化所选本机 Ollama 模型
- 本地 API 尚未运行时，使用 **Start local service** 打开固定的 `localreadtranslate://start` 操作，再等待服务就绪
- 分别查看本地 API、按需加载的 TTS 与本机/项目服务器 Ollama 模型状态
- 在 Translation 设置栏手动常驻或卸载当前 Ollama 模型；频繁使用时减少首次加载等待，不用时释放显存
- 英文会尽量原样保留，中文会翻成英文；英文含公式的朗读会优先开始正文，公式在后台变成英文口语描述
- MathJax/MathML/LaTeX 会优先提取语义公式；翻译结果会把公式渲染为带上下标的易读公式，而不是显示原始 LaTeX 代码
- 翻译请求可附带附近正文作为参考上下文，只用于术语和指代消歧；真正翻译和输出的只有选中内容；选择远程模型时该上下文也会发送到对应服务器
- 上下文长度会按模型大小自动裁剪：4B 模型翻译和公式朗读不参考上下文，9B/14B/更大模型会逐级保留更多上下文
- `qwen3:14b`、QwQ、DeepSeek-R1 等推理模型会通过 Ollama `think: false` 关闭思考过程，降低翻译和朗读准备延迟
- 选择 4B 模型时，常见公式会优先使用本地保守字面读法，例如 `D_I` 读作 `D sub I`，`\hat{B}(x)` 读作 `B hat of x`
- 公式口语化会参考项目里的数学术语表；50+ 个核心数学符号会按语境选择更合适的读法，例如右箭头可读作“映射到、趋向于、推导出、得到、右箭头”
- 如果朗读稿准备接口不可用，`Read` 会退回到 `/translate` 并指定翻译成 English 后再朗读
- `Read` 和 `Translate` 可以同时进行；按钮行固定在选区下方，译文卡片会根据空间避让，减少遮挡正文
- 只选中 MathJax/MathML/KaTeX 公式的一部分时，脚本会尽量扩展到完整公式框；如果选中的是包含公式的一整句话，会保留公式前后的句子内容
- 如果 Gemini 等页面右下角齿轮都没有出现，优先检查 Tampermonkey/Chrome 扩展是否允许脚本在该域名运行；如果齿轮出现但划词按钮不出现，脚本会通过 `selectionchange` 兜底监听动态页面选区；脚本跨域访问本地服务使用 `GM_xmlhttpRequest`

## 重要：需要本地服务

当前用户脚本版本为 `1.13.0`。它不是单独安装就能工作的云端脚本：浏览器端始终需要本项目的本地 FastAPI 中介服务。

1. 按项目 README 完成环境安装，并至少启动本地 FastAPI 服务。
2. `Read` 需要 Kokoro TTS 环境；Kokoro 会在第一次朗读时按需加载，不会因仅启动 API 或仅使用远程翻译而占用本地 GPU。
3. 本机翻译需要安装 Ollama 并拉取本地模型，例如：

```powershell
ollama pull translategemma:4b
# 可选更大模型
ollama pull qwen3:14b
```

4. 如果只使用项目服务器翻译，本机可以不安装 Ollama；但必须从托盘菜单 `Remote Service` 保存并连接服务器，然后在网页设置中点击 **Use project server**。

托盘程序会为当前 Windows 用户注册 `localreadtranslate://start`。如果 **Start local service** 无法唤起托盘程序，在项目目录执行：

```powershell
conda run -n kokoro-tts python windows_protocol.py register
```

注册记录使用绝对路径；移动项目后需要重新执行。注册在 `HKCU` 下，不需要管理员权限。网页发起协议操作时，浏览器可能要求确认打开外部应用；协议只支持固定的 `start` 操作，不携带远程凭据或模型参数。

翻译、朗读稿准备和复杂公式口语化默认使用 `translategemma:4b`。可在服务端通过 `OLLAMA_TRANSLATE_MODEL`、`OLLAMA_READ_MODEL`、`OLLAMA_FORMULA_MODEL` 覆盖，也可在脚本设置里切换模型。设置栏里的 **Keep loaded** 会在当前模型所属来源上常驻模型，**Unload** 会从同一来源卸载模型释放显存。4B 模型的翻译和公式朗读不参考上下文，公式朗读也会优先采用保守字面规则；14B 模型会保留更多上下文。使用 `qwen3:14b`、QwQ、DeepSeek-R1 等推理模型时，服务端会自动向 Ollama 传入 `think: false`。
数学符号读法可在项目的 `config/math_glossary.json` 中调整，当前覆盖箭头、上下标、集合、逻辑、求和、积分、偏导等常见论文符号。

## 隐私说明

浏览器脚本只请求本机地址：

```text
http://127.0.0.1:5000
```

浏览器不会获得 SSH 密码、密钥路径或远程 Ollama 地址。本机模型模式下，朗读、翻译和允许的上下文都留在本机；当你明确选择项目服务器模型时，选中文本和允许的附近上下文会由本地 FastAPI 中介发送到你配置的服务器。

远程连接支持 SSH 隧道和 Direct API：

- SSH 模式优先使用 SSH agent、默认密钥或指定密钥文件，只有密钥认证失败且填写了密码时才回退到密码认证。客户端加载系统/OpenSSH 主机密钥，并拒绝 `known_hosts` 中不存在的主机。
- 如果填写了 SSH 密码，它会以明文保存在 Git 已忽略的 `tray_settings.json` 中。请保护 Windows 账户和项目目录，优先使用 agent/密钥，并且不要同步、提交或分享该文件。
- Direct API 只支持原生 Ollama API；当前实现不会添加 API key 或其他认证请求头。常见 `http://` 地址传输不加密，只应在可信局域网或 VPN 内使用，不应直接暴露到公网。
- Ollama 请求会绕过环境中的 HTTP 代理，避免局域网请求和选中文本经过无关代理。
- SSH 主机身份采用失败即关闭策略：客户端调用 `load_system_host_keys()` 并使用 Paramiko `RejectPolicy`。未知主机必须先通过可信渠道核对指纹，再加入 `known_hosts`；本机的 `10.12.96.203` 已按此策略实机重连成功。

## 常见问题

### 安装后没有反应

先点击设置面板中的 **Start local service**，接受浏览器的外部应用确认，然后检查：

```text
http://127.0.0.1:5000/health
```

如果打不开，先运行推荐的托盘启动器 `Kokoro TTS.bat`，或用上面的 `windows_protocol.py register` 命令修复协议。`start.bat` 只启动裸 FastAPI，不负责远程 SSH 隧道或协议唤起；需要项目服务器时必须使用托盘程序。
新版 `start.bat` 和 `Kokoro TTS.bat` 会直接定位 `kokoro-tts` 环境里的 Python，不需要先执行 `conda init`；`Kokoro TTS.pyw` 只在 Windows 已有关联 `.pyw` 到 Python 时适合双击。

### **Use project server** 提示没有可用模型

从托盘菜单打开 `Remote Service`，保存并连接服务器，确认检查成功后再回网页点击该按钮。远程主机和凭据不能在油猴脚本里配置。

### **Initialize local model** 提示不能初始化远端模型

这个按钮只用于本机 Ollama。先在模型列表选择一个本机模型并确保 Ollama 正在运行；远端模型请先在托盘中连接，再使用 **Use project server**、**Keep loaded** 或普通翻译请求。

### 翻译健康检测失败

通常是浏览器脚本已更新，但本地后台服务还没重启到最新版。重启本地服务后再刷新网页。

### 翻译第一次比较慢

Ollama 第一次使用某个模型时需要把模型加载到 GPU/内存，之后同一模型会快很多。

## 更新与发布

仓库中的 `tts-userscript.js` 与浏览器已安装副本是两份文件。发布者应递增 `@version`，运行项目测试并推送，确认 GitHub Raw 地址返回新版本，再从 Tampermonkey 执行“检查用户脚本更新”；Greasy Fork 也必须发布同一个版本号和本附加说明。仅修改本地仓库不会自动更新浏览器脚本。

## 项目地址

- GitHub: https://github.com/Yan-ShiBo/LocalReadTranslate
- 问题反馈: https://github.com/Yan-ShiBo/LocalReadTranslate/issues
- Raw userscript: https://raw.githubusercontent.com/Yan-ShiBo/LocalReadTranslate/main/tts-userscript.js
