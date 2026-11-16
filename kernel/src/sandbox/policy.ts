// 沙箱策略（M5）：fail-closed —— 策略缺失/损坏时拒绝一切写操作

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface SandboxPolicy {
  schemaVersion: number;
  /** 单文件写入上限（字节） */
  maxFileBytes: number;
  /** 禁写路径（工作区相对 glob-lite：** 任意层，* 单层） */
  denyPaths: string[];
}

export const DEFAULT_DENY: string[] = ['data/vault/**', '.git/**', 'node_modules/**', 'policy/*.local.json'];

export function loadSandboxPolicy(policyDir: string): SandboxPolicy {
  const file = resolve(policyDir, 'sandbox.json');
  if (!existsSync(file)) {
    return { schemaVersion: 1, maxFileBytes: 10_485_760, denyPaths: DEFAULT_DENY };
  }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<SandboxPolicy>;
    return {
      schemaVersion: raw.schemaVersion ?? 1,
      maxFileBytes: typeof raw.maxFileBytes === 'number' && raw.maxFileBytes > 0 ? raw.maxFileBytes : 10_485_760,
      denyPaths: Array.isArray(raw.denyPaths) ? raw.denyPaths.map(String) : DEFAULT_DENY,
    };
  } catch {
    // fail-closed：策略损坏 → 最严策略
    return { schemaVersion: 1, maxFileBytes: 0, denyPaths: ['**'] };
  }
}

/** glob-lite → RegExp：** 跨层，* 单层（不跨 /） */
export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const rx = escaped.replace(/\*\*/g, '\u0000').replace(/\*/g, '[^\\\\/]*').replace(/\u0000/g, '.*');
  return new RegExp(`^${rx}$`, 'i');
}
