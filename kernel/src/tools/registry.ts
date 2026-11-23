// 工具注册表：schema 导出、审批门、统一错误兜底与输出截断

import type { ToolSpec } from '../llm/types.ts';
import type { ToolContext, ToolDef, ToolResult } from './types.ts';

const MAX_OUTPUT_CHARS = 20_000;

export class ToolRegistry {
  private defs = new Map<string, ToolDef>();

  register(def: ToolDef): void {
    if (this.defs.has(def.name)) throw new Error(`工具重复注册：${def.name}`);
    this.defs.set(def.name, def);
  }

  names(): string[] {
    return [...this.defs.keys()];
  }

  toSpecs(): ToolSpec[] {
    return [...this.defs.values()].map((d) => ({
      type: 'function',
      function: { name: d.name, description: d.description, parameters: d.parameters },
    }));
  }

  async invoke(name: string, argsJson: string, ctx: ToolContext): Promise<ToolResult> {
    const def = this.defs.get(name);
    if (!def) {
      return { ok: false, output: `未知工具：${name}（可用：${this.names().join(', ')}）` };
    }

    let args: Record<string, unknown>;
    try {
      args = JSON.parse(argsJson || '{}') as Record<string, unknown>;
    } catch {
      return { ok: false, output: `工具 ${name} 的参数不是合法 JSON：${argsJson.slice(0, 200)}` };
    }

    if (def.requiredApproval) {
      const req = def.requiredApproval(args, ctx);
      if (req) {
        let approved: boolean;
        try {
          approved = await ctx.approval(req);
        } catch (err) {
          return { ok: false, output: `审批通道异常：${(err as Error).message}` };
        }
        if (!approved) {
          if (ctx.readOnly) {
            return {
              ok: false,
              output: '当前权限为「仅可查看」，本次写入已被系统阻止。请提示用户：点击输入框上方的权限徽章，切换为「工作区权限」或「完全权限」后重试。',
            };
          }
          return {
            ok: false,
            output: `用户拒绝了本次操作（${req.action}：${req.detail}）。不要重复同一方案，请调整或询问用户。`,
          };
        }
      }
    }

    try {
      const r = await def.execute(args, ctx);
      return { ok: r.ok, output: cap(r.output) };
    } catch (err) {
      return { ok: false, output: `工具 ${name} 执行异常：${(err as Error).message}` };
    }
  }
}

function cap(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n…[输出超限截断，原始 ${text.length} 字符]`;
}
