// write_file 工具：写前必须过审批门（M1 的权限核心）
// M8：结果携带行级 diff（+N −R），UI 工具行直接展示改了哪几行

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ToolDef } from './types.ts';
import { resolveInWorkspace } from './paths.ts';
import { lineDiff } from './diff.ts';

export const writeFileTool: ToolDef = {
  name: 'write_file',
  description: '在工作区内创建或覆盖一个 UTF-8 文本文件（相对路径）。写入前需要用户审批。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['path', 'content'],
    properties: {
      path: { type: 'string', description: '工作区相对路径' },
      content: { type: 'string', description: '完整文件内容（覆盖语义）' },
    },
  },
  requiredApproval: (args, ctx) => {
    const rel = String(args.path ?? '(空路径)');
    const bytes = Buffer.byteLength(String(args.content ?? ''), 'utf8');
    return {
      tool: 'write_file',
      action: '写入文件',
      detail: `${rel}（${bytes} 字节，工作区 ${ctx.workspaceRoot}）`,
    };
  },
  async execute(args, ctx) {
    const rel = String(args.path ?? '');
    if (!rel) return { ok: false, output: '缺少 path 参数' };

    let abs: string;
    try {
      abs = resolveInWorkspace(ctx.workspaceRoot, rel);
    } catch (err) {
      return { ok: false, output: (err as Error).message };
    }

    const content = String(args.content ?? '');
    // 旧内容（diff 数据源；读失败 = 新建）
    let oldText: string | null = null;
    try {
      oldText = await readFile(abs, 'utf8');
    } catch {
      oldText = null;
    }

    // 挂了沙箱会话则走守卫 + 写前镜像（可回滚）
    if (ctx.sandbox) {
      await ctx.sandbox.writeFile(abs, content);
    } else {
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, 'utf8');
    }

    const bytes = Buffer.byteLength(content, 'utf8');
    const diff = lineDiff(oldText ?? '', content);
    const kind = oldText === null ? '新建' : '更新';
    const statText = oldText === null ? `+${diff.added} 行` : `+${diff.added} −${diff.removed}`;
    ctx.log(`已${kind} ${rel}（${bytes} 字节，${statText}）`);
    return {
      ok: true,
      output: `已${kind} ${rel}（${bytes} 字节，${statText}）`,
      data: { kind, diff },
    };
  },
};
