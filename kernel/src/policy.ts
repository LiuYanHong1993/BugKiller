// 权限策略（permissions.json）：CLI 与服务端共用

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface PolicyConfig {
  schemaVersion: number;
  mode: 'read-only' | 'workspace-write';
  autoApprove: boolean;
}

export function loadPolicy(policyDir: string, env: NodeJS.ProcessEnv = process.env): PolicyConfig {
  const file = resolve(policyDir, 'permissions.json');
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as PolicyConfig;
      if (env.MYAGENT_AUTO_APPROVE === '1') parsed.autoApprove = true;
      return parsed;
    } catch {
      // 策略文件损坏时退回默认
    }
  }
  return { schemaVersion: 1, mode: 'workspace-write', autoApprove: env.MYAGENT_AUTO_APPROVE === '1' };
}
