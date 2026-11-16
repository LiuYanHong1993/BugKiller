// LLM 线协议类型（OpenAI Chat Completions 子集）

export type Role = 'system' | 'user' | 'assistant' | 'tool';

/** 多模态 content 分片（OpenAI Chat 兼容子集；文本端点直接透传，由端点决定支持度） */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: Role;
  content: string | ContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface JsonSchema {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
}

export interface ToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: JsonSchema };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  temperature?: number;
}

export interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatResponseChoice {
  index: number;
  finish_reason: string | null;
  message: { role: Role; content: string | null; tool_calls?: ToolCall[] };
}

export interface ChatResponse {
  id: string;
  model: string;
  choices: ChatResponseChoice[];
  usage?: ChatUsage;
}

export class LlmError extends Error {
  status?: number;
  retryable?: boolean;

  constructor(message: string, status?: number, retryable?: boolean) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.retryable = retryable;
  }
}
