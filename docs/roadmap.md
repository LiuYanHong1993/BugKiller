# 实现路线图

## M1 —— 最小内核（CLI 可对话）✅ 2026-11-04 完成
- [x] `kernel/src/llm`：单 provider（OpenAI 兼容协议）+ 重试（429/5xx/网络错误指数退避 ×3）
- [x] `kernel/src/agent`：agent loop（系统提示 + 工具调用循环，16 轮上限）
- [x] `kernel/src/tools`：read_file / write_file 两个工具 + 权限门（写要审批）+ 工作区路径沙箱
- [x] `kernel/src/sessions`：JSONL 追加 + 会话列表 + 历史回放
- ~~验收：`node scripts/dev.js "你好"` 产出带工具调用的完整会话文件~~
  ✔ 已验收：本地 llama.cpp（qwen-local）跑通 write_file 全链路，5/5 单元测试通过

## M2 —— Web UI + 会话管理 + MCP ✅ 2026-11-04 完成
- [x] `apps/web`：会话列表 / 消息流 / 工具卡片 / 审批卡（原生三件套，无构建）
- [x] `kernel/src/server`：内核 HTTP 服务（127.0.0.1 随机端口 + 令牌，对照 dsh-host-webserver）
- [x] `kernel/src/mcp`：stdio MCP 客户端 + 自研 memory 服务器 + `mcp__<server>__<tool>` 挂载
- [x] `kernel/src/server/approvals`：审批中枢（超时 fail-closed 自动拒绝）
- [x] 审批留痕：approval_request / approval_decision 事件写入会话 JSONL（audit_receipt 落库挪到 M3）
- ~~验收：浏览器完成「记忆保存 → 审批卡 → 允许 → 写文件」全链路~~
  ✔ 已验收：10/10 单元测试通过；浏览器实测 MCP 记忆 + 审批卡放行写文件

## M3 —— 插件装配 + 工作流 ✅ 2026-11-04 完成
- [x] `kernel/src/plugins`：cordis 式装载器（manifest + overlay patch 注入 config/disable，坏插件只隔离自身）
- [x] `plugins/example-echo`：patch 注入 prefix 后 echo 工具行为改变（验证装配链路）
- [x] `workflow/src`：进程内 DAG 引擎（并行就绪步、失败级联跳过、`${stepId}` 插值、
      每运行独立目录 events.ndjson + result.json、CLI stdin JSON → stdout 纯事件 NDJSON）
- [x] provider 增强：maxTokens 透传 + reasoning_content 兜底 + 空输出 fail-fast
- ~~验收：manifest+patch 装配生效，两步 DAG 事件流正确~~
  ✔ 已验收：17/17 测试通过；真实 llama.cpp 两步 DAG（成语→造句）跑通，exit=0

## M3.5 —— 待办（从 M2/M3 冒烟里记下的）
- [ ] SQLite 投影（node:sqlite）承接会话/审计回执查询（现 JSONL 全量读）
- [ ] 工作流步骤带工具调用（依赖 M5 沙箱）与 YAML 版 overlay.patch

## M4 —— 桌面壳 ✅ 2026-11-04 完成
- [x] `kernel/src/ipc/main.ts`：内核侧车（stdio JSON-RPC：握手/状态/会话/回合/审批，
      事件主动通知壳，带令牌 webUrl 经 initialize 上报一次）
- [x] `apps/desktop/shell.ts`：Node 壳（凭据现取注入 + 侧车监督 + 崩溃自动重启 ×3）
- [x] `apps/desktop/vault.cjs`：凭据库（Windows DPAPI CurrentUser 加密落盘，密钥零明文；
      env 仅首次导入，此后壳现取、IPC 注入内核内存）
- [x] `apps/desktop/updater.ts`：更新双校验（Ed25519 manifest 签名 → 逐文件 sha256+size，
      清单篡改/文件篡改/缺文件/错公钥全部拦截）
- [x] `apps/desktop/electron/`：真实 Electron 主进程 + contextBridge 白名单 preload
      （ELECTRON_RUN_AS_NODE 拉侧车；`npm i electron` 后 `npm run desktop` 即为完整桌面版）
