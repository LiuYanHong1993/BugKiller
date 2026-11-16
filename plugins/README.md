# plugins —— 插件

cordis 风格：每个插件是一个 npm 包，导出 `name` + `inject` 依赖，由一份 `overlay.patch.yml` 装配进内核。

## example-echo

最小示例插件：注册一个 `echo` 工具（输入什么回什么），演示三件事：
1. 工具 schema 声明（JSON Schema）
2. 装配清单写法（`patch.yml` 里 insert 一行）
3. 生命周期钩子（`ready` / `dispose`）

## 后续插件想法

- `memory`：stdio 拉起一个 MCP 记忆服务
- `im-bridge`：IM 消息进会话（企业微信/钉钉），带负责人私聊守卫（fail-closed）
- `desktop-pet`：后台助手形象（Live2D/帧动画）
