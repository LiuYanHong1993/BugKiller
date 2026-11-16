# apps —— 壳层

| 目录 | 职责 | 智作对照 |
|---|---|---|
| `desktop/` | Electron 壳：主进程（窗口/协议/托盘/更新）、preload（contextBridge 白名单 + zod 校验）、启动屏 | app.asar 主进程 + preload |
| `web/` | 会话 Web UI：会话列表、消息流、工具调用卡片、文件面板、设置页 | dsh-client-ui-* 插件槽 |

## 壳层职责清单（模拟实现范围）

- 特权协议（如 `myapp://`）承载前端资源，CSP 动态注入
- 保管凭据（内核经 IPC 现取，壳内可用系统凭据库加密）
- 启动/关闭内核侧车进程（stdio IPC，父断开即 shutdown）
- 自动更新：feed 摘要 + 签名双校验
- 不可信内容用隔离 webview（随机 partition）

M2 之前用 `web/` 即可，`desktop/` 是 M4。
