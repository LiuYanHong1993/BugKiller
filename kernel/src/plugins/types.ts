// 插件契约（cordis 式最小子集）：manifest + setup(ctx) + 工具贡献
// 对照智作平台：@cordis/plugin-core（apply/ctx.on/dispose）的能力裁剪版

import type { ToolDef } from '../tools/types.ts';

export interface PluginHost {
  pluginName: string;
  /** 由 overlay.patch.json 的 config 段注入 */
  config: Record<string, unknown>;
  registerTool: (def: ToolDef) => void;
  log: (line: string) => void;
}

export interface PluginModule {
  name?: string;
  version?: string;
  description?: string;
  setup: (ctx: PluginHost) => void | Promise<void>;
  teardown?: () => void | Promise<void>;
}

export interface PluginLoadReport {
  name: string;
  status: 'loaded' | 'disabled' | 'failed';
  error?: string;
  tools?: string[];
}

export interface PluginDecl {
  name?: string;
  entry: string;
  enabled?: boolean;
}

export interface PluginManifest {
  schemaVersion?: number;
  plugins?: PluginDecl[];
}

/** 对照智作 profile/overlay.patch.yml；零依赖阶段用 JSON 等价表达（语义一致） */
export interface OverlayPatch {
  disable?: string[];
  config?: Record<string, Record<string, unknown>>;
}
