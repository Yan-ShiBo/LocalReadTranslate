# Iteration 12: Windows 启动链路与快捷方式修复

> **Iteration 13 后续说明：** Windows 启动链路保持不变。当前 userscript 为
> `1.15.6`；设置面板的跨页面状态缓存与后台刷新见
> [`iteration-13-2026-07-26-userscript-health-cache.md`](iteration-13-2026-07-26-userscript-health-cache.md)。

**状态：** userscript 保持 `1.15.5`，FastAPI 升级为 `1.7.20`。网页
**Start local service**、**Local Ollama → Start**、开始菜单启动和登录自启
现在共用同一个隔离且可诊断的 Windows 启动链路。

## 用户可见故障

- 点击网页 **Start local service** 后仍保持离线；
- 点击 **Local Ollama → Start** 看不到结果；
- 开始菜单中的 **Kokoro TTS** 双击无反应，而且名称与当前产品不一致。

故障前的确定性复现调用了实际 `localreadtranslate://start`，Windows 没有返回
协议错误，但 12 秒后 `127.0.0.1:5000` 仍未监听。注册命令当时是：

```text
"C:\Users\YanShibo\.conda\envs\kokoro-tts\pythonw.exe" "D:\LocalReadTranslate\tray_app.py" "%1"
```

开始菜单快捷方式则仍指向已经删除的旧目录：

```text
target:    C:\Users\YanShibo\.conda\envs\kokoro-tts\pythonw.exe
arguments: "d:\local-tts-env\tray_app.py"
workdir:   d:\local-tts-env
```

## 根因

同一条启动命令改用控制台 Python 重放后立即得到：

```text
ImportError: Module use of python312.dll conflicts with this version of Python.
```

`kokoro-tts` 环境本身是 Python `3.10.20`，但 Windows 用户环境中的
`PYTHONPATH=C:\Program Files\SVP 4\mpv64` 把 SVP 自带、文件版本为
Python `3.12.9` 的 `select.pyd` 放到了环境标准库之前。`pythonw` 隐藏了该异常，
所以网页和双击启动都表现为“没有反应”。使用 Python `-E` 后，`select` 正确解析到：

```text
C:\Users\YanShibo\.conda\envs\kokoro-tts\DLLs\select.pyd
```

这是应用启动隔离问题，不需要也不应删除 SVP 或修改用户的全局 `PYTHONPATH`。
旧开始菜单快捷方式是第二个独立、已确认的问题。

## 实现

1. `windows_protocol.py` 注册 `pythonw -E windows_launcher.py "%1"`。
2. `windows_launcher.py` 在导入托盘前建立稳定工作目录；隐藏启动失败时弹窗，并把
   Python、参数、工作目录和完整堆栈追加到
   `%LOCALAPPDATA%\LocalReadTranslate\launcher.log`。
3. 托盘启动 `server.py` 和 `addon_host.py` 时也传入 `-E`，避免父进程环境再次
   污染子进程。
4. `setup.bat`、`start.bat`、`LocalReadTranslate.bat` 和旧兼容启动器统一使用
   隔离 Python；没有修改系统环境变量。
5. `windows_startup.py` 同时管理开始菜单和登录自启：
   - 当前名称是 **Local Read & Translate**；
   - 目标为当前环境 `pythonw.exe`，参数为当前仓库的隔离启动器；
   - 仅当旧 **Kokoro TTS** 快捷方式的目标、参数或工作目录能够确认属于本项目时
     才删除；同名但无关的快捷方式保留。
6. 托盘标题、错误框和图标名称改用 **Local Read & Translate**。内部 Conda
   环境名、服务标识和单实例 mutex 保持不变，避免升级时出现重复实例或破坏兼容。

## 实机验收

修复并读回注册表与快捷方式后：

- `localreadtranslate://start` 在 11 秒内使 `127.0.0.1:5000` 可达；
- 重启后的 `/health` 返回 FastAPI `1.7.20`、`ready=true`、
  `api_ready=true`、`tts_model_loaded=false`；
- `localreadtranslate://ollama` 从离线到 `/api/tags` 可达用时 3 秒；
- 本机发现 5 个已安装模型，但 `/api/ps` 模型数为 0，因此没有加载 30B、100B+
  或任何其他 Ollama 模型；
- 远程服务配置和进程没有被关闭或重置。

本轮新增/更新的定向回归首先以 4 个失败证明旧命令未隔离，修复后协议、托盘、
启动日志与版本检查共 `45 passed + 2 subtests`，快捷方式迁移共 `7 passed`。
完整本机验证为：

- Python：`269 passed + 17 subtests`；仅有既存的
  `StarletteDeprecationWarning`；
- Node：`78/78`；
- `node --check`、Python 编译、目录同步检查、bundled FFmpeg、
  `pip check`、`git diff --check` 全部通过。

代码提交 `8edcb16` 已由 GitHub Actions 运行
[`30181598032`](https://github.com/Yan-ShiBo/LocalReadTranslate/actions/runs/30181598032)
验证通过；`test` 作业中的目录同步、Python 语法、bundled FFmpeg、Python
测试、JavaScript 语法与测试、依赖检查均为 `success`。

## 修复命令

移动仓库、迁移 Conda 环境或手动恢复当前用户入口时运行：

```powershell
conda run -n kokoro-tts python -E windows_protocol.py register
conda run -n kokoro-tts python -E windows_startup.py install-menu
```

两条命令都只修改当前用户范围；不需要管理员权限。
