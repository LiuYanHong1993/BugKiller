// 审批中枢：写操作审批在事件流里以「审批卡」呈现，用户在 UI 上放行/拒绝
// 对照智作平台：approval-request 卡片 + audit-receipt 留痕

import { randomBytes } from 'node:crypto';
import type { ApprovalRequest } from '../tools/types.ts';

export interface PendingApproval {
  id: string;
  sessionId: string;
  tool: string;
  action: string;
  detail: string;
  createdAt: string;
}

interface Entry {
  req: ApprovalRequest;
  sessionId: string;
  resolve: (ok: boolean) => void;
  timer: NodeJS.Timeout;
}

export class ApprovalBroker {
  private pending = new Map<string, Entry>();
  private timeoutMs: number;

  constructor(timeoutMs = 300_000) {
    this.timeoutMs = timeoutMs;
  }

  /** 挂起一次审批；onEvent 用于把 approval_request 事件写进会话流 */
  async request(
    req: ApprovalRequest,
    sessionId: string,
    onEvent?: (approvalId: string) => Promise<void> | void,
  ): Promise<boolean> {
    const id = randomBytes(8).toString('hex');
    const promise = new Promise<boolean>((resolveGate) => {
      const timer = setTimeout(() => {
        const entry = this.pending.get(id);
        if (entry) {
          clearTimeout(entry.timer);
          this.pending.delete(id);
          resolveGate(false); // 超时视为拒绝（fail-closed）
        }
      }, this.timeoutMs);
      this.pending.set(id, { req, sessionId, resolve: resolveGate, timer });
    });
    if (onEvent) await onEvent(id);
    return promise;
  }

  decide(id: string, approved: boolean): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    entry.resolve(approved);
    return true;
  }

  listPending(): PendingApproval[] {
    return [...this.pending.entries()].map(([id, e]) => ({
      id,
      sessionId: e.sessionId,
      tool: e.req.tool,
      action: e.req.action,
      detail: e.req.detail,
      createdAt: new Date().toISOString(),
    }));
  }
}
