// 工作流类型（对照智作 stratex-flow 的 stdin JSON → stdout NDJSON 契约）

export interface StepDef {
  id: string;
  prompt: string;
  dependsOn?: string[];
}

export interface WorkflowDef {
  name: string;
  steps: StepDef[];
}

export type WorkflowEvent =
  | { type: 'workflow_start'; ts: string; runId: string; name: string; steps: string[] }
  | { type: 'step_start'; ts: string; stepId: string }
  | { type: 'step_end'; ts: string; stepId: string; ok: boolean; durationMs: number; output?: string; error?: string }
  | { type: 'workflow_end'; ts: string; ok: boolean; durationMs: number };

export interface WorkflowRunResult {
  runId: string;
  ok: boolean;
  outputs: Record<string, string>;
  failedSteps: string[];
}
