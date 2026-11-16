// web_fetch 工具：抓取网页并转为纯文本
// 安全：仅 http/https；私有/回环地址 fail-closed（SSRF 防护）；大小上限

import type { ToolDef } from './types.ts';

const MAX_BYTES = 256 * 1024;
const TIMEOUT = 20_000;

/** SSRF 守卫：拒绝回环/内网/本地域名 */
function assertPublicHost(hostname: string): void {
  const h = hostname.toLowerCase();
  if (
    h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.localhost') || h.endsWith('.local') ||
    h.startsWith('127.') || h.startsWith('10.') || h.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h.startsWith('169.254.') || h === '0.0.0.0'
  ) {
    throw new Error(`拒绝访问内网/回环地址：${hostname}（SSRF 防护）`);
  }
}

/** HTML → 纯文本（粗转换，够 agent 阅读用） */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|table|section|article)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '· ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const webFetchTool: ToolDef = {
  name: 'web_fetch',
  description: '抓取一个 http(s) 网页并返回其文本内容（HTML 自动转纯文本，上限 256KB）。用于查资料、读文档。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['url'],
    properties: {
      url: { type: 'string', description: '完整的 http(s) 地址' },
    },
  },
  requiredApproval: () => null, // 只读出网；内网地址已 fail-closed
  async execute(args) {
    const url = String(args.url ?? '').trim();
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return { ok: false, output: `无效 URL：${url}` };
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return { ok: false, output: `仅支持 http/https：${u.protocol}` };
    }
    try {
      assertPublicHost(u.hostname);
    } catch (e) {
      return { ok: false, output: (e as Error).message };
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT);
    try {
      const res = await fetch(url, {
        signal: ac.signal,
        headers: { 'user-agent': 'agent-platform/0.1 (+local agent)' },
        redirect: 'follow',
      });
      if (!res.ok) {
        return { ok: false, output: `HTTP ${res.status} ${res.statusText}` };
      }
      const ctype = res.headers.get('content-type') ?? '';
      const raw = await res.text();
      const capped = raw.length > MAX_BYTES ? raw.slice(0, MAX_BYTES) + '…(已截断)' : raw;
      const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(capped)?.[1]?.trim();
      const body = ctype.includes('html') ? htmlToText(capped) : capped;
      const head = title ? `标题：${title}\n\n` : '';
      return { ok: true, output: `${head}${body || '(空内容)'}\n\n[来源 ${url} · ${capped.length} 字符]` };
    } catch (err) {
      const msg = (err as Error).name === 'AbortError' ? `超时（${TIMEOUT}ms）` : (err as Error).message;
      return { ok: false, output: `抓取失败：${msg}` };
    } finally {
      clearTimeout(timer);
    }
  },
};
