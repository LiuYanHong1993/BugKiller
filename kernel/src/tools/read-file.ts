// read_file 工具：只读、限工作区内、行号分页

import { readFile, stat } from 'node:fs/promises';
import type { ToolDef } from './types.ts';
import { resolveInWorkspace } from './paths.ts';

const MAX_BYTES = 256 * 1024;

export const readFileTool: ToolDef = {
  name: 'read_file',
  description: '读取工作区内的一个 UTF-8 文本文件（相对路径）。默认最多返回前 400 行，可用 offset/limit 翻页。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['path'],
    properties: {
      path: { type: 'string', description: '工作区相对路径' },
      offset: { type: 'number', description: '起始行（从 1 开始），默认 1' },
      limit: { type: 'number', description: '行数上限，默认 400' },
    },
  },
  requiredApproval: () => null,
  async execute(args, ctx) {
    const rel = String(args.path ?? '');
    if (!rel) return { ok: false, output: '缺少 path 参数' };

    let abs: string;
    try {
      abs = resolveInWorkspace(ctx.workspaceRoot, rel);
    } catch (err) {
      return { ok: false, output: (err as Error).message };
    }

    let st;
    try {
      st = await stat(abs);
    } catch {
      return { ok: false, output: `文件不存在：${rel}` };
    }
    if (st.isDirectory()) return { ok: false, output: `目标是目录不是文件：${rel}` };
    if (st.size > MAX_BYTES) {
      return { ok: false, output: `文件过大（${st.size} 字节 > ${MAX_BYTES}），M1 不支持读取` };
    }

    const text = await readFile(abs, 'utf8');
    const offset = Math.max(1, Number(args.offset ?? 1) || 1);
    const limit = Math.min(2000, Math.max(1, Number(args.limit ?? 400) || 400));
    const lines = text.split(/\r?\n/);
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const header = `# ${rel}（共 ${lines.length} 行，显示 ${offset}-${offset - 1 + slice.length} 行）`;
    const numbered = slice.map((line, i) => `${String(offset + i).padStart(4)} | ${line}`);
    return { ok: true, output: [header, ...numbered].join('\n') };
  },
};
