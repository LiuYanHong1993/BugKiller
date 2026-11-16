# agent-platform —— 我的 Agent 平台（模拟实现）

一个参照「智作·开发者平台」架构设计的自研 Agent 平台骨架。
参考解析报告：[../智作平台软件实现全盘解析.md](../智作平台软件实现全盘解析.md)

## 架构总览

```
apps/
  desktop/        Electron 壳（npm i electron 后启用；缺包时自动 Node 壳模式）
  web/            会话 Web UI（对应智作的 React 插件槽 UI / Vue 壳层）
client/           Windows 原生客户端（C# WinForms + WebView2，系统 csc 编译为 agent-platform.exe）
kernel/           智能体内核（对应智作的 DSH + host 侧车）
  src/agent/      agent loop：消息循环、上下文管理、compaction、计划模式
  src/tools/      工具注册与执行：fs / bash / pwsh / web / subagent / todo / ask-user
  src/llm/        模型接入：providers、重试、失败自动换模型（auto-model）
  src/sessions/   会话持久化（JSONL 追加 + SQLite 投影查询）
  src/sandbox/    沙箱与权限：workspace-write / read-only / 审批门
  src/mcp/        MCP 客户端（stdio / http），外部能力接入
plugins/          插件（cordis 风格：manifest + patch 装配，参考 example-echo）
workflow/         工作流运行时：DAG 引擎 + （可选）Docker 隔离执行器
policy/           策略与安全：凭据零落盘、审批回执、审计日志、镜像/资产哈希锁
data/             本地数据落盘（模拟 ~/.stratex：会话库、记忆、凭据引用）
docs/             架构文档与路线图
scripts/          启动 / 打包 / 校验脚本
```

## 设计原则（从智作平台学到的）

1. **内核与壳分离**：内核是纯 Node 进程，壳（Electron/Web）只做展示与桥接，IPC 对称 request/response。
2. **插件树装配**：一切能力都是插件，由一份 overlay.patch.yml 式清单装配，可关遥测、换品牌、裁剪工具。
3. **凭据零落盘**：凭据由壳层保管，内核每次经 IPC 现取；日志统一脱敏。
4. **一切哈希锁**：资产、运行时、镜像逐文件 sha256，更新走摘要+签名双校验。
5. **fail-closed**：守卫名单未到先拒绝；离线无模型则拒绝对话。

## 快速开始

```bash
# CLI 交互（M1）
npm run dev                # 交互式；npm run dev "一句话任务" 单发
npm run sessions           # 列出历史会话；npm run dev -- --open <id> 续聊

# Web UI（M2）：内核起本地服务，浏览器打开打印的带令牌地址
npm run serve              # 默认 MYAGENT_BASE_URL 指向本地 llama.cpp

# 工作流（M3）：stdin JSON → stdout 事件 NDJSON（对照 stratex-flow）
echo {"name":"demo","steps":[{"id":"a","prompt":"..."}]} | npm run flow

# 桌面壳（M4）：侧车 + 凭据库 + 更新校验（Electron 缺包时自动 Node 壳模式）
npm run desktop             # --open 参数自动打开浏览器

# 打包 Windows 安装程序（Ed25519 签名 + 全量 sha256，安装前自动验签）
npm run package             # 产物：dist/agent-platform-<version>.zip
#   原生客户端：双击包内 agent-platform.exe —— 未安装先出安装向导（写注册表卸载项），
#               已安装则托盘常驻 + WebView2 内嵌界面（client/，系统 csc 编译，零下载）
#   卸载：Windows「设置 › 应用」或 agent-platform.exe --uninstall
#   脚本安装（可选）：install.ps1 [-AddToPath]；签名私钥在 keys/（不进包）

# 环境变量
#   MYAGENT_BASE_URL / MYAGENT_MODEL   覆盖模型端点
#   MYAGENT_AUTO_APPROVE=1             无人值守（写操作自动放行）
#   MYAGENT_PRESET                     选 policy/model-provider-catalog.json 里的预设
```

- 路线图：[docs/roadmap.md](docs/roadmap.md)，M1（CLI 内核）与 M2（Web UI + MCP + 审批卡）已完成。
- 测试：`npm test`（node:test，零依赖）。

## 目录约定

- 每个 `src/*` 子目录一个 `index.ts` 入口 + 单元测试放同目录 `*.test.ts`。
- `data/` 默认不入库（.gitignore），凭据永远不进 `data/` 明文文件。
