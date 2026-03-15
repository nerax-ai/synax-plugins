import type { LanguageStreamPart } from '@synax-ai/sdk';

function event(type: string, data: object): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

export class StreamEncoder {
  private blockIndex = 0;
  private textBuffer = '';

  encode(part: LanguageStreamPart): string {
    if (part.type === 'text-delta') {
      this.textBuffer += part.textDelta;
      return event('content_block_delta', {
        index: this.blockIndex,
        delta: { type: 'text_delta', text: (part as any).textDelta },
      });
    }

    if (part.type === 'reasoning-delta') {
      return event('content_block_delta', {
        index: this.blockIndex,
        delta: { type: 'thinking_delta', thinking: (part as any).reasoningDelta },
      });
    }

    if (part.type === 'tool-call') {
      const result = event('content_block_start', {
        index: this.blockIndex++,
        content_block: { type: 'tool_use', id: (part as any).toolCallId, name: (part as any).toolName },
      });
      return result + event('content_block_delta', {
        index: this.blockIndex - 1,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify((part as any).input) },
      });
    }

    if (part.type === 'finish') {
      return event('message_delta', {
        delta: { stop_reason: part.finishReason === 'tool-calls' ? 'tool_use' : 'end_turn' },
        usage: { output_tokens: part.usage?.outputTokens?.total ?? 0 },
      });
    }

    return '';
  }

  start(id: string, model: string): string {
    return event('message_start', {
      message: { id, type: 'message', role: 'assistant', model, content: [] },
    });
  }

  end(): string {
    return event('message_stop', {});
  }
}
