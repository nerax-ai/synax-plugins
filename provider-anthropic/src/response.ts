import type {
  LanguageResponse,
  LanguageAssistantMessage,
  LanguageTextContent,
  LanguageToolCallContent,
  LanguageReasoningContent,
  LanguageTokenUsage,
  FinishReason,
} from '@synax-ai/sdk';
import type { AnthropicMessagesResponse, AnthropicContentBlock } from './types';

function decodeFinishReason(reason: string | null): FinishReason {
  if (reason === 'end_turn') return 'stop';
  if (reason === 'max_tokens') return 'length';
  if (reason === 'tool_use') return 'tool-calls';
  if (reason === 'stop_sequence') return 'stop';
  return null;
}

function decodeContentBlock(block: AnthropicContentBlock): Array<LanguageTextContent | LanguageToolCallContent | LanguageReasoningContent> {
  const result: Array<LanguageTextContent | LanguageToolCallContent | LanguageReasoningContent> = [];

  if (block.type === 'text') {
    result.push({ type: 'text', text: block.text });
  } else if (block.type === 'thinking') {
    const reasoningPart: LanguageReasoningContent & { signature?: string } = { type: 'reasoning', reasoning: block.thinking };
    if (block.signature) reasoningPart.signature = block.signature;
    result.push(reasoningPart);
  } else if (block.type === 'tool_use') {
    result.push({
      type: 'tool-call',
      toolCallId: block.id,
      toolName: block.name,
      input: block.input,
    });
  }

  return result;
}

export function decodeResponse(response: AnthropicMessagesResponse): LanguageResponse {
  const content: Array<LanguageTextContent | LanguageToolCallContent | LanguageReasoningContent> = [];

  for (const block of response.content) {
    content.push(...decodeContentBlock(block));
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
        cacheRead: response.usage.cache_read_input_tokens,
        cacheWrite: response.usage.cache_creation_input_tokens,
      },
      outputTokens: {
        total: response.usage.output_tokens ?? 0,
        reasoning: undefined,
      },
    };
  }

  return {
    id: response.id,
    created: Math.floor(Date.now() / 1000),
    model: response.model,
    choices: [{
      index: 0,
      message: assistantMessage,
      finishReason: decodeFinishReason(response.stop_reason ?? null),
    }],
    usage,
    providerMetadata: {
      stop_sequence: response.stop_sequence ?? null,
    },
  };
}
