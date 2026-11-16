// 工具协议：定义、上下文与审批门

import type { JsonSchema, ToolSpec } from '../llm/types.ts';

export interface ApprovalRequest {
  tool: string;
  action: string;
  detail: string;
}

export type ApprovalGate = (req: ApprovalRequest) => Promise<boolean>;

export interface ToolContext {
  /** 工具只能访问该目录内部（对应智作平台的 workspace 约束） */
  workspaceRoot: string;
  approval: ApprovalGate;
  log: (line: string) => void;
  /** 所属会话（todo 等会话级状态用）；无会话上下文时缺省 */
  sessionId?: string;
  /** 存在时写操作走沙箱（守卫 + 写前镜像，可回滚）；见 kernel/src/sandbox */
  sandbox?: {
    writeFile(absPath: string, content: string): Promise<{ bytes: number; guarded: boolean }>;
  };
}

export interface ToolResult {
  ok: boolean;
  output: string;
  /** 结构化附加数据（diff 等），随 tool_result 事件透传给 UI */
  data?: Record<string, unknown>;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: JsonSchema;
  /** 返回非 null 表示本次调用需要用户审批 */
  requiredApproval?: (args: Record<string, unknown>, ctx: ToolContext) => ApprovalRequest | null;
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

export function toToolSpec(def: ToolDef): ToolSpec {
  return {
    type: 'function',
    function: {
      name: def.name,
      description: def.description,
      parameters: def.parameters,
    },
  };
}
