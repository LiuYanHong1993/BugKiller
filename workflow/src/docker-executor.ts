// Docker 隔离执行器（M5）：digest 钉死 + 只读根文件系统 + 默认断网
// 对照智作 stratex-langgraph：digest-pinned、pull_policy=never、read_only 容器
// 本模块负责命令构造（可单测）；实际执行需要 Docker 守护进程（缺失时 fail-closed 报错）

import { spawnSync } from 'node:child_process';

export interface DockerMount {
  host: string;
  container: string;
  readOnly?: boolean;
}

export interface DockerRunSpec {
  image: string;
  /** 形如 sha256:abcd...；钉死后 --pull never，杜绝镜像漂移 */
  digest?: string;
  workdir?: string;
  mounts?: DockerMount[];
  env?: Record<string, string>;
  /** 默认 none（断网）；工作流步骤不需要网络时必须 none */
  network?: 'none' | 'bridge';
  /** false → --read-only（推荐） */
  writableRootFs?: boolean;
  cmd: string[];
}

export function imageRef(name: string, digest?: string): string {
  return digest ? `${name}@${digest.startsWith('sha256:') ? digest : `sha256:${digest}`}` : name;
}

export function buildDockerRunArgs(spec: DockerRunSpec): string[] {
  const args = ['run', '--rm'];
  args.push(spec.digest ? '--pull=never' : '--pull=missing');
  if (spec.writableRootFs !== true) args.push('--read-only');
  args.push('--network', spec.network ?? 'none');
  if (spec.workdir) args.push('--workdir', spec.workdir);
  for (const m of spec.mounts ?? []) {
    args.push('--volume', `${m.host}:${m.container}${m.readOnly === false ? '' : ':ro'}`);
  }
  for (const [k, v] of Object.entries(spec.env ?? {})) {
    args.push('--env', `${k}=${v}`);
  }
  args.push(imageRef(spec.image, spec.digest), ...spec.cmd);
  return args;
}

export interface DockerRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export function runDocker(spec: DockerRunSpec, cwd?: string): DockerRunResult {
  const args = buildDockerRunArgs(spec);
  let r: ReturnType<typeof spawnSync>;
  try {
    r = spawnSync('docker', args, { cwd, encoding: 'utf8', timeout: 600_000, windowsHide: true });
  } catch {
    return { ok: false, stdout: '', stderr: 'Docker 不可用（fail-closed）', exitCode: null };
  }
  if (r.error) {
    return { ok: false, stdout: '', stderr: `Docker 不可用（fail-closed）：${r.error.message}`, exitCode: null };
  }
  return {
    ok: r.status === 0,
    stdout: String(r.stdout ?? ''),
    stderr: String(r.stderr ?? ''),
    exitCode: r.status,
  };
}
