// SSH 执行桥（M5）：依赖系统 OpenSSH 客户端（Windows 10+ / Linux 自带）
// 设计：每个命令独立一次 ssh 调用，失败即中止（事务性由 plan.ts 的命令序列保证）

import { spawnSync } from 'node:child_process';

export interface SshTarget {
  host: string;
  user: string;
  port?: number;
}

export interface SshResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function baseArgs(target: SshTarget): string[] {
  const port = target.port ?? 22;
  return ['-p', String(port), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', `${target.user}@${target.host}`];
}

export function sshRun(target: SshTarget, command: string): SshResult {
  const r = spawnSync('ssh', [...baseArgs(target), command], { encoding: 'utf8', windowsHide: true });
  if (r.error) return { ok: false, stdout: '', stderr: `ssh 不可用：${r.error.message}` };
  return { ok: r.status === 0, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') };
}

export function sshUploadDir(target: SshTarget, localDir: string, remoteDir: string): SshResult {
  const r = spawnSync('scp', ['-P', String(target.port ?? 22), '-o', 'BatchMode=yes', '-r', localDir, `${target.user}@${target.host}:${remoteDir}`], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (r.error) return { ok: false, stdout: '', stderr: `scp 不可用：${r.error.message}` };
  return { ok: r.status === 0, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') };
}
