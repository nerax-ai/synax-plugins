import type { JSONSchema } from '@synax-ai/sdk';

export interface OpenAIProviderConfig {
  apiKey: string;
  baseURL?: string;
  proxy?: string;
  headers?: Record<string, string>;
}

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | OpenAIContentPart[];
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface OpenAIContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string; detail?: 'auto' | 'low' | 'high' };
}

export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: JSONSchema;
    strict?: boolean;
  };
}

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string[];
  tools?: OpenAITool[];
  tool_choice?: 'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } };
  stream?: boolean;
  response_format?: { type: 'text' | 'json_object' } | { type: 'json_schema'; json_schema: { name: string; schema: JSONSchema; strict?: boolean } };
}

export interface OpenAIChatResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content?: string;
      tool_calls?: OpenAIToolCall[];
    };
    finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

export interface OpenAIStreamChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: 'assistant';
      content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: 'function';
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}
