// 进程内 DAG 工作流引擎（M3）
// 事件全部以 NDJSON 追加到 runDir/events.ndjson，对照智作 stratex-langgraph 的事件流做法
// 无依赖的步骤并行执行；上游失败 → 下游跳过（fail-fast）

import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { StepDef, WorkflowDef, WorkflowEvent, WorkflowRunResult } from './types.ts';

export interface StepRunner {
  (prompt: string, stepId: string): Promise<string>;
}

export interface WorkflowEngineOptions {
  runDir: string;
  runner: StepRunner;
  log?: (line: string) => void;
  /** 事件回调（CLI 用它把纯事件 NDJSON 写 stdout，对照 stratex-flow 契约） */
  onEvent?: (ev: WorkflowEvent) => void;
}

export class WorkflowEngine {
  readonly runId: string;
  private opts: WorkflowEngineOptions;
  private eventFile: string;
  private started = false;
  private failedAny = false;

  constructor(opts: WorkflowEngineOptions) {
    this.opts = opts;
    this.runId = `${stamp()}-${randomBytes(2).toString('hex')}`;
    // 每次运行独立子目录：data/workflows/<runId>/events.ndjson + result.json
    this.eventFile = join(opts.runDir, this.runId, 'events.ndjson');
  }

  async run(def: WorkflowDef): Promise<WorkflowRunResult> {
    this.validate(def);
    const t0 = Date.now();
    await mkdir(join(this.opts.runDir, this.runId), { recursive: true });
    const steps = new Map<string, StepDef>(def.steps.map((s) => [s.id, s]));
    const outputs: Record<string, string> = {};
    const done = new Set<string>();
    const failed = new Set<string>();

    await this.emit({
      type: 'workflow_start',
      ts: now(),
      runId: this.runId,
      name: def.name,
      steps: def.steps.map((s) => s.id),
    });

    while (done.size + failed.size < steps.size) {
      const ready = [...steps.values()].filter(
        (s) => !done.has(s.id) && !failed.has(s.id) && (s.dependsOn ?? []).every((d) => done.has(d)),
      );
      // 上游失败：级联跳过
      const blocked = [...steps.values()].filter(
        (s) => !done.has(s.id) && !failed.has(s.id) && (s.dependsOn ?? []).some((d) => failed.has(d)),
      );
      for (const s of blocked) {
        failed.add(s.id);
        this.failedAny = true;
        await this.emit({ type: 'step_end', ts: now(), stepId: s.id, ok: false, durationMs: 0, error: '上游步骤失败，跳过' });
      }
      if (ready.length === 0 && blocked.length === 0) break; // 兜底（validate 已保证无环）

      await Promise.all(
        ready.map(async (s) => {
          await this.emit({ type: 'step_start', ts: now(), stepId: s.id });
          const st0 = Date.now();
          try {
            const prompt = interpolate(s.prompt, outputs);
            const raw = await this.opts.runner(prompt, s.id);
            const output = String(raw ?? '').trim();
            if (!output) throw new Error('步骤输出为空（可能被推理/截断吞掉）');
            outputs[s.id] = output;
            done.add(s.id);
            await this.emit({ type: 'step_end', ts: now(), stepId: s.id, ok: true, durationMs: Date.now() - st0, output });
          } catch (err) {
            failed.add(s.id);
            this.failedAny = true;
            await this.emit({ type: 'step_end', ts: now(), stepId: s.id, ok: false, durationMs: Date.now() - st0, error: (err as Error).message });
          }
        }),
      );
    }

    const ok = failed.size === 0;
    await this.emit({ type: 'workflow_end', ts: now(), ok, durationMs: Date.now() - t0 });
    const result: WorkflowRunResult = { runId: this.runId, ok, outputs, failedSteps: [...failed] };
    await writeFile(
      join(this.opts.runDir, this.runId, 'result.json'),
      JSON.stringify({ ...result, name: def.name }, null, 2),
      'utf8',
    );
    return result;
  }

  private validate(def: WorkflowDef): void {
    const ids = new Set<string>();
    for (const s of def.steps) {
      if (!s.id) throw new Error('步骤缺少 id');
      if (ids.has(s.id)) throw new Error(`步骤 id 重复：${s.id}`);
      ids.add(s.id);
    }
    for (const s of def.steps) {
      for (const d of s.dependsOn ?? []) {
        if (!ids.has(d)) throw new Error(`步骤 ${s.id} 依赖了不存在的步骤：${d}`);
      }
    }
    // Kahn 拓扑：能排完 = 无环
    const indeg = new Map<string, number>([...ids].map((id) => [id, 0]));
    for (const s of def.steps) for (const d of s.dependsOn ?? []) indeg.set(s.id, (indeg.get(s.id) ?? 0) + 1);
    const queue = [...indeg.entries()].filter(([, n]) => n === 0).map(([id]) => id);
    let visited = 0;
    while (queue.length > 0) {
      const id = queue.shift()!;
      visited++;
      for (const s of def.steps) {
        if ((s.dependsOn ?? []).includes(id)) {
          const n = (indeg.get(s.id) ?? 0) - 1;
          indeg.set(s.id, n);
          if (n === 0) queue.push(s.id);
        }
      }
    }
    if (visited !== ids.size) throw new Error('工作流存在循环依赖');
  }

  private async emit(ev: WorkflowEvent): Promise<void> {
    await appendFile(this.eventFile, JSON.stringify(ev) + '\n', 'utf8');
    this.opts.onEvent?.(ev);
    this.opts.log?.(`[workflow] ${ev.type} ${'stepId' in ev ? ev.stepId : ''}`.trimEnd());
  }
}

function interpolate(prompt: string, outputs: Record<string, string>): string {
  return prompt.replace(/\$\{([A-Za-z0-9_]+)\}/g, (raw, id: string) =>
    id in outputs ? outputs[id]! : raw,
  );
}

function now(): string {
  return new Date().toISOString();
}

function stamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
