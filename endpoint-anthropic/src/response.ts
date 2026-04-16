import type { LanguageResponse, LanguageToolCallContent } from '@synax-ai/sdk';

function encodeFinishReason(reason: string | null): string {
  if (reason === 'stop') return 'end_turn';
  if (reason === 'length') return 'max_tokens';
  if (reason === 'tool-calls') return 'tool_use';
  return 'end_turn';
}

export function encodeResponse(res: LanguageResponse): any {
  const choice = res.choices[0];
  const content = choice?.message?.content;
  const blocks: any[] = [];

  if (Array.isArray(content)) {
    for (const p of content) {
      if (p.type === 'text') blocks.push({ type: 'text', text: p.text });
      else if (p.type === 'reasoning') {
        const reasoningPart = p as any;
        let thinkingText = '';
        if (Array.isArray(reasoningPart.reasoning)) {
          thinkingText = reasoningPart.reasoning.map((r: any) => r.text ?? '').join('');
        } else if (typeof reasoningPart.reasoning === 'string') {
          thinkingText = reasoningPart.reasoning;
        }
        const thinkingBlock: any = { type: 'thinking', thinking: thinkingText };
        if (reasoningPart.signature) thinkingBlock.signature = reasoningPart.signature;
        blocks.push(thinkingBlock);
      }
      else if (p.type === 'tool-call') {
        const tc = p as LanguageToolCallContent;
        let parsedInput = tc.input;
        if (typeof tc.input === 'string') {
          try { parsedInput = JSON.parse(tc.input); } catch { parsedInput = {}; }
        }
        blocks.push({
          type: 'tool_use',
          id: tc.toolCallId,
          name: tc.toolName,
          input: parsedInput
        });
      }
    }
  }

  const result: any = {
    id: res.id,
    type: 'message',
    role: 'assistant',
    model: res.model,
    content: blocks,
    stop_reason: encodeFinishReason(choice?.finishReason ?? null),
  };

  // Include stop_sequence from providerMetadata if available
  if (res.providerMetadata && 'stop_sequence' in res.providerMetadata) {
    result.stop_sequence = res.providerMetadata.stop_sequence;
  } else {
    result.stop_sequence = null;
  }

  // Include full usage with cache breakdown
  if (res.usage) {
    const usage: any = {
      input_tokens: res.usage.inputTokens.total ?? 0,
      output_tokens: res.usage.outputTokens.total ?? 0,
    };
    if (res.usage.inputTokens.cacheRead !== undefined) {
      usage.cache_read_input_tokens = res.usage.inputTokens.cacheRead;
    }
    if (res.usage.inputTokens.cacheWrite !== undefined) {
      usage.cache_creation_input_tokens = res.usage.inputTokens.cacheWrite;
    }
    result.usage = usage;
  }

  return result;
}
