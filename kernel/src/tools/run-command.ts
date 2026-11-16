// run_command 工具：受控命令执行
// 安全模型：必须过审批门 + 固定超时 + 输出截断 + 工作区内 cwd

import { spawn } from 'node:child_process';
import type { ToolDef } from './types.ts';
import { resolveInWorkspace } from './paths.ts';

const MAX_OUTPUT = 8 * 1024;
const DEFAULT_TIMEOUT = 120_000;

export const runCommandTool: ToolDef = {
  name: 'run_command',
  description:
    '在工作区内执行一条 PowerShell 命令并返回输出（受控：需要用户审批、固定超时、输出截断）。用于构建、测试、查询系统状态等。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['command'],
    properties: {
      command: { type: 'string', description: 'PowerShell 命令（不要用交互式/长驻命令）' },
      cwd: { type: 'string', description: '可选：工作区内的相对子目录' },
      timeoutMs: { type: 'number', description: '可选：超时毫秒（默认 120000，上限 300000）' },
    },
  },
  requiredApproval: (args) => {
    const cmd = String(args.command ?? '');
    return {
      tool: 'run_command',
      action: '执行命令',
      detail: `${cmd.slice(0, 160)}`,
    };
  },
  async execute(args, ctx) {
    const command = String(args.command ?? '').trim();
    if (!command) return { ok: false, output: '缺少 command 参数' };
    const timeoutMs = Math.min(Math.max(Number(args.timeoutMs ?? DEFAULT_TIMEOUT) || DEFAULT_TIMEOUT, 1_000), 300_000);

    let cwd = ctx.workspaceRoot;
    const relCwd = String(args.cwd ?? '').trim();
    if (relCwd) {
      try {
        cwd = resolveInWorkspace(ctx.workspaceRoot, relCwd);
      } catch (err) {
        return { ok: false, output: (err as Error).message };
      }
    }

    const result = await new Promise<{ ok: boolean; output: string }>((resolveP) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
        cwd,
        windowsHide: true,
      });
      let out = '';
      let killed = false;
      const timer = setTimeout(() => {
        killed = true;
        child.kill('kill');
      }, timeoutMs);
      const cap = (s: string): void => {
        if (out.length < MAX_OUTPUT) out += s;
      };
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', cap);
      child.stderr.on('data', cap);
      child.on('error', (e) => {
        clearTimeout(timer);
        resolveP({ ok: false, output: `命令启动失败：${e.message}` });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const trimmed = out.length >= MAX_OUTPUT ? out.slice(0, MAX_OUTPUT) + '…(已截断)' : out;
        const tail = killed
          ? `\n[超时 ${timeoutMs}ms，已终止]`
          : `\n[退出码 ${code ?? '?'}]`;
        resolveP({ ok: !killed && code === 0, output: (trimmed || '(无输出)') + tail });
      });
    });

    ctx.log(`[run_command] ${command.slice(0, 80)} → ${result.ok ? '完成' : '失败'}`);
    return result;
  },
};
