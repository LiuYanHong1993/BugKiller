# BugKiller —— 本地优先的 AI 智能体平台

一个自研的本地优先 AI 智能体（Agent）平台。

## 架构总览

```
apps/
  desktop/        Electron 壳（npm i electron 后启用；缺包时自动 Node 壳模式）
  web/            会话 Web UI（业界主流的插件槽 UI 布局）
client/           Windows 原生客户端（C# WinForms + WebView2，系统 csc 编译为 agent-platform.exe）
kernel/           智能体内核
  src/agent/      agent loop：消息循环、上下文管理、compaction、计划模式
  src/tools/      工具注册与执行：fs / bash / pwsh / web / subagent / todo / ask-user
  src/llm/        模型接入：providers、重试、失败自动换模型（auto-model）
  src/sessions/   会话持久化（JSONL 追加 + SQLite 投影查询）
  src/sandbox/    沙箱与权限：workspace-write / read-only / 审批门
  src/mcp/        MCP 客户端（stdio / http），外部能力接入
plugins/          插件（cordis 风格：manifest + patch 装配，参考 example-echo）
workflow/         工作流运行时：DAG 引擎 + （可选）Docker 隔离执行器
policy/           策略与安全：凭据零落盘、审批回执、审计日志、镜像/资产哈希锁
data/             本地数据落盘（会话库、记忆、凭据引用）
docs/             架构文档与路线图
scripts/          启动 / 打包 / 校验脚本
```

## 设计原则

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

# 工作流（M3）：stdin JSON → stdout 事件 NDJSON（stdin JSON → NDJSON 事件契约）
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



## Roadmap / TODO

下一版本计划中的功能细节（按优先级排序）：

- [x] **斜杠命令系统**：输入 / 弹出命令面板（/clear、/export、/new、/model 等 11 个命令），↑↓ 选择、Enter 执行
- [x] **会话导出**：导出 Markdown（回合 + 工具结果）与 JSONL 原始档（命令 /export、/export-json）
- [ ] **会话导出**：导出 Markdown（回合 + 工具结果）与 JSONL 原始档
- [x] **审计视图**：审批决策时间线（工具 / 参数 / 结果），可按工具筛选，/audit 命令 + 设置页入口
- [x] **全局热键唤起**：Ctrl+Alt+B 显示/隐藏主窗口（Alt+Space 被 Windows 系统菜单保留，改用 Ctrl+Alt+B）
- [x] **输入历史召回**：空输入按 ↑ 回退最近 20 条发送记录，↓ 前进
- [x] **模型参数调节**：⚙ 面板（temperature 滑杆 0–1 / max tokens），保存即生效并持久化，注入每次对话请求
- [x] **组内会话拖拽排序**：拖会话到另一会话上（上/下半插入指示线），顺序持久化；跨组拖拽自动归组
- [x] **自定义专家编辑**：专家卡 ⋯ 菜单（编辑回填表单 / 删除），保存即生效
- [x] **写操作一键回滚**：轨迹页 write_file 行 ↩ 按钮 / POST /api/rollback，按会话账本恢复写入前状态（新建文件自动删除）
- [x] **后台任务完成通知**：窗口隐藏/最小化时回合完成弹托盘气泡（前台不打扰）
- [x] **自动更新检查**：启动后静默对比 GitHub Releases（走系统代理），发现新版弹右下角提示，点击打开下载页
- [x] **@ 提及**：输入 @ 弹出面板（工作区文件 + 专家），选中插入 @路径 或专家开场指令

## 参考与致谢

本项目的部分设计参考了以下开源项目与协议，在此致谢：

- [Model Context Protocol (MCP)](https://github.com/modelcontextprotocol) —— 工具生态协议：stdio/HTTP 双传输、tools/list、tools/call 的客户端实现，以及内置记忆服务（server-memory）的行为参考
- [Cordis / Koishi](https://github.com/koishijs/koishi) —— 插件生命周期模型（apply / ctx.on / dispose）的能力裁剪版
- [LangGraph](https://github.com/langchain-ai/langgraph) —— 工作流引擎的 DAG 节点、依赖拓扑与事件流设计思路
- [electron-updater](https://github.com/electron-userland/electron-builder) —— 「哈希清单 + 签名双校验」的更新安全模型

同时借鉴了多家业界 Agent 平台在会话、技能市场、知识库等形态上的公开交互实践。

## 目录约定

- 每个 `src/*` 子目录一个 `index.ts` 入口 + 单元测试放同目录 `*.test.ts`。
- `data/` 默认不入库（.gitignore），凭据永远不进 `data/` 明文文件。
