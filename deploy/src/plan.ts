// 远端部署计划（M5，纯函数，可单测）
// 对照智作 autonomous-linux 的事务式更新：release 目录 + 原子符号链接切换 + 一键回滚
// 本地打包 → scp 上传 → 远端 ln 切换 → 健康检查 → 失败自动回滚

import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

export interface ReleaseFile {
  rel: string; // POSIX 相对路径
  sha256: string;
  size: number;
}

export interface ReleaseManifest {
  version: string; // UTC 时间戳版本，如 20261104-120000
  createdAt: string;
  files: ReleaseFile[];
}

/** 递归收集目录 → 发布清单（每个文件 sha256 + size） */
export async function buildReleaseManifest(dir: string, opts?: { version?: string }): Promise<ReleaseManifest> {
  const root = resolve(dir);
  const files: ReleaseFile[] = [];
  await walk(root, root, files);
  files.sort((a, b) => (a.rel < b.rel ? -1 : 1));
  return {
    version: opts?.version ?? stampUtc(),
    createdAt: new Date().toISOString(),
    files,
  };
}

/** 事务式切换：current 指针原子指向新 release（previous 保留用于回滚） */
export function buildSwitchCommands(opts: {
  releasesDir: string;
  currentLink: string;
  previousLink: string;
  version: string;
}): string[] {
  const rel = `${opts.releasesDir}/${opts.version}`;
  return [
    // 1) 记录当前指针（回滚锚点）
    `if [ -L ${q(opts.currentLink)} ]; then ln -sfn "$(readlink ${q(opts.currentLink)})" ${q(opts.previousLink)}; fi`,
    // 2) 原子切换：先建临时链接再 mv -T（单次 rename，绝不出现半切换窗口）
    `ln -sfn ${q(rel)} ${q(`${opts.currentLink}.new`)}`,
    `mv -T ${q(`${opts.currentLink}.new`)} ${q(opts.currentLink)}`,
    // 3) 记录版本戳
    `echo ${q(opts.version)} > ${q(`${opts.releasesDir}/.last-switched`)}`,
  ];
}

export function buildRollbackCommands(opts: {
  releasesDir: string;
  currentLink: string;
  previousLink: string;
}): string[] {
  return [
    `prev="$(readlink ${q(opts.previousLink)})"; [ -n "$prev" ] || exit 1`,
    `ln -sfn "$prev" ${q(`${opts.currentLink}.new`)}`,
    `mv -T ${q(`${opts.currentLink}.new`)} ${q(opts.currentLink)}`,
  ];
}

/** 部署健康检查命令（远端执行，非 0 即失败） */
export function buildHealthCheckCommand(healthUrl: string): string {
  return `curl -fsS -m 10 ${q(healthUrl)} > /dev/null`;
}

async function walk(root: string, cur: string, out: ReleaseFile[]): Promise<void> {
  for (const name of await readdir(cur)) {
    const full = join(cur, name);
    const s = await stat(full);
    if (s.isDirectory()) {
      await walk(root, full, out);
    } else {
      const buf = await readFile(full);
      out.push({
        rel: relative(root, full).split('\\').join('/'),
        sha256: createHash('sha256').update(buf).digest('hex'),
        size: buf.length,
      });
    }
  }
}

function q(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

function stampUtc(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}