- ~~验收：壳拉起侧车完成握手，凭据链路走通~~
  ✔ 已验收：25/25 测试通过；壳实测「凭据导入 → DPAPI 密文 → 侧车握手 → 令牌 URL」

## M5 —— 沙箱与远端 ✅ 2026-11-04 完成
- [x] `kernel/src/sandbox`：写前镜像（preimages.jsonl 日志）+ 守卫名单 fail-closed
      （data/vault、.git、node_modules、*.local.json 拒写）+ 单文件上限 + 会话级回滚
      （每路径以首次写前状态为准：恢复原内容 / 删除新建文件）
- [x] 写操作接入沙箱：server / 侧车 / 工作流步骤三种宿主每会话挂 SandboxSession；
      回滚口：POST /api/sandbox/rollback、IPC sandbox.rollback、workflow --rollback
- [x] `workflow/src/docker-executor.ts`：digest 钉死（--pull=never）+ 只读根 fs + 默认断网
      + 命令构造器单测；无守护进程时 fail-closed（本机未装 Docker，实测走 fail-closed 分支）
- [x] `workflow/src/tool-runner.ts`：步骤 = 带工具 agent loop（store 可选，无痕执行）
- [x] `deploy/`：发布清单（递归 sha256）→ 事务式切换（previous 锚点 + mv -T 原子 rename）
      → 健康检查失败自动回滚；`--plan` dry-run 实测，实际执行需可 SSH 的远端
- ~~验收：沙箱镜像可回滚，Docker/SSH 两条路径 fail-closed 且计划可测~~
  ✔ 已验收：38/38 测试通过；实测「模型写文件 → 沙箱镜像 → --rollback 整体回滚删除」全链路

---

## M7 —— 工具扩充与自动模型（2026-11-11）✅
- [x] 新工具 ×3：`run_command`（PowerShell 受控执行：审批门+超时+输出截断+工作区 cwd）、
      `web_fetch`（SSRF 守卫 fail-closed + HTML 转文本 + 256KB 上限）、`todo_write/todo_read`（会话级任务计划）
- [x] Auto-model：主预设重试耗尽后按 catalog 自动换模型（流式仅在首 token 前降级）；层叠保留
- [x] 会话自动标题：首轮完成后 LLM 生成（垃圾输出 → 用户消息前 12 字确定性兜底）
- [x] UI：会话计划卡联动 todo（「1 进行中 · 2 待处理」）、工具行动词映射（执行命令/抓取网页/更新计划）
- ✔ 已验收：todo 三步计划全 completed、Get-Date 执行（审批链）、example.com 抓取、自动标题；
  全套走流式端点完成；38/38 测试全绿

## M8 —— 基础设施补全 ✅ 2026-11-12 完成
- [x] 上下文压缩 compaction（阈值 40 条 → 截到 user 边界 LLM 摘要 → 'compaction' 事件落盘，回放重建一致）
- [x] 审批记忆（审批卡勾选「本会话总是允许」→ 会话内该工具直接放行）
- [x] 编辑 diff 视图（LCS 行级差异：工具行 +N −R + 展开彩色 diff 块）
- [x] SQLite 投影（node:sqlite 懒加载：data/sessions.db，存量回填 + /api/search 全文检索，
      侧栏搜索联动「正文命中」分组；无 --experimental-sqlite 时优雅降级）
- [x] 上下文页（对照智作「上下文」Tab）：统计卡 ×6（轮步/计费/工具/活跃时长/模型/压缩）+
      Token 组成环 + 耗时环 + 当前上下文组成条（系统/用户/回复/工具结果 估算）+
      上下文趋势柱图（压缩虚线标记）+ 上下文浏览器；流式回合带 usage（stream_options include_usage）
- [x] MCP Streamable HTTP 传输（McpHttpClient：JSON/SSE 双兼容 + Mcp-Session-Id 维持；
      policy/mcp-servers.json 支持 url 声明；stub 单测验证 initialize→listTools→callTool→会话头）
