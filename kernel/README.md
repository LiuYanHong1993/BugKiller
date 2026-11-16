# kernel —— 智能体内核

智能体运行时内核。

## 模块

| 目录 | 职责 | 业界参考 |
|---|---|---|
| `src/agent/` | agent loop：系统提示、消息循环、工具调用、上下文压缩（compaction）、计划模式 | 内核 / 内核 / 内核 |
| `src/tools/` | 工具协议与内置工具：fs、bash/pwsh、web_fetch、subagent、todo、ask_user、present | 内核 |
| `src/llm/` | 模型接入层：多 provider 预设、远程发现、重试、失败自动切换（auto-model） | 内核 / model-provider-catalog |
| `src/sessions/` | 会话持久化：JSONL 追加写 + SQLite 投影 + 格式版本迁移 | 内核 / -query-sqlite |
| `src/sandbox/` | 权限模式（read-only / workspace-write / full）、写前镜像、审批门 | 内核 / write-guard |
| `src/mcp/` | MCP 客户端：stdio/http 传输、资源、能力声明 | 内核 |

## 第一个里程碑（M1）

最小可跑：`agent` 收一条用户消息 → 调 `llm` → 需要时调 `tools`（read/write 两个文件工具）→ 写入 `sessions`（JSONL 一行一事件）→ 回复用户。无 UI，CLI 即可。
