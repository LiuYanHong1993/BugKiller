// 工作区路径约束：任何文件工具的路径都必须落在工作区内（对应 内核 的思路）

import { resolve } from 'node:path';

const sep = '\\';

export function resolveInWorkspace(workspaceRoot: string, relPath: string): string {
  const root = resolve(workspaceRoot);
  const abs = resolve(root, relPath);
  if (abs !== root && !abs.startsWith(root + sep) && !abs.startsWith(root + '/')) {
    throw new Error(`路径越界：${relPath} 不在工作区内（${root}）`);
  }
  return abs;
}
