// 示例插件：注册 echo 工具，验证「manifest + patch 装配」链路
// config.prefix 由 plugins/overlay.patch.json 注入，证明 patch 能改变插件行为

import type { PluginModule } from '../../kernel/src/plugins/types.ts';

const plugin: PluginModule = {
  name: 'example-echo',
  version: '0.1.0',
  description: '示例插件：提供 echo 工具，原样回显文本',
  setup(ctx) {
    const prefix = typeof ctx.config.prefix === 'string' ? ctx.config.prefix : '';
    ctx.registerTool({
      name: 'echo',
      description: '原样回显输入文本（由 example-echo 插件提供）',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: { text: { type: 'string', description: '要回显的文本' } },
      },
      requiredApproval: () => null,
      async execute(args) {
        return { ok: true, output: `${prefix}${String(args.text ?? '')}` };
      },
    });
  },
};

export default plugin;
