// 沙箱会话（M5）：写前镜像（preimage）+ 守卫 + 会话级回滚
// 对照智作 write-guard：守卫名单 fail-closed；对照沙箱设计：写前留 preimage 才有回滚资本

import { randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile, appendFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { SandboxPolicy } from './policy.ts';
import { globToRegExp } from './policy.ts';

export interface SandboxWriteResult {
  bytes: number;
  guarded: boolean;
}

interface Preimage {
  seq: number;
  rel: string;
  existed: boolean;
  sha256: string | null;
  contentB64: string | null;
}

export class SandboxError extends Error {}

export class SandboxSession {
  readonly id: string;
  private root: string;
  private policy: SandboxPolicy;
  private log: (line: string) => void;
  private journalFile: string;
  private preimages = new Map<string, Preimage>();
  private seq = 0;
  private denyRules: RegExp[];

  constructor(opts: { workspaceRoot: string; journalDir: string; policy: SandboxPolicy; log: (line: string) => void }) {
    this.root = resolve(opts.workspaceRoot);
    this.policy = opts.policy;
    this.log = opts.log;
    this.id = `${stamp()}-${randomBytes(2).toString('hex')}`;
    this.journalFile = join(opts.journalDir, this.id, 'preimages.jsonl');
    this.denyRules = opts.policy.denyPaths.map(globToRegExp);
  }

  /** 回滚基准：每个路径以其在本会话中的首次写前状态为准 */
  async writeFile(absPath: string, content: string): Promise<SandboxWriteResult> {
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > this.policy.maxFileBytes) {
      throw new SandboxError(`超出沙箱单文件上限：${bytes} > ${this.policy.maxFileBytes} 字节`);
    }
    const rel = this.toRel(absPath);
    this.assertAllowed(rel);

    if (!this.preimages.has(rel)) {
      let existed = false;
      let prev: Buffer | null = null;
      try {
        prev = await readFile(absPath);
        existed = true;
      } catch {
        existed = false;
      }
      this.seq += 1;
      const entry: Preimage = {
        seq: this.seq,
        rel,
        existed,
        sha256: existed ? createHash('sha256').update(prev!).digest('hex') : null,
        contentB64: existed ? prev!.toString('base64') : null,
      };
      this.preimages.set(rel, entry);
      await mkdir(dirname(this.journalFile), { recursive: true });
      await appendFile(this.journalFile, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', 'utf8');
    }

    await mkdir(dirname(absPath), { recursive: true });
    await writeFile(absPath, content, 'utf8');
    this.log(`[sandbox] 写入 ${rel}（${bytes} 字节，已留写前镜像）`);
    return { bytes, guarded: true };
  }

  /** 会话级回滚：按 preimage 恢复每条路径的最初状态（不存在则删除） */
  async rollback(): Promise<string[]> {
    const restored: string[] = [];
    for (const [rel, pre] of this.preimages) {
      const abs = resolve(this.root, rel);
      if (pre.existed && pre.contentB64) {
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, Buffer.from(pre.contentB64, 'base64'));
        restored.push(`${rel}（恢复原内容）`);
      } else {
        await rm(abs, { force: true });
        restored.push(`${rel}（删除新建文件）`);
      }
    }
    this.log(`[sandbox] 回滚完成：${restored.length} 条路径`);
    return restored;
  }

  journalPath(): string {
    return this.journalFile;
  }

  private toRel(absPath: string): string {
    const abs = resolve(absPath);
    const rel = relative(this.root, abs);
    if (!rel || rel.startsWith('..') || resolve(this.root, rel) !== abs || rel.includes('..')) {
      throw new SandboxError(`路径越界（沙箱拒绝）：${absPath}`);
    }
    return rel.split(sep).join('/');
  }

  private assertAllowed(rel: string): void {
    for (const rule of this.denyRules) {
      if (rule.test(rel)) {
        throw new SandboxError(`守卫名单拒绝写入：${rel}（匹配 ${rule.source}）`);
      }
    }
  }
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 独立守卫（办公套件等 API 场景）：解析工作区相对路径并校验越界 + 守卫名单，返回绝对路径 */
export function assertGuardedPath(
  policy: SandboxPolicy,
  workspaceRoot: string,
  relPath: string,
): { abs: string; rel: string } {
  const root = resolve(workspaceRoot);
  const norm = String(relPath ?? '').trim().split('\\').join('/').replace(/^\/+/, '');
  if (!norm) throw new SandboxError('缺少路径');
  const abs = resolve(root, norm);
  const rel = relative(root, abs).split(sep).join('/');
  if (!rel || rel.startsWith('..') || rel.includes('..')) {
    throw new SandboxError(`路径越界（沙箱拒绝）：${relPath}`);
  }
  for (const rule of policy.denyPaths.map(globToRegExp)) {
    if (rule.test(rel)) throw new SandboxError(`守卫名单拒绝访问：${rel}`);
  }
  return { abs, rel };
}

/** 独立大小校验（与 SandboxSession 同一上限语义） */
export function assertSizeOk(policy: SandboxPolicy, content: string): number {
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > policy.maxFileBytes) {
    throw new SandboxError(`超出沙箱单文件上限：${bytes} > ${policy.maxFileBytes} 字节`);
  }
  return bytes;
}
