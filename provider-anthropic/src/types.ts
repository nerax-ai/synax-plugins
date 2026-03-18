import type { JSONSchema } from '@synax-ai/sdk';

export interface AnthropicProviderConfig {
  apiKey: string;
  baseURL?: string;
  proxy?: string;
  headers?: Record<string, string>;
}

// Content block types
export interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

export interface AnthropicImageBlock {
  type: 'image';
  source: {
    type: 'base64' | 'url';
    media_type?: string;
    data?: string;
    url?: string;
  };
}

export interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

export interface AnthropicThinkingBlock {
  type: 'thinking';
  thinking: string;
}

export interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicThinkingBlock
  | AnthropicToolResultBlock;

// Message types
export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicContentBlock[];
}

// Tool types
export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: JSONSchema;
}

// Tool choice types
export type AnthropicToolChoice =
  | { type: 'auto' }
  | { type: 'any' }
  | { type: 'tool'; name: string };

// Thinking config
export interface AnthropicThinkingConfig {
  type: 'enabled' | 'disabled';
  budget_tokens?: number;
}

// Request type
export interface AnthropicMessagesRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  thinking?: AnthropicThinkingConfig;
  stream?: boolean;
}

// Response type
export interface AnthropicMessagesResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}
