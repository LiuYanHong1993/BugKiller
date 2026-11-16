// OpenAI 兼容 provider：非流式 chat + 指数退避重试（429/5xx/网络错误）

import { LlmError } from './types.ts';
import type { ChatRequest, ChatResponse } from './types.ts';
import type { ModelPreset } from './catalog.ts';

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
}

const DEFAULT_RETRY: RetryOptions = { maxAttempts: 3, baseDelayMs: 500 };

export class OpenAiCompatibleProvider {
  private preset: ModelPreset;
  private retry: RetryOptions;
  private fallbacks: ModelPreset[];

  constructor(preset: ModelPreset, retry: RetryOptions = DEFAULT_RETRY, fallbacks: ModelPreset[] = []) {
    this.preset = preset;
    this.retry = retry;
    this.fallbacks = fallbacks;
  }

  /** 壳层经 IPC 注入运行时配置（凭据零落盘：只进内存，不写文件、不打印） */
  updateConfig(patch: { apiKey?: string; baseUrl?: string; model?: string }): void {
    this.preset = { ...this.preset };
    if (typeof patch.apiKey === 'string') this.preset.apiKey = patch.apiKey;
    if (typeof patch.baseUrl === 'string' && patch.baseUrl) this.preset.baseUrl = patch.baseUrl;
    if (typeof patch.model === 'string' && patch.model) this.preset.model = patch.model;
  }

  getConfig(): Readonly<ModelPreset> {
    return this.preset;
  }

  private switchPreset(p: ModelPreset): void {
    this.preset = { ...p };
  }

  private vision: ModelPreset | null = null;

  /** 配置视觉（多模态）预设；带图请求自动路由到它 */
  setVision(p: ModelPreset | null): void {
    this.vision = p;
  }

