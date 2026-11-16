// agent loop：系统提示 + 工具调用循环（M1 非流式）
// 对照智作平台：dsh-agent-loop 的最小子集

import type { ChatMessage } from '../llm/types.ts';
import type { OpenAiCompatibleProvider } from '../llm/provider.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import type { ToolContext } from '../tools/types.ts';
import type { SessionStore } from '../sessions/store.ts';
import { buildSystemPrompt } from './system-prompt.ts';

export interface LoopDeps {
  provider: OpenAiCompatibleProvider;
  registry: ToolRegistry;
  /** 省略则不落会话库（工作流步骤、无痕执行场景） */
  store?: SessionStore;
  ctx: ToolContext;
  sessionId?: string;
  maxToolRounds?: number;
  /** 上下文压缩阈值（消息条数，默认 40；超过即摘要化早期历史） */
  maxHistoryMessages?: number;
}

export interface TurnResult {
  reply: string;
  rounds: number;
}

export async function runTurn(
  userText: string,
  history: ChatMessage[],
  deps: LoopDeps,
): Promise<TurnResult> {
  const { provider, registry, ctx } = deps;
  const store = deps.store;
  const sessionId = deps.sessionId ?? '';
  const record = (type: Parameters<SessionStore['append']>[1], data: Record<string, unknown>): Promise<unknown> =>
    store ? store.append(sessionId, type, data) : Promise.resolve(null);
  const maxRounds = deps.maxToolRounds ?? 16;

  await compactIfNeeded(history, deps);

  history.push({ role: 'user', content: userText });
  await record('user', { text: userText });

  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(ctx.workspaceRoot, registry.names()) },
    ...history,
  ];
  // 双写：messages 发给模型（含 system），history 是调用方持有的跨轮记忆
  const track = (m: ChatMessage): void => {
    messages.push(m);
    history.push(m);
  };

  let rounds = 0;
  for (;;) {
    rounds += 1;
    if (rounds > maxRounds) {
      const note = '（工具调用轮数达到上限，本轮停止。）';
      await record('note', { text: note });
      return { reply: note, rounds: maxRounds };
    }

    const res = await provider.chat({ messages, tools: registry.toSpecs() });
    const msg = res.choices[0]?.message;
    if (!msg) throw new Error('模型响应缺少 choices[0].message');

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      track({ role: 'assistant', content: msg.content ?? '', tool_calls: msg.tool_calls });
      if (msg.content) {
        await record('assistant', { text: msg.content, withToolCalls: true });
      }
      for (const call of msg.tool_calls) {
        await record('tool_call', {
          callId: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        });
        ctx.log(`→ ${call.function.name}(${summarizeArgs(call.function.arguments)})`);
        const result = await registry.invoke(call.function.name, call.function.arguments, ctx);
        ctx.log(`← ${result.ok ? '完成' : '失败'}`);
        await record('tool_result', {
          callId: call.id,
          name: call.function.name,
          ok: result.ok,
          preview: result.output.slice(0, 200),
          data: result.data ?? null,
        });
        track({ role: 'tool', tool_call_id: call.id, content: result.output });
      }
      continue;
    }

    const reply = msg.content ?? '';
    track({ role: 'assistant', content: reply });
    await record('assistant', { text: reply, usage: res.usage ?? null, rounds });
    return { reply, rounds };
  }
}

export type StreamEmit = (event: string, data: Record<string, unknown>) => void;

const COMPACT_KEEP = 12; // 压缩后保留的最近消息数

/** 消息内容 → 纯文本（多模态分片取文本段） */
function contentToText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p.type === 'text' ? p.text : '[图片]'))
      .join('\n');
  }
  return '';
}

/**
 * 上下文压缩（对照智作 compaction）：历史超阈值时，
 * 把较早的一段（截到最近的 user 边界，保证 tool 配对完整）LLM 摘要化并落盘 'compaction' 事件。
 */
async function compactIfNeeded(
  history: ChatMessage[],
  deps: {
    provider: OpenAiCompatibleProvider;
    store?: SessionStore;
    sessionId?: string;
    ctx: ToolContext;
    signal?: AbortSignal;
    maxHistoryMessages?: number;
  },
  emit?: StreamEmit,
): Promise<void> {
  const threshold = deps.maxHistoryMessages ?? 40;
  if (!deps.store || !deps.sessionId || history.length <= threshold) return;

  let cut = -1;
  for (let i = history.length - COMPACT_KEEP; i >= 0; i--) {
    if (history[i]!.role === 'user') {
      cut = i;
      break;
    }
  }
  if (cut < 8) return; // 太少不值得压缩

  const dropped = history.slice(0, cut);
  try {
    const res = await deps.provider.chat({
      messages: [
        {
          role: 'system',
          content:
            '把以下对话历史压缩成一份不超过 300 字的摘要，保留：用户目标、已做决定、关键结果、未完成事项。只输出摘要正文。',
        },
        {
          role: 'user',
          content: dropped
            .map((m) => `${m.role}: ${contentToText(m.content).slice(0, 300)}`)
            .join('\n')
            .slice(0, 6000),
        },
      ],
      temperature: 0.2,
      maxTokens: 500,
    });
    const summary = (res.choices[0]?.message?.content ?? '').trim();
    if (!summary) return;
    const text = `【早期对话摘要 · 已压缩 ${dropped.length} 条消息】\n${summary}`;
    const ev = await deps.store.append(deps.sessionId, 'compaction', { summary: text, covered: cut });
    if (ev && emit) emit('compaction', ev as unknown as Record<string, unknown>);
    history.splice(0, cut, { role: 'user', content: text });
    deps.ctx.log(`[compaction] 已压缩 ${cut} 条历史消息 → 摘要`);
  } catch {
    /* 压缩失败不阻塞回合（下次触发再试） */
  }
}

