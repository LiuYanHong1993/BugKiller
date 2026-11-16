# workflow —— 工作流运行时

工作流引擎（JSON 定义 + 拓扑执行）。

## 模拟实现路径

1. **M3-a 进程内 DAG**：JSON 定义节点/依赖，topo 执行，NDJSON 事件输出（stdout 流式）。
2. **M3-b Docker 隔离**：把工作流跑进容器（read_only + cap_drop ALL + 回环绑定），镜像 digest pin、`pull_policy=never`。
3. **M3-c 远端部署**：SSH 到固定 Linux 主机 `/opt/myagent/workflow/<id>/`，事务式更新 + 失败自动回滚。

## 协议约定

- 输入：stdin 一行 JSON envelope `{action, input, images, runtimePack}`
- 输出：stdout NDJSON 事件流（schemaVersion 1）
- 动作集：`doctor / prepare / preflight / start / stop / restart / status / delete`
