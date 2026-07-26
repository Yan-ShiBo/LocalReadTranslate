# Iteration 13: 网页翻译状态缓存与后台刷新

**状态：** userscript 升级为 `1.15.6`，FastAPI 保持 `1.7.20`。设置面板在
首次真正没有历史状态时仍显示检查提示；之后打开面板或重新载入网页时，会先恢复
上次已知的翻译来源、模型和可用状态，再在后台静默检查并更新。

## 1. 用户可见问题

设置面板每次创建后都会立即调用 `/translate/health`。旧实现以阻塞式可见状态启动
该调用，并在请求发出前清空 `translationHealthPayload`，因此面板会重新显示：

```text
Checking translation sources...
```

同一网页关闭再打开面板时会重复这一过程；网页重新载入后，来源状态只存在内存中，
也无法复用上次结果。

修复前的两项定向回归稳定失败：核心没有翻译健康快照规范化函数，面板初始化路径也
没有缓存恢复和后台保留状态调用。

## 2. 当前行为

userscript 使用 `GM_getValue` / `GM_setValue` 保存一个版本化快照：

```text
local-read-translate-translation-health-v1
```

快照只包含：

- schema 版本与保存时间；
- 本地 FastAPI 中介上次是否在线；
- `/translate/health` 返回的公开来源、模型与运行状态；
- 最后一次健康检查错误。

它不保存选中文本、翻译结果、SSH 密码、密钥路径、远程 Ollama 地址或其他凭据。

打开面板时的顺序现在是：

1. 如果当前页面内存中已有状态，直接继续使用；
2. 否则同步读取并校验上次快照；
3. 在浏览器绘制面板前先按该状态渲染来源和模型；
4. 立即在后台请求 `/health` 与 `/translate/health`；
5. 成功、不可用、超时或离线结果返回后，使用最新状态更新界面和快照。

没有合法快照的第一次打开仍显示 `Checking translation sources...`，避免伪造任何
默认模型。快照只是后台响应到达前的临时显示，不是当前连接状态的证明；最新后台
响应始终是最终状态。恢复和刷新都不会发起翻译、模型加载、常驻或卸载请求。

## 3. 并发与错误边界

- 后台刷新使用原有请求代次编号，较旧响应不能覆盖较新的来源或模型选择；
- 保留状态刷新不再因为 payload 为空而主动切回 Checking；
- 成功响应会保存实际发现的来源与模型；
- HTTP 错误、无效 JSON、网络错误和超时会替换旧快照，而不是无限显示过期的
  Ready 状态；
- 本地服务最终离线时会保存离线状态；启动中的临时状态不会覆盖最后稳定快照。

## 4. 验证

定向回归先以 `2 failed` 证明旧实现缺少跨页面恢复，修复后相关 `4/4` 通过。

完整本地验证：

- JavaScript 语法通过；
- userscript 与 Office/WPS JavaScript 回归共 `80/80` 通过；
- Python 回归 `269 passed + 17 subtests`，仅有既存的
  `StarletteDeprecationWarning`；
- 首次 Python 沙箱运行的 12 个 setup error 均来自 pytest 无权访问 Windows
  临时目录；在允许访问同一临时目录后，完全相同的测试集全部通过。

隔离浏览器夹具把 `/translate/health` 人为延迟 `1.2s`，验证了完整时序：

1. 新测试命名空间第一次打开时显示 Checking；
2. 后台响应后显示 `Ready` 与
   `remote:project-server:qwen3:30b`；
3. 重新载入网页后，在延迟响应返回前立即显示上次 Ready 状态和同一模型；
4. 第二次后台响应改为服务器不可达后，面板自动切换为 `Connect server`，
   隐藏模型选择并显示重连提示。

该夹具只使用本地 stub，不连接项目服务器、不启动 Ollama，也不加载任何模型。

## 5. 发布文件

- `tts-userscript.js`；
- `tests/userscript-core.test.cjs`；
- `tests/fixtures/userscript-settings-hostile.html`；
- `tests/test_release_metadata.py`；
- README、中文说明、Greasy Fork 附加信息与相关设计/迭代索引。

Tampermonkey 和 Greasy Fork 保存各自的脚本副本。GitHub 推送完成后仍需让已安装脚本
更新到 `1.15.6`；仅刷新普通网页不会把旧版 `1.15.5` 自动替换为新版本。