/**
 * 流式回合：与 runTurn 同一循环，但逐 token emit('delta')、存储事件实时 emit。
 * 用户中断（signal abort）时落盘部分内容并以 note 标记。
 */
export async function runTurnStream(
  userText: string,
  history: ChatMessage[],
  deps: LoopDeps & { signal?: AbortSignal; maxTokens?: number; parts?: ChatMessage['content']; attachments?: string[] },
  emit: StreamEmit,
): Promise<TurnResult> {
  const { provider, registry, ctx } = deps;
  const store = deps.store;
  const sessionId = deps.sessionId ?? '';
  const record = async (type: Parameters<SessionStore['append']>[1], data: Record<string, unknown>) => {
    if (!store) return null;
    return store.append(sessionId, type, data);
  };
  const maxRounds = deps.maxToolRounds ?? 16;

  await compactIfNeeded(history, deps);

  // 多模态：parts 存在（含图片）时整条消息用 content 分片；纯文本走 text
  history.push({ role: 'user', content: deps.parts && deps.parts.length > 0 ? deps.parts : userText });
  const userEv = await record('user', {
    text: userText,
    ...(deps.attachments && deps.attachments.length ? { attachments: deps.attachments } : {}),
  });
  if (userEv) emit('user', userEv as unknown as Record<string, unknown>);

  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(ctx.workspaceRoot, registry.names()) },
    ...history,
  ];
  const track = (m: ChatMessage): void => {
    messages.push(m);
    history.push(m);
  };

  let rounds = 0;
  for (;;) {
    rounds += 1;
    if (rounds > maxRounds) {
      const note = '（工具调用轮数达到上限，本轮停止。）';
      await record('note', { text: note });
      emit('note', { type: 'note', ts: new Date().toISOString(), text: note });
      return { reply: note, rounds: maxRounds };
    }

    let acc = '';
    let res;
    try {
      res = await provider.chatStream(
        { messages, tools: registry.toSpecs(), maxTokens: deps.maxTokens },
        {
          signal: deps.signal,
          onDelta: (t) => {
            acc += t;
            emit('delta', { text: t });
          },
        },
      );
    } catch (err) {
      const aborted = deps.signal?.aborted === true || (err as Error)?.name === 'AbortError';
      if (aborted) {
        if (acc) {
          const ev = await record('assistant', { text: acc, partial: true });
          if (ev) emit('assistant', ev as unknown as Record<string, unknown>);
          track({ role: 'assistant', content: acc });
        }
        const note = '（用户中断了本轮响应。）';
        try {
          await record('note', { text: note });
        } catch {
          /* 落盘失败不影响返回 */
        }
        emit('note', { type: 'note', ts: new Date().toISOString(), text: note });
        return { reply: acc, rounds };
      }
      throw err;
    }

    const msg = res.choices[0]?.message;
    if (!msg) throw new Error('模型响应缺少 choices[0].message');

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      track({ role: 'assistant', content: msg.content ?? '', tool_calls: msg.tool_calls });
      if (msg.content) {
        const ev = await record('assistant', { text: msg.content, withToolCalls: true });
        if (ev) emit('assistant', ev as unknown as Record<string, unknown>);
      }
      for (const call of msg.tool_calls) {
        const callEv = await record('tool_call', {
          callId: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        });
        if (callEv) emit('tool_call', callEv as unknown as Record<string, unknown>);
        ctx.log(`→ ${call.function.name}(${summarizeArgs(call.function.arguments)})`);
        const result = await registry.invoke(call.function.name, call.function.arguments, ctx);
        ctx.log(`← ${result.ok ? '完成' : '失败'}`);
        const resEv = await record('tool_result', {
          callId: call.id,
          name: call.function.name,
          ok: result.ok,
          preview: result.output.slice(0, 200),
          data: result.data ?? null,
        });
        if (resEv) emit('tool_result', resEv as unknown as Record<string, unknown>);
        track({ role: 'tool', tool_call_id: call.id, content: result.output });
      }
      continue;
    }

    const reply = msg.content ?? '';
    // abort 时 llama.cpp 会优雅结束流（不抛错）——正常返回路径也要检查中断标记
    const wasAborted = deps.signal?.aborted === true;
    track({ role: 'assistant', content: reply });
    const ev = await record('assistant', {
      text: reply,
      usage: res.usage ?? null,
      rounds,
      ...(wasAborted ? { partial: true } : {}),
    });
    if (ev) emit('assistant', ev as unknown as Record<string, unknown>);
    if (wasAborted) {
      const note = '（用户中断了本轮响应。）';
      try {
        await record('note', { text: note });
      } catch {
        /* 落盘失败不影响返回 */
      }
      emit('note', { type: 'note', ts: new Date().toISOString(), text: note });
    }
    return { reply, rounds };
  }
}

function summarizeArgs(argsJson: string): string {
  try {
    const a = JSON.parse(argsJson) as Record<string, unknown>;
    const keys = Object.keys(a);
    if (keys.length === 0) return '';
    return keys.map((k) => `${k}=${JSON.stringify(a[k]).slice(0, 60)}`).join(', ');
  } catch {
    return argsJson.slice(0, 80);
  }
}
