import type { LanguageStreamPart } from '@synax-ai/sdk';

function event(type: string, data: object): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

export class StreamEncoder {
  private blockIndex = 0;
  private started = false;
  private responseId: string | undefined;
  private model: string | undefined;
  private inputTokens: number | undefined;
  private cacheRead: number | undefined;
  private cacheWrite: number | undefined;

  encode(part: LanguageStreamPart): string {
    // Handle response-metadata: emit message_start
    if (part.type === 'response-metadata') {
      this.responseId = part.id;
      this.model = part.model;
      this.started = true;

      // Capture input tokens if present in the metadata
      const meta = part as any;
      if (meta.inputTokens !== undefined) this.inputTokens = meta.inputTokens;
      if (meta.cacheRead !== undefined) this.cacheRead = meta.cacheRead;
      if (meta.cacheWrite !== undefined) this.cacheWrite = meta.cacheWrite;

      return event('message_start', {
        message: {
          id: part.id,
          type: 'message',
          role: 'assistant',
          content: [],
          model: part.model,
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: this.inputTokens ?? 0,
            output_tokens: 0,
            ...(this.cacheRead !== undefined && { cache_read_input_tokens: this.cacheRead }),
            ...(this.cacheWrite !== undefined && { cache_creation_input_tokens: this.cacheWrite }),
          },
        },
      });
    }

    // Handle text-start: emit content_block_start
    if (part.type === 'text-start') {
      const result = event('content_block_start', {
        index: this.blockIndex,
        content_block: { type: 'text', text: '' },
      });
      return result;
    }

    // Handle text-delta: emit content_block_delta
    if (part.type === 'text-delta') {
      return event('content_block_delta', {
        index: this.blockIndex,
        delta: { type: 'text_delta', text: (part as any).delta },
      });
    }

    // Handle text-end: emit content_block_stop and increment index
    if (part.type === 'text-end') {
      const idx = this.blockIndex;
      this.blockIndex++;
      return event('content_block_stop', { index: idx });
    }

    // Handle reasoning-start: emit content_block_start for thinking
    if (part.type === 'reasoning-start') {
      return event('content_block_start', {
        index: this.blockIndex,
        content_block: { type: 'thinking', thinking: '' },
      });
    }

    // Handle reasoning-delta: emit content_block_delta for thinking
    if (part.type === 'reasoning-delta') {
      return event('content_block_delta', {
        index: this.blockIndex,
        delta: { type: 'thinking_delta', thinking: (part as any).delta },
      });
    }

    // Handle reasoning-end: emit content_block_stop and increment index
    if (part.type === 'reasoning-end') {
      const idx = this.blockIndex;
      this.blockIndex++;
      return event('content_block_stop', { index: idx });
    }

    // Handle tool-input-start: emit content_block_start for tool_use
    if (part.type === 'tool-input-start') {
      return event('content_block_start', {
        index: this.blockIndex,
        content_block: {
          type: 'tool_use',
          id: (part as any).id,
          name: (part as any).toolName,
        },
      });
    }

    // Handle tool-input-delta: emit content_block_delta for input_json_delta
    if (part.type === 'tool-input-delta') {
      return event('content_block_delta', {
        index: this.blockIndex,
        delta: { type: 'input_json_delta', partial_json: (part as any).delta },
      });
    }

    // Handle tool-input-end: emit content_block_stop and increment index
    if (part.type === 'tool-input-end') {
      const idx = this.blockIndex;
      this.blockIndex++;
      return event('content_block_stop', { index: idx });
    }

    // Handle finish: emit message_delta with stop_reason, stop_sequence, and usage
    if (part.type === 'finish') {
      let stopReason: string;
      if (part.finishReason === 'tool-calls') stopReason = 'tool_use';
      else if (part.finishReason === 'length') stopReason = 'max_tokens';
      else if (part.finishReason === 'stop') stopReason = 'end_turn';
      else stopReason = 'end_turn';

      // Get stop_sequence from provider metadata if available
      const finishPart = part as any;
      const stopSequence = finishPart.providerMetadata?.stop_sequence ?? null;

      return event('message_delta', {
        delta: { stop_reason: stopReason, stop_sequence: stopSequence },
        usage: { output_tokens: part.usage?.outputTokens?.total ?? 0 },
      });
    }

    // Ignore other event types (stream-start, content-part, error)
    return '';
  }

  start(id: string, model: string): string {
    this.responseId = id;
    this.model = model;
    this.started = true;
    return event('message_start', {
      message: {
        id,
        type: 'message',
        role: 'assistant',
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  end(): string {
    return event('message_stop', {});
  }
}
