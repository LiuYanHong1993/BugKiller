// 模型预设目录：对照智作平台的 model-provider-catalog.v1.json
// 关键原则：目录里只存 apiKeyEnv（环境变量名），真实密钥运行时读取，绝不落盘。

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface PresetDecl {
  protocol: string;
  baseUrl: string;
  model: string;
  apiKeyEnv?: string;
  usagePolicy?: { unattendedAutomation?: string; note?: string };
  [key: string]: unknown;
}

export interface Catalog {
  schemaVersion: number;
  defaultPreset: string;
  presets: Record<string, PresetDecl>;
}

export interface ModelPreset {
  id: string;
  protocol: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  usagePolicy?: { unattendedAutomation?: string; note?: string };
}

export function loadCatalog(policyDir: string, env: NodeJS.ProcessEnv = process.env): Catalog {
  const file = join(policyDir, 'model-provider-catalog.json');
  if (!existsSync(file)) {
    return { schemaVersion: 1, defaultPreset: 'local-llamacpp', presets: {} };
  }
  void env;
  return JSON.parse(readFileSync(file, 'utf8')) as Catalog;
}

export function resolvePreset(catalog: Catalog, env: NodeJS.ProcessEnv = process.env): ModelPreset {
  const id = env.MYAGENT_PRESET || catalog.defaultPreset;
  const raw = catalog.presets[id];
  if (!raw) {
    throw new Error(`模型预设 "${id}" 不存在（policy/model-provider-catalog.json）`);
  }
  if (raw.protocol !== 'openai-chat') {
    throw new Error(`暂不支持协议 "${raw.protocol}"（M1 仅 openai-chat）`);
  }
  const envName = raw.apiKeyEnv || 'MYAGENT_API_KEY';
  return {
    id,
    protocol: raw.protocol,
    baseUrl: env.MYAGENT_BASE_URL || raw.baseUrl,
    model: env.MYAGENT_MODEL || raw.model,
    apiKey: env[envName] || '',
    usagePolicy: raw.usagePolicy,
  };
}
