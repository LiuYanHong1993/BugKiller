// 从会话 JSONL 回放消息历史（CLI /open 与服务端共用）

import type { ChatMessage } from '../llm/types.ts';
import type { SessionStore } from './store.ts';

export async function replayHistory(store: SessionStore, sessionId: string): Promise<ChatMessage[]> {
  const events = await store.read(sessionId);
  const msgs: ChatMessage[] = [];
  for (const ev of events) {
    if (ev.type === 'compaction') {
      // 压缩点：丢弃此前累积，换成摘要（保持与压缩时的内存历史一致）
      msgs.length = 0;
      msgs.push({ role: 'user', content: String(ev.summary ?? '') });
    } else if (ev.type === 'user') {
      msgs.push({ role: 'user', content: String(ev.text ?? '') });
    } else if (ev.type === 'tool_call') {
      msgs.push({
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: String(ev.callId),
            type: 'function',
            function: { name: String(ev.name), arguments: String(ev.arguments ?? '{}') },
          },
        ],
      });
    } else if (ev.type === 'tool_result') {
      msgs.push({
        role: 'tool',
        tool_call_id: String(ev.callId),
        content: '（工具输出未存档，如需详情请重新调用工具）',
      });
    } else if (ev.type === 'assistant' && !ev.withToolCalls) {
      msgs.push({ role: 'assistant', content: String(ev.text ?? '') });
    }
  }
  return msgs;
}
