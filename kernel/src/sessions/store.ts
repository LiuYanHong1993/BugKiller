// 会话存档：JSONL 追加写（一行一事件），支持列表与回放
// 对照智作平台：dsh-session-persistence-jsonl（事实层），SQLite 投影留到 M2

import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export type SessionEventType =
  | 'session_start'
  | 'user'
  | 'assistant'
  | 'tool_call'
  | 'tool_result'
  | 'approval_request'
  | 'approval_decision'
  | 'compaction'
  | 'note';

export interface SessionEvent {
  seq: number;
  ts: string;
  type: SessionEventType;
  [key: string]: unknown;
}

export interface SessionSummary {
  id: string;
  file: string;
  title: string;
  mtimeMs: number;
  events: number;
  archived: boolean;
}

const SCHEMA = 'myagent.session/v1';

export class SessionStore {
  private dir: string;
  private counters = new Map<string, number>();

  constructor(dir: string) {
    this.dir = dir;
  }

  get sessionsDir(): string {
    return this.dir;
  }

  async create(title: string): Promise<string> {
    await mkdir(this.dir, { recursive: true });
    const id = newId();
    const start: SessionEvent = { seq: 1, ts: now(), type: 'session_start', title, schema: SCHEMA };
    this.counters.set(id, 1);
    await appendFile(this.fileOf(id), JSON.stringify(start) + '\n', 'utf8');
    return id;
  }

  async append(
    sessionId: string,
    type: SessionEventType,
    data: Record<string, unknown> = {},
  ): Promise<SessionEvent> {
    const known = this.counters.get(sessionId) ?? (await this.countExisting(sessionId));
    const seq = known + 1;
    this.counters.set(sessionId, seq);
    const ev: SessionEvent = { seq, ts: now(), type, ...data };
    await appendFile(this.fileOf(sessionId), JSON.stringify(ev) + '\n', 'utf8');
    return ev;
  }

  async list(): Promise<SessionSummary[]> {
    await mkdir(this.dir, { recursive: true });
    const files = (await readdir(this.dir)).filter((f) => f.endsWith('.jsonl')).sort();
    const out: SessionSummary[] = [];
    for (const f of files) {
      const full = join(this.dir, f);
      const st = await stat(full);
      const text = await readFile(full, 'utf8');
      const lines = text.split('\n').filter((l) => l.trim().length > 0);
      let title = '';
      let archived = false;
      if (lines.length > 0) {
        try {
          const first = JSON.parse(lines[0] as string) as { title?: unknown; archived?: unknown };
          title = String(first.title ?? '');
          archived = first.archived === true;
        } catch {
          title = '(损坏的首行)';
        }
      }
      out.push({ id: f.replace(/\.jsonl$/, ''), file: full, title, mtimeMs: st.mtimeMs, events: lines.length, archived });
    }
    return out.reverse();
  }

  async read(sessionId: string): Promise<SessionEvent[]> {
    let text: string;
    try {
      text = await readFile(this.fileOf(sessionId), 'utf8');
    } catch {
      throw new Error(`会话不存在：${sessionId}`);
    }
    return text
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as SessionEvent);
  }

  /** 删除会话存档（UI 与 API 的删除入口）；不存在时静默成功 */
  async delete(sessionId: string): Promise<void> {
    if (!/^[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$/.test(sessionId)) {
      throw new Error(`非法会话 ID：${sessionId}`);
    }
    this.counters.delete(sessionId);
    await rm(this.fileOf(sessionId), { force: true });
  }

  /** 重命名（改写首行 session_start 的 title） */
  async rename(sessionId: string, title: string): Promise<void> {
    const events = await this.read(sessionId);
    if (events.length === 0) throw new Error(`会话不存在：${sessionId}`);
    events[0] = { ...events[0]!, title: title.slice(0, 60) };
    await writeFile(this.fileOf(sessionId), events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  }

  /** 截断重发：丢弃 seq >= beforeSeq 的全部事件，返回保留条数（编辑消息后重发用） */
  async truncateTo(sessionId: string, beforeSeq: number): Promise<number> {
    if (!Number.isFinite(beforeSeq) || beforeSeq < 2) {
      throw new Error('beforeSeq 需 ≥ 2（不能截掉会话起点）');
    }
    const events = await this.read(sessionId);
    const kept = events.filter((e) => e.seq < beforeSeq);
    if (kept.length === 0) throw new Error('截断后无内容');
    await writeFile(this.fileOf(sessionId), kept.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    this.counters.set(sessionId, kept.length);
    return kept.length;
  }

  /** 分叉会话：复制全部事件到新会话（标题加「（分叉）」），返回新 id（对照智作分叉会话） */
  async fork(sessionId: string): Promise<string> {
    const events = await this.read(sessionId);
    if (events.length === 0) throw new Error(`会话不存在：${sessionId}`);
    const forkId = newId();
    const first = events[0]!;
    const title = `${String(first.title ?? '会话').slice(0, 40)}（分叉）`;
    const copied = events.map((e, i) => {
      const c: SessionEvent = { ...e, seq: i + 1 };
      if (i === 0) {
        c.type = 'session_start';
        c.title = title;
        c.archived = false;
        delete (c as Record<string, unknown>).partial;
      }
      return c;
    });
    await appendFile(this.fileOf(forkId), copied.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    this.counters.set(forkId, copied.length);
    return forkId;
  }

  /** 归档标志（改写首行）；归档的会话默认不在列表显示 */
  async setArchived(sessionId: string, archived: boolean): Promise<void> {
    const events = await this.read(sessionId);
    if (events.length === 0) throw new Error(`会话不存在：${sessionId}`);
    events[0] = { ...events[0]!, archived };
    await writeFile(this.fileOf(sessionId), events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  }

  private fileOf(id: string): string {
    return join(this.dir, `${id}.jsonl`);
  }

  private async countExisting(sessionId: string): Promise<number> {
    const events = await this.read(sessionId).catch(() => [] as SessionEvent[]);
    return events.length;
  }
}

function now(): string {
  return new Date().toISOString();
}

function newId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${stamp}-${randomBytes(3).toString('hex')}`;
}
