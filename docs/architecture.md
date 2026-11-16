# 架构设计

>
## 进程模型

```
壳（Electron / 浏览器）
  │  ① stdio IPC：对称 request/response（self-check 反向验证、父断开即 shutdown）
  ▼
内核侧车（纯 Node 进程）
  ├─ 插件树（cordis 式装配，overlay.patch.yml 最高层）
  ├─ webserver：回环 + 随机端口，带令牌 URL 只经 IPC 交付
  ├─ stdio 子进程：MCP server / 沙箱执行器
  └─ 会话：JSONL 追加 + SQLite 投影 + compaction
```

## 关键决策记录

| 决策 | 选择 | 理由（来自业界的经验） |
|---|---|---|
| 内核/壳通信 | stdio JSON-RPC 对称协议 | 双向、可 self-check、防孤儿 |
| 插件机制 | npm 包 + patch 清单装配 | 装配可审计、可白标、可裁剪 |
| 会话存储 | JSONL 追加写（事实）+ SQLite（投影查询） | 写路径简单、查询灵活、可迁移 |
| 凭据 | 壳层保管 + IPC 现取 | 零落盘，日志脱敏 |
| 工具执行 | 统一 schema + pre-execute 钩子 | 权限/镜像/审计都挂在钩子上 |
| 工作流 | NDJSON 事件流 CLI + Docker digest pin | 可本地可远端，供应链可锁 |

## 与业界主流实现的差异（有意为之）

1. 不内置明文模型凭据（业界已知风险 #1）。
2. 托管/无人值守模式默认 `autoConfirm=false`。
3. 插件不提供运行时安装入口（编译期/装机期决定，缩小供应链面）。
