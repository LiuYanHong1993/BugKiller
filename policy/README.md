# policy —— 策略与安全

策略 + 审计/审批体系。

## 要实现的文件

| 文件 | 作用 |
|---|---|
| `model-provider-catalog.json` | 模型提供商预设：协议、端点、usagePolicy（unattendedAutomation: allowed/review-required/forbidden） |
| `default-model-access.json` | 默认模型接入（凭据只存占位符，真实值由壳层注入——**不要重蹈业界明文内置 key 的覆辙**） |
| `permissions.json` | 工具权限模式：read-only / workspace-write / full + 审批白名单 |
| `audit.md`（说明） | 审批回执（tier + approval_reference）、安全日志、写前镜像三件留痕的设计 |

## 安全红线（自查清单）

- [ ] 凭据零落盘：内核内存态，经 IPC 现取；日志 redactSecrets
- [ ] 安装资产逐文件 sha256 清单
- [ ] 容器/沙箱：read_only、cap_drop ALL、no-new-privileges、默认回环绑定
- [ ] 遥测默认全关，崩溃仅本地
- [ ] IM/远程通道 fail-closed + 防重放
