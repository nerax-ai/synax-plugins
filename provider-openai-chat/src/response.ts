import type {
  LanguageResponse,
  LanguageAssistantMessage,
  LanguageTextContent,
  LanguageToolCallContent,
  LanguageTokenUsage,
  FinishReason,
} from '@synax-ai/sdk';
import type { OpenAIChatResponse } from './types';

function decodeFinishReason(reason: string | null): FinishReason {
  if (reason === 'stop') return 'stop';
  if (reason === 'length') return 'length';
  if (reason === 'tool_calls') return 'tool-calls';
  if (reason === 'content_filter') return 'content-filter';
  return null;
}

export function decodeResponse(response: OpenAIChatResponse): LanguageResponse {
  const choice = response.choices[0];
  const message = choice?.message;

  const content: Array<LanguageTextContent | LanguageToolCallContent> = [];

  if (message?.content) {
    content.push({ type: 'text', text: message.content });
  }

  if (message?.tool_calls && message.tool_calls.length > 0) {
    for (const tc of message.tool_calls) {
      content.push({
        type: 'tool-call',
        toolCallId: tc.id,
        toolName: tc.function.name,
        input: tc.function.arguments,
      });
    }
  }

  const assistantMessage: LanguageAssistantMessage = {
    role: 'assistant',
    content: content.length > 0 ? content : [{ type: 'text', text: '' }],
  };

  let usage: LanguageTokenUsage | undefined;
  if (response.usage) {
    usage = {
      inputTokens: {
        total: response.usage.prompt_tokens ?? 0,
        noCache: undefined,
        cacheRead: response.usage.prompt_tokens_details?.cached_tokens,
        cacheWrite: undefined,
      },
      outputTokens: {
        total: response.usage.completion_tokens ?? 0,
        reasoning: response.usage.completion_tokens_details?.reasoning_tokens,
      },
    };
  }

  return {
    id: response.id,
    created: response.created,
    model: response.model,
    choices: [{
      index: 0,
      message: assistantMessage,
      finishReason: decodeFinishReason(choice?.finish_reason ?? null),
    }],
    usage,
  };
}
