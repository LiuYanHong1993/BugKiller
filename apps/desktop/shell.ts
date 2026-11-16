// 桌面壳（Node 壳模式，M4）：
//  1) 凭据从 DPAPI 凭据库现取（env 仅首次导入），经 IPC 注入内核——零落盘
//  2) 拉起内核侧车（stdio JSON-RPC），拿到带令牌 Web UI 地址
//  3) 侧车崩溃自动重启（最多 3 次）；Ctrl+C 优雅退出
// Electron 版本见 electron/main.cjs：架构一致，多窗口管理

import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { env, exit, stdout } from 'node:process';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const sidecarEntry = resolve(repoRoot, 'kernel', 'src', 'ipc', 'main.ts');
const vaultCli = resolve(here, 'vault.cjs');

interface RpcMsg {
  jsonrpc?: string;
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
}

interface PendingEntry {
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

const log = (l: string) => stdout.write(`${l}\n`);

function vaultGet(name: string): string | null {
  const r = spawnSync(process.execPath, [vaultCli, 'get', name], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const out = r.status === 0 ? String(r.stdout ?? '').trim() : '';
  return out || null;
}

function vaultSet(name: string, secret: string): boolean {
  const r = spawnSync(process.execPath, [vaultCli, 'set', name], {
    input: secret,
    encoding: 'utf8',
    windowsHide: true,
  });
  return r.status === 0;
}

class Sidecar {
  private child: ChildProcess | null = null;
  private pending = new Map<number, PendingEntry>();
  private nextId = 1;
  onExit: (code: number | null) => void = () => {};
  onEvent: (params: Record<string, unknown>) => void = () => {};
  onLog: (line: string) => void = () => {};

  start(): void {
    this.child = spawn(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', sidecarEntry],
      { cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    this.child.stdout!.setEncoding('utf8');
    this.child.stderr!.setEncoding('utf8');
    this.child.stderr!.on('data', (c: string) => {
      const t = c.trim();
      if (t) this.onLog(`[sidecar:stderr] ${t.slice(0, 200)}`);
    });
    this.child.on('exit', (code) => {
      for (const [, p] of this.pending) p.reject(new Error('侧车进程已退出'));
      this.pending.clear();
      this.child = null;
      this.onExit(code);
    });
    const rl = createInterface({ input: this.child.stdout! });
    rl.on('line', (line) => this.onLine(line));
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let msg: RpcMsg;
    try {
      msg = JSON.parse(line) as RpcMsg;
    } catch {
      return;
    }
    if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? '侧车返回错误'));
      else p.resolve(msg.result ?? {});
      return;
    }
    if (msg.method === 'event') this.onEvent((msg.params ?? {}) as Record<string, unknown>);
    else if (msg.method === 'log') {
      this.onLog(String((msg.params as { line?: string } | undefined)?.line ?? ''));
    } else if (msg.method === 'fatal') {
      this.onLog(`[sidecar:fatal] ${String((msg.params as { message?: string } | undefined)?.message ?? '')}`);
    }
  }

  request(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = 60_000,
  ): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolveP, rejectP) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectP(new Error(`侧车请求超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveP, reject: rejectP, timer });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  private write(msg: RpcMsg): void {
    if (!this.child?.stdin?.writable) throw new Error('侧车未运行');
    this.child.stdin.write(JSON.stringify(msg) + '\n');
  }

  kill(): void {
    try {
      this.child?.kill();
    } catch {
      /* 忽略 */
    }
  }
}

const MAX_RESTARTS = 3;

async function main(): Promise<void> {
  log('agent-platform 桌面壳（M4 · Node 壳模式）');

  // 凭据：env 仅作首次导入；此后壳从 DPAPI 凭据库现取、经 IPC 注入内核（零落盘）
  if (env.MYAGENT_API_KEY) {
    if (vaultSet('model-api-key', env.MYAGENT_API_KEY)) {
      log('[凭据] 已从环境变量导入 model-api-key → DPAPI 凭据库（此后可移除该环境变量）');
      env.MYAGENT_API_KEY = undefined;
    } else {
      log('[凭据] 环境变量导入失败（继续无凭据启动）');
    }
  }
  const storedKey = vaultGet('model-api-key');
  log(
    `[凭据] model-api-key：${storedKey ? '已在凭据库（DPAPI 保护，经 IPC 注入内核）' : '未配置（本地端点可无凭据运行）'}`,
  );

  let restarts = 0;
  for (;;) {
    const sidecar = new Sidecar();
    const exitPromise = new Promise<number | null>((resolveP) => {
      sidecar.onExit = (code) => resolveP(code);
    });
    sidecar.onLog = (l) => log(`  ${l}`);
    sidecar.onEvent = (p) => {
      const ev = p.event as { type?: string; sessionId?: string } | undefined;
      if (ev?.type === 'approval_request') {
        log(`  [事件] 审批请求（会话 ${ev.sessionId}）——在 Web UI 审批卡上处理`);
      }
    };
    sidecar.start();

    try {
      const init = (await sidecar.request('initialize', { apiKey: storedKey ?? undefined })) as {
        webUrl?: string;
        state?: Record<string, unknown>;
      };
      const s = init.state ?? {};
      log('[侧车] 握手完成');
      log(`  模型 ${String(s.model)} @ ${String(s.baseUrl)} ｜ 权限 ${String(s.mode)}${s.autoApprove ? '（无人值守）' : ''}`);
      log(`  插件 ${String(s.plugins)} ｜ MCP ${String(s.mcp)}`);
      log(`  工具 ${(s.tools as string[])?.join(', ')}`);
      log('');
      log(`Web UI（带令牌，仅打印一次）：${init.webUrl}`);
      if (process.argv.slice(2).includes('--open')) openBrowser(String(init.webUrl));
      log('Ctrl+C 停止');
    } catch (err) {
      log(`[侧车] 握手失败：${(err as Error).message}`);
      sidecar.kill();
      exit(1);
    }

    const code = await exitPromise;
    if (stopping) exit(0);
    restarts++;
    if (restarts > MAX_RESTARTS) {
      log(`[侧车] 连续退出 ${MAX_RESTARTS} 次（code=${code}），壳退出`);
      exit(1);
    }
    log(`[侧车] 进程退出（code=${code}），${restarts}/${MAX_RESTARTS} 次自动重启…`);
    await new Promise((r) => setTimeout(r, 1000 * restarts));
  }
}

let stopping = false;
process.on('SIGINT', () => {
  stopping = true;
  exit(0);
});

function openBrowser(url: string): void {
  if (process.platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
}

main().catch((e) => {
  log(`[fatal] ${e instanceof Error ? e.message : String(e)}`);
  exit(1);
});
