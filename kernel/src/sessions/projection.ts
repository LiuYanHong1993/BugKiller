// SQLite 投影（M8）：会话/消息的可检索投影（对照智作 dsh-session-persistence 的 SQLite 层）
// node:sqlite 懒加载：无 --experimental-sqlite 标志时优雅降级（available=false）

import { join } from 'node:path';
import type { SessionEvent } from './store.ts';

export interface SearchHit {
  sessionId: string;
  title: string;
  seq: number;
  type: string;
  snippet: string;
}

export class SessionProjection {
  private dbFile: string;
  private db: any = null;
  available = false;

  constructor(dbFile: string) {
    this.dbFile = dbFile;
  }

  async init(): Promise<void> {
    try {
      const mod: any = await import('node:sqlite');
      const DatabaseSync = mod.DatabaseSync;
      if (!DatabaseSync) return;
      this.db = new DatabaseSync(this.dbFile);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL DEFAULT '',
          updated_ts TEXT NOT NULL DEFAULT '',
          msg_count INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS messages (
          session_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          ts TEXT NOT NULL,
          type TEXT NOT NULL,
          text TEXT NOT NULL DEFAULT '',
          PRIMARY KEY (session_id, seq)
        );
        CREATE INDEX IF NOT EXISTS idx_messages_text ON messages(text);
      `);
      this.available = true;
    } catch {
      this.available = false; // node:sqlite 不可用 → 优雅降级
    }
  }

  async indexEvent(sessionId: string, ev: SessionEvent): Promise<void> {
    if (!this.available || !this.db) return;
    try {
      const text = String(ev.text ?? ev.summary ?? '');
      if (ev.type === 'session_start') {
        this.db.prepare(
          `INSERT INTO sessions (id, title, updated_ts, msg_count) VALUES (?, ?, ?, 1)
           ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_ts = excluded.updated_ts`,
        ).run(sessionId, String(ev.title ?? ''), String(ev.ts ?? ''));
        return;
      }
      this.db.prepare(
        `INSERT OR REPLACE INTO messages (session_id, seq, ts, type, text) VALUES (?, ?, ?, ?, ?)`,
      ).run(sessionId, Number(ev.seq ?? 0), String(ev.ts ?? ''), String(ev.type), text);
      this.db.prepare(`UPDATE sessions SET updated_ts = ?, msg_count = msg_count + 1 WHERE id = ?`)
        .run(String(ev.ts ?? ''), sessionId);
    } catch {
      /* 投影失败不影响主流程 */
    }
  }

  async updateTitle(sessionId: string, title: string): Promise<void> {
    if (!this.available || !this.db) return;
    try {
      this.db.prepare(`UPDATE sessions SET title = ? WHERE id = ?`).run(title, sessionId);
    } catch {
      /* ignore */
    }
  }

  /** 全文检索（LIKE 实现，够用；FTS5 留升级） */
  async search(q: string, limit = 12): Promise<SearchHit[]> {
    if (!this.available || !this.db) return [];
    const kw = String(q ?? '').trim();
    if (!kw) return [];
    try {
      const rows = this.db.prepare(
        `SELECT m.session_id AS sessionId, m.seq, m.type, m.text, COALESCE(s.title, '') AS title
         FROM messages m LEFT JOIN sessions s ON s.id = m.session_id
         WHERE m.text LIKE ? LIMIT ?`,
      ).all(`%${kw}%`, Number(limit));
      return rows.map((r: any) => ({
        sessionId: String(r.sessionId),
        title: String(r.title ?? ''),
        seq: Number(r.seq),
        type: String(r.type),
        snippet: String(r.text ?? '').slice(0, 80),
      }));
    } catch {
      return [];
    }
  }

  file(): string {
    return this.dbFile ? join(this.dbFile) : '';
  }
}
