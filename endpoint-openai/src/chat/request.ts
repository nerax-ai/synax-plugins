import type { LanguageRequest, LanguageMessage, LanguageToolCallContent } from '@synax-ai/sdk';

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface OpenAIMessage {
  role: string;
  content?: string | any[];
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface OpenAIChatRequest {
  model: string;
  messages?: OpenAIMessage[];
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  tools?: any[];
  tool_choice?: any;
  seed?: number;
  stream?: boolean;
}

function decodeMessages(messages: OpenAIMessage[]): LanguageMessage[] {
  return messages.map((m): LanguageMessage => {
    if (m.role === 'tool') {
      return {
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: m.tool_call_id ?? '',
          toolName: m.name ?? '',
          result: typeof m.content === 'string'
            ? { type: 'text', value: m.content }
            : { type: 'text', value: m.content ? JSON.stringify(m.content) : '' }
        }],
      };
    }
    if (m.role === 'assistant' && m.tool_calls) {
      return {
        role: 'assistant',
        content: m.tool_calls.map((tc: any): LanguageToolCallContent => ({
          type: 'tool-call',
          toolCallId: tc.id,
          toolName: tc.function.name,
          input: tc.function.arguments,
        })),
      };
    }
    const textContent = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
    return { role: m.role, content: [{ type: 'text', text: textContent }] } as LanguageMessage;
  });
}

export function decodeRequest(body: Partial<OpenAIChatRequest>): LanguageRequest {
  return {
    model: body.model ?? '',
    messages: decodeMessages(body.messages ?? []),
    maxOutputTokens: body.max_tokens ?? body.max_completion_tokens,
    temperature: body.temperature ?? undefined,
    topP: body.top_p ?? undefined,
    stopSequences: body.stop ? (Array.isArray(body.stop) ? body.stop : [body.stop]) : undefined,
    tools: body.tools?.map((t: any) => ({
      type: 'function',
      name: t.function?.name ?? t.name,
      description: t.function?.description ?? t.description,
      inputSchema: t.function?.parameters ?? t.inputSchema,
    })),
    toolChoice: body.tool_choice,
    seed: body.seed ?? undefined,
  };
}
