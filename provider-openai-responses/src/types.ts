import type { JSONSchema } from '@synax-ai/sdk';

export interface OpenAIResponsesProviderConfig {
  apiKey: string;
  baseURL?: string;
  proxy?: string;
  headers?: Record<string, string>;
}

// Input item types
export type ResponsesInputItem =
  | { type: 'message'; role: 'system' | 'user' | 'assistant'; content: ResponsesContentPart[] }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string };

export type ResponsesContentPart =
  | { type: 'input_text'; text: string }
  | { type: 'output_text'; text: string }
  | { type: 'input_image'; image_url: string };

// Output item types
export type ResponsesOutputItem =
  | { id: string; type: 'message'; role: 'assistant'; content: ResponsesOutputContentPart[]; status: string }
  | { id: string; type: 'function_call'; call_id: string; name: string; arguments: string; status: string }
  | { id: string; type: 'reasoning'; encrypted_content?: string; summary?: Array<{ type: 'summary_text'; text: string }>; status: string };

export type ResponsesOutputContentPart =
  | { type: 'output_text'; text: string; annotations?: any[] }
  | { type: 'refusal'; refusal: string };

export interface ResponsesReasoningConfig {
  effort?: 'low' | 'medium' | 'high';
  generate_summary?: boolean;
}

export interface OpenAIResponsesRequest {
  model: string;
  input: ResponsesInputItem[];
  instructions?: string;
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  tools?: Array<{ type: 'function'; name: string; description?: string; parameters?: JSONSchema }>;
  tool_choice?: 'none' | 'auto' | 'required' | { type: 'function'; name: string };
  reasoning?: ResponsesReasoningConfig;
  stream?: boolean;
  include?: string[];
}

export interface OpenAIResponsesResponse {
  id: string;
  object: 'response';
  created_at: number;
  model: string;
  status: 'completed' | 'failed' | 'in_progress';
  output: ResponsesOutputItem[];
  stop_reason?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    output_tokens_details?: { reasoning_tokens?: number };
  };
}

// Stream event types
export interface ResponsesStreamEvent {
  type: string;
  [key: string]: unknown;
}

export interface ResponseOutputItemAddedEvent {
  type: 'response.output_item.added';
  output_index: number;
  item: ResponsesOutputItem;
}

export interface ResponseContentPartAddedEvent {
  type: 'response.content_part.added';
  item_id: string;
  output_index: number;
  content_index: number;
  part: ResponsesOutputContentPart;
}

export interface ResponseOutputTextDeltaEvent {
  type: 'response.output_text.delta';
  item_id: string;
  output_index: number;
  content_index: number;
  delta: string;
}

export interface ResponseFunctionCallArgumentsDeltaEvent {
  type: 'response.function_call_arguments.delta';
  item_id: string;
  output_index: number;
  delta: string;
}

export interface ResponseOutputItemDoneEvent {
  type: 'response.output_item.done';
  output_index: number;
  item: ResponsesOutputItem;
}

export interface ResponseCompletedEvent {
  type: 'response.completed';
  response: OpenAIResponsesResponse;
}