- [x] 附件/图片输入（＋按钮 → 文本内联 / 图片 POST /api/upload 存工作区 attachments/ +
      OpenAI 多模态分片透传；视觉能力取决于端点，auto-model 已实测自动降级链路）
- [x] **多模态端点接入**（2026-11-12）：本机部署 SmolVLM2-500M + mmproj（hf-mirror 下载 520MB）→
      第二 llama 实例 8082 → provider 视觉路由（带图请求自动走视觉预设，无 fallback 混跑；
      修复 switchPreset f=0 不生效的路由 bug）→ 设置页「视觉端点」配置卡 + kernel-settings.json 持久层；
      实测：红底黄圆 / 蓝底橙圆 图片经客户端流式识图（85 delta）
- 差距清单 12/12 项全部落地或入档（自定义协议加载按 webUrl 方案维持，不再单列）

## M9 —— 界面对齐深化 ✅ 2026-11-13
- [x] 自绘一体化标题栏（无边框：品牌+版本+窗口键+拖动/缩放/双击最大化）
- [x] 消息编辑重发（✎ → 截断历史 → 干净重渲染 → 重发）
- [x] 体验四件套：拖拽上传 / Ctrl+V 粘贴图片 / 会话置顶 / 消息复制（✎/⧉）
- [x] 办公套件页（对照智作）：页头（←/创建专家/导入专家）+ 四 Tab：
      专家（agents.json + 自定义 localStorage + 已安装/公开 + 召唤闭环）、
      技能（内核工具注册表实况）、连接器（MCP/插件）、知识库（notes 笔记）
- [x] 轨迹页还原（统计条 + 过滤 + 三车道时间线甘特 + 轮次分组步骤行）
- [x] 上下文页还原（统计卡 ×6 + Token 组成环 + 耗时环 + 组成条 + 趋势柱图 + 浏览器）

---

## M6 —— 交互与流式（UI v3）✅ 2026-11-11 完成
- [x] 布局对齐智作：近黑主题 + 暗色标题栏（DWM）+ 行式侧栏菜单（线性 SVG 图标）+ 真彩色 exe 图标
- [x] 侧栏完整功能：搜索（🔍 展开）+ 可折叠项目分组（计数/展开其余 N 个/右键归组·重命名·删除）+ 账号菜单
- [x] 功能页：项目/产品管理（分组 CRUD + 会话删除）、办公套件（notes/ 笔记编辑器，沙箱守卫 API）、
      云智能体（policy/agents.json 卡片 → 一键建会话注入开场）
- [x] 对话流（v3）：左对齐活动流、ℋ 思考折叠行、工具行（动词+目标+字节+耗时）、
      回合摘要行「用时 X · N 个工具 · M 失败 ▸」折叠过程、GFM 表格渲染、
      用户消息右对齐 + 时间戳 + 复制、loading 持续到首个真实内容、主题色切换（CSS 变量 + color-mix）
- [x] **流式输出**：provider.chatStream（SSE 解析 + tool_call 增量累积）→ runTurnStream →
      `/api/sessions/:id/turns/stream` SSE（delta/过程/done/error）→ UI 打字机 + 流式光标；
      中断：POST /:id/abort 显式中止（keep-alive 下 socket 断开不可靠）+ 部分内容落盘 + 中断 note
- [x] 设置页：模型端点/模型名在线热切换（catalog→env→kernel-settings.json 层叠）、
      无人值守开关、API Key 零落盘、Ctrl+, 快捷键；反馈落盘 data/feedback.jsonl
- ✔ 已验收：SSE 帧序列（user@0ms → delta 逐 token → done）、300 行长流与中断落盘、
  重命名、主题色全局跟随；38/38 测试全绿

---

## 总览：M1–M6 全部完成 ✅（2026-11-11）
零 npm 依赖、Node 22 原生跑 TS + C# 原生客户端（系统 csc 编译，WebView2 内嵌）；
CLI / Web / 桌面客户端 / 工作流 / 部署五条入口共用一个内核。