  private static hasImagePart(messages: ChatRequest['messages']): boolean {
    return messages.some(
      (m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'),
    );
  }

  /** chat：重试耗尽后按 fallback 链自动换模型（仅可重试型失败；4xx 参数错误换了也没用）。
   *  带图请求：配置了视觉预设时整链切换到视觉端点（不给文本端点添乱）。 */
  async chat(req: {
    messages: ChatRequest['messages'];
    tools?: ChatRequest['tools'];
    temperature?: number;
    model?: string;
    maxTokens?: number;
  }): Promise<ChatResponse> {
    const useVision = OpenAiCompatibleProvider.hasImagePart(req.messages) && this.vision;
    const candidates = useVision ? [this.vision!] : [this.preset, ...this.fallbacks];
    const original = this.preset;
    let lastErr: unknown = null;
    for (let f = 0; f < candidates.length; f++) {
      // 每轮都切换（f=0 也要切：useVision 时 candidates[0] 是视觉预设）
      this.switchPreset(candidates[f]!);
      try {
        return await this.chatWithRetry(req);
      } catch (err) {
        lastErr = err;
        const retryable = err instanceof LlmError ? err.retryable === true : true;
        if (!retryable) {
          this.switchPreset(original); // 参数型失败：回主预设
          throw err;
        }
      }
    }
    this.switchPreset(original); // 全部失败：恢复主预设（避免残留 openai 等不可用端点）
    throw lastErr;
  }

  private async chatWithRetry(req: {
    messages: ChatRequest['messages'];
    tools?: ChatRequest['tools'];
    temperature?: number;
    model?: string;
    maxTokens?: number;
  }): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: req.model ?? this.preset.model,
      messages: req.messages,
      temperature: req.temperature ?? 0.4,
    };
    if (req.tools && req.tools.length > 0) body.tools = req.tools;
    if (typeof req.maxTokens === 'number' && req.maxTokens > 0) body.max_tokens = req.maxTokens;

    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= this.retry.maxAttempts; attempt++) {
      try {
        return await this.attemptOnce(body);
      } catch (err) {
        lastErr = err;
        const retryable = err instanceof LlmError ? err.retryable === true : true;
        if (!retryable || attempt === this.retry.maxAttempts) break;
        await sleep(this.retry.baseDelayMs * 2 ** (attempt - 1));
      }
    }
    throw lastErr;
  }

  private async attemptOnce(body: Record<string, unknown>): Promise<ChatResponse> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.preset.apiKey) headers.authorization = `Bearer ${this.preset.apiKey}`;

    let res: Response;
    try {
      res = await fetch(`${this.preset.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (err) {
      // 透出 undici cause（code/原因），否则只有顶层 "fetch failed" 没法定位
      const c = (err as { cause?: unknown }).cause as { code?: string; message?: string } | undefined;
      const detail = c ? `（${c.code ?? ''} ${c.message ?? ''}）` : '';
      throw new LlmError(`网络错误：${(err as Error).message}${detail}`, undefined, true);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new LlmError(
        `模型服务返回 ${res.status}：${text.slice(0, 300)}`,
        res.status,
        res.status === 429 || res.status >= 500,
      );
    }

    const data = (await res.json()) as ChatResponse;
    const msg = data.choices?.[0]?.message;
    if (msg && typeof msg.content === 'string') msg.content = stripThinking(msg.content);
    // 兜底：有的推理端点把 reasoning 单独放 reasoning_content、content 给 null
    if (msg && (msg.content === null || msg.content === '') && typeof (msg as { reasoning_content?: unknown }).reasoning_content === 'string') {
      msg.content = stripThinking((msg as { reasoning_content: string }).reasoning_content);
    }
    return data;
  }

  /**
   * 流式 chat：仅在首 token 之前失败才尝试 fallback（已有输出则不换，调用方已渲染）。
   */
  async chatStream(
    req: {
      messages: ChatRequest['messages'];
      tools?: ChatRequest['tools'];
      temperature?: number;
      model?: string;
      maxTokens?: number;
    },
    opts: { signal?: AbortSignal; onDelta: (text: string) => void },
  ): Promise<ChatResponse> {
    let deltaFired = false;
    const onDelta = (t: string): void => {
      deltaFired = true;
      opts.onDelta(t);
    };
    const useVision = OpenAiCompatibleProvider.hasImagePart(req.messages) && this.vision;
    const candidates = useVision ? [this.vision!] : [this.preset, ...this.fallbacks];
    const original = this.preset;
    let lastErr: unknown = null;
    for (let f = 0; f < candidates.length; f++) {
      // 每轮都切换（f=0 也要切：useVision 时 candidates[0] 是视觉预设）
      this.switchPreset(candidates[f]!);
      try {
        return await this.chatStreamOnce(req, { signal: opts.signal, onDelta });
      } catch (err) {
        if (deltaFired) throw err;
        lastErr = err;
        const retryable = err instanceof LlmError ? err.retryable === true : true;
        if (!retryable) {
          this.switchPreset(original);
          throw err;
        }
      }
    }
    this.switchPreset(original); // 全部失败：恢复主预设
    throw lastErr;
  }

  /**
   * 流式 chat（SSE）单次尝试：逐 token 回调 onDelta；工具调用增量按 index 累积。
   * 返回与 chat 同构的 ChatResponse（供 loop 复用同一套工具分支）。
   */
  private async chatStreamOnce(
    req: {
      messages: ChatRequest['messages'];
      tools?: ChatRequest['tools'];
      temperature?: number;
      model?: string;
      maxTokens?: number;
    },
    opts: { signal?: AbortSignal; onDelta: (text: string) => void },
  ): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: req.model ?? this.preset.model,
      messages: req.messages,
      temperature: req.temperature ?? 0.4,
      stream: true,
      stream_options: { include_usage: true }, // 末帧带回 usage（计费统计用）
    };
    if (req.tools && req.tools.length > 0) body.tools = req.tools;
    if (typeof req.maxTokens === 'number' && req.maxTokens > 0) body.max_tokens = req.maxTokens;

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.preset.apiKey) headers.authorization = `Bearer ${this.preset.apiKey}`;

    let res: Response;
    try {
      res = await fetch(`${this.preset.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: opts.signal,
      });
    } catch (err) {
      const c = (err as { cause?: unknown }).cause as { code?: string; message?: string } | undefined;
      const detail = c ? `（${c.code ?? ''} ${c.message ?? ''}）` : '';
      throw new LlmError(`网络错误：${(err as Error).message}${detail}`, undefined, true);
    }
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new LlmError(
        `模型服务返回 ${res.status}：${text.slice(0, 300)}`,
        res.status,
        res.status === 429 || res.status >= 500,
      );
    }

    const contentParts: string[] = [];
    const toolAcc = new Map<number, { id: string; name: string; args: string }>();
    let finish = '';
    let usage: ChatResponse['usage'] = null;

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const j = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string | null; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string | null }>;
            usage?: ChatResponse['usage'];
          };
          const d = j.choices?.[0]?.delta;
          if (d && typeof d.content === 'string' && d.content) {
            contentParts.push(d.content);
            opts.onDelta(d.content);
          }
          for (const tc of d?.tool_calls ?? []) {
            const i = Number(tc.index ?? 0);
            const acc = toolAcc.get(i) ?? { id: tc.id ?? `call_${i}`, name: '', args: '' };
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name = tc.function.name; // 名称一次性到达
            if (tc.function?.arguments) acc.args += tc.function.arguments;
            toolAcc.set(i, acc);
          }
          if (j.choices?.[0]?.finish_reason) finish = String(j.choices[0]!.finish_reason);
          if (j.usage) usage = j.usage;
        } catch {
          /* 忽略无法解析的行 */
        }
      }
    }

    const calls = [...toolAcc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => ({ id: v.id, type: 'function' as const, function: { name: v.name, arguments: v.args || '{}' } }));
    let text = contentParts.join('');
    if (calls.length === 0) text = stripThinking(text);
    const message: ChatResponse['choices'][number]['message'] = { role: 'assistant', content: text };
    if (calls.length > 0) message.tool_calls = calls;
    return {
      id: '',
      model: this.preset.model,
      choices: [{ index: 0, finish_reason: finish || (calls.length > 0 ? 'tool_calls' : 'stop'), message }],
      usage: usage ?? null,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 剥离推理型模型混在正文里的 <think> 段落 */
function stripThinking(text: string): string {
  if (!text) return text;
  const close = text.lastIndexOf('</think>');
  if (close >= 0) {
    const after = text.slice(close + '</think>'.length).trim();
    // 剥离后为空说明最终回答也在 thinking 里：退回原文，避免调用方拿到空输出
    return after || text.trim();
  }
  if (text.trimStart().startsWith('</think>')) {
    const after = text.trimStart().slice('</think>'.length).trim();
    return after || text.trim();
  }
  return text;
}
