// 插件装载器：manifest + overlay patch 装配（对照智作 profile/overlay.patch.yml 装配树）
// 原则：单个插件失败只影响自身，绝不拖垮内核

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ToolRegistry } from '../tools/registry.ts';
import type { ToolContext } from '../tools/types.ts';
import type { OverlayPatch, PluginHost, PluginLoadReport, PluginManifest, PluginModule } from './types.ts';

export interface LoadPluginsOptions {
  workspaceRoot: string;
  registry: ToolRegistry;
  ctx: ToolContext;
}

export async function loadPlugins(opts: LoadPluginsOptions): Promise<PluginLoadReport[]> {
  const { workspaceRoot, registry, ctx } = opts;
  const manifestFile = resolve(workspaceRoot, 'plugins', 'plugins.json');
  if (!existsSync(manifestFile)) return [];

  let manifest: PluginManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as PluginManifest;
  } catch (err) {
    const msg = (err as Error).message;
    ctx.log(`[plugins] 清单解析失败：${msg}`);
    return [{ name: '(manifest)', status: 'failed', error: msg }];
  }

  const patch = readPatch(resolve(workspaceRoot, 'plugins', 'overlay.patch.json'), ctx.log);
  const disabled = new Set(patch.disable ?? []);

  const reports: PluginLoadReport[] = [];
  for (const decl of manifest.plugins ?? []) {
    const name = decl.name ?? decl.entry;
    if (decl.enabled === false || disabled.has(name)) {
      reports.push({ name, status: 'disabled' });
      continue;
    }
    try {
      const entryPath = resolve(workspaceRoot, 'plugins', decl.entry);
      const mod = (await import(pathToFileURL(entryPath).href)) as {
        default?: PluginModule;
      } & Partial<PluginModule>;
      const plugin: PluginModule = mod.default ?? (mod as PluginModule);
      if (!plugin || typeof plugin.setup !== 'function') {
        throw new Error('插件缺少 setup(ctx)');
      }
      const pluginName = plugin.name ?? name;
      const registered: string[] = [];
      const host: PluginHost = {
        pluginName,
        config: patch.config?.[pluginName] ?? {},
        registerTool: (def) => {
          registry.register(def);
          registered.push(def.name);
        },
        log: ctx.log,
      };
      await plugin.setup(host);
      reports.push({ name: pluginName, status: 'loaded', tools: registered });
      ctx.log(
        `[plugins] 已装载 ${pluginName}${registered.length > 0 ? `（工具：${registered.join(', ')}）` : ''}`,
      );
    } catch (err) {
      const msg = (err as Error).message;
      reports.push({ name, status: 'failed', error: msg });
      ctx.log(`[plugins] ${name} 装载失败：${msg}`);
    }
  }
  return reports;
}

function readPatch(file: string, log: (line: string) => void): OverlayPatch {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as OverlayPatch;
  } catch (err) {
    log(`[plugins] overlay.patch.json 解析失败（忽略 patch）：${(err as Error).message}`);
    return {};
  }
}
