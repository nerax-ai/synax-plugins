import type {
  LanguageResponse,
  LanguageAssistantMessage,
  LanguageTextContent,
  LanguageToolCallContent,
  LanguageReasoningContent,
  LanguageTokenUsage,
  FinishReason,
} from '@synax-ai/sdk';
import type { OpenAIResponsesResponse, ResponsesOutputItem } from './types';

function decodeFinishReason(reason: string | undefined): FinishReason {
  if (reason === 'stop' || reason === 'end_turn') return 'stop';
  if (reason === 'max_tokens' || reason === 'max_output_tokens') return 'length';
  if (reason === 'tool_calls' || reason === 'tool_use') return 'tool-calls';
  if (reason === 'content_filter') return 'content-filter';
  return null;
}

function decodeOutputItem(item: ResponsesOutputItem): Array<LanguageTextContent | LanguageToolCallContent | LanguageReasoningContent> {
  const result: Array<LanguageTextContent | LanguageToolCallContent | LanguageReasoningContent> = [];

  if (item.type === 'message') {
    for (const part of item.content) {
      if (part.type === 'output_text') {
        result.push({ type: 'text', text: part.text });
      }
    }
  } else if (item.type === 'function_call') {
    result.push({
      type: 'tool-call',
      toolCallId: item.call_id,
      toolName: item.name,
      input: item.arguments,
    });
  } else if (item.type === 'reasoning') {
    const reasoningText = item.summary?.map(s => s.text).join('\n')
      || item.encrypted_content
      || '';
    result.push({ type: 'reasoning', reasoning: reasoningText });
  }

  return result;
}

export function decodeResponse(response: OpenAIResponsesResponse): LanguageResponse {
  const content: Array<LanguageTextContent | LanguageToolCallContent | LanguageReasoningContent> = [];

  for (const item of response.output) {
    content.push(...decodeOutputItem(item));
  }

  const assistantMessage: LanguageAssistantMessage = {
    role: 'assistant',
    content: content.length > 0 ? content : [{ type: 'text', text: '' }],
  };

  let usage: LanguageTokenUsage | undefined;
  if (response.usage) {
    usage = {
      inputTokens: {
        total: response.usage.input_tokens ?? 0,
        noCache: undefined,
        cacheRead: undefined,
        cacheWrite: undefined,
      },
      outputTokens: {
        total: response.usage.output_tokens ?? 0,
        reasoning: response.usage.output_tokens_details?.reasoning_tokens,
      },
    };
  }

  return {
    id: response.id,
    created: response.created_at,
    model: response.model,
    choices: [{
      index: 0,
      message: assistantMessage,
      finishReason: decodeFinishReason(response.stop_reason),
    }],
    usage,
  };
}
