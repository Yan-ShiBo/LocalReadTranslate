# Iteration 14：Word/WPS 自动加载与完整服务按需启动

**状态：** Word、WPS Writer 与 WPS PDF 的注册方式保持不变；FastAPI 保持
`1.7.20`，userscript 保持 `1.15.6`。安装器新增独立的轻量加载器登录入口，
完整 Local Read & Translate 程序继续保持非开机启动。

## 1. 用户目标

目标同时包含两条看似冲突、实际上应分层处理的要求：

1. 打开 Word/WPS 后，加载项入口和任务窗格应当可以正常加载；
2. Windows 登录时不能自动启动 FastAPI、Kokoro、Ollama、远程隧道、模型或
   托盘程序；真正需要翻译、朗读或公式服务时，由用户在加载项中点击
   **启动本地服务**。

原结构的 Word/WPS 清单、ribbon、任务窗格和控制按钮都由
`http://127.0.0.1:5443` 提供。如果 5443 也完全不运行，宿主无法取得插件页面，
用户自然也无法看到页面里的启动按钮。因此“零后台进程且仍能从本地任务窗格
启动”在当前纯 Web 加载项架构中形成循环依赖。

## 2. 分层启动结构

现行结构把运行时拆成两层：

```text
Windows 登录
  └─ LocalReadTranslate Add-in Loader.lnk
       └─ pythonw -E addon_host.py --pid-file ...
            ├─ 127.0.0.1:5443：Word/WPS 白名单静态资源
            ├─ /api/control/start：固定本地启动动作
            └─ /api/*：仅在 5000 在线时代理

用户在插件中点击“启动本地服务”
  └─ POST /api/control/start
       └─ localreadtranslate://start
            └─ windows_launcher.py
                 └─ tray_app.py
                      └─ 127.0.0.1:5000 + TTS/远程来源（按实际配置）
```

登录时的加载器只导入 Python 标准库并提供回环 HTTP 服务。它不会导入
PyTorch/Kokoro，不探测或启动 Ollama，不连接远程服务器，不加载模型，也不创建
托盘图标。完整程序的 `tray_settings.json -> auto_start` 不会被安装器修改。

## 3. 安装与卸载

保存文档并完整退出 Word/WPS 后运行：

```powershell
.\install-document-addins.bat
```

安装器除原有 Word/WPS 当前用户注册外，还会创建：

```text
%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\
  LocalReadTranslate Add-in Loader.lnk
```

该快捷方式与完整程序可选的：

```text
Local Read & Translate.lnk
```

是两个不同目标。安装加载项不会创建、修复、启用或覆盖完整程序的登录自启。
`-NoStart` 只跳过本次安装后的立即启动，不取消下次登录需要的轻量加载器。

卸载：

```powershell
.\uninstall-document-addins.bat
```

卸载器只删除轻量加载器快捷方式、Word/WPS 精确注册和加载器拥有的 PID 进程；
不会删除其他启动项，不停止本地 FastAPI、远程隧道或本地 Ollama。

## 4. 插件内按需启动

任务窗格初始化仍并行请求当前宿主适用的能力。如果 5000 完整服务离线：

- 来源和模型列表不伪造默认值；
- 显示 **启动本地服务**；
- 点击后只向同源加载器发送无请求体的固定 `start` 动作；
- 加载器不接受命令行、服务器地址、凭据、模型名或任意 URL；
- 任务窗格每秒轮询一次，最长等待 120 秒；
- 服务就绪后自动刷新真实来源和模型列表，不需要再次关闭插件。

该链路已在现有任务窗格中实现，本轮增加了专门的用户视角回归，确保服务离线
时按钮可见，点击精确发送 `start`，并进入 `mediator` 就绪轮询。

## 5. 生命周期与卸载安全

`addon_host.py` 新增可选的 `--pid-file`：

- 成功绑定并进入服务循环前原子写入当前 PID；
- 正常退出时只在 PID 仍属于自己时删除文件；
- 卸载器读取 PID 后，还会核对进程命令行同时包含 `addon_host.py` 和当前项目
  目录，避免停止无关 Python 进程；
- 托盘发现健康的外部 5443 加载器时直接复用，并标记为非托盘所有；
- 退出托盘不会停止登录加载器，Word/WPS 入口继续可用。

## 6. 验收边界

自动化覆盖以下公开行为：

- 轻量加载器使用独立快捷方式名称，不覆盖完整程序登录项；
- 重复安装会校验并修复加载器目标、工作目录和参数；
- 卸载只删除加载器快捷方式；
- CLI 生成的参数固定为 `pythonw -E addon_host.py --pid-file ...`；
- PID 文件只在加载器生命周期内存在；
- 安装/卸载脚本分别调用 `install-addin-loader` /
  `remove-addin-loader`；
- 完整服务离线时，Word/WPS 任务窗格显示 **启动本地服务**，并经 5443
  固定控制接口进入自动轮询。

本轮完整回归结果：

- Python：`274 passed`，另有 `17 subtests passed`；
- Node：`81/81 passed`，其中文档加载项 `28`，userscript `53`；
- 加载器/启动、加载项宿主与打包聚焦回归：`30 passed`；
- Python/JavaScript/PowerShell 语法、catalog 同步、FFmpeg、依赖完整性与
  `git diff --check` 均通过。

实际 Windows 安装后的验收还应同时确认：

1. `tray_settings.json` 仍为 `auto_start=false`；
2. 完整程序启动目录快捷方式不存在；
3. 轻量加载器快捷方式存在且指向当前 E 盘项目；
4. 5443 健康检查成功；
5. 5000 在用户未点击启动前可以保持离线；
6. 点击插件按钮后 5000 才启动并自动刷新任务窗格。
