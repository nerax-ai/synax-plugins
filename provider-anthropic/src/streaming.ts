import type { LanguageStreamPart, FinishReason, LanguageTokenUsage } from '@synax-ai/sdk';

interface AnthropicStreamEvent {
  type: string;
  index?: number;
  delta?: { type: string; text?: string; thinking?: string; partial_json?: string; stop_reason?: string };
  content_block?: { type: string; id?: string; name?: string; text?: string };
  message?: { id: string; model: string; usage?: { input_tokens: number; output_tokens: number } };
  usage?: { output_tokens: number };
}

function decodeFinishReason(reason: string | null): FinishReason {
  if (reason === 'end_turn') return 'stop';
  if (reason === 'max_tokens') return 'length';
  if (reason === 'tool_use') return 'tool-calls';
  if (reason === 'stop_sequence') return 'stop';
  return null;
}

export class StreamDecoder {
  private blockIndex = 0;
  private currentTextId: string | undefined;
  private currentToolId: string | undefined;
  private currentThinkingId: string | undefined;
  private responseId: string | undefined;
  private model: string | undefined;
  private started = false;

  *handle(event: AnthropicStreamEvent): Generator<LanguageStreamPart> {
    if (!this.started) {
      this.started = true;
      yield { type: 'stream-start' };
    }

    if (event.type === 'message_start') {
      if (event.message) {
        this.responseId = event.message.id;
        this.model = event.message.model;
        yield {
          type: 'response-metadata',
          id: event.message.id,
          model: event.message.model,
          created: Math.floor(Date.now() / 1000),
        };
      }
    }

    if (event.type === 'content_block_start') {
      const block = event.content_block;
      const idx = event.index ?? this.blockIndex++;

      if (block?.type === 'text') {
        const id = `text-${idx}`;
        this.currentTextId = id;
        yield { type: 'text-start', id };
      } else if (block?.type === 'thinking') {
        const id = `thinking-${idx}`;
        this.currentThinkingId = id;
        yield { type: 'reasoning-start', id };
      } else if (block?.type === 'tool_use') {
        const id = block.id ?? `tool-${idx}`;
        this.currentToolId = id;
        yield {
          type: 'tool-input-start',
          id,
          toolName: block.name ?? '',
        };
      }
    }

    if (event.type === 'content_block_delta') {
      const delta = event.delta;

      if (delta?.type === 'text_delta' && delta.text) {
        if (this.currentTextId) {
          yield { type: 'text-delta', id: this.currentTextId, delta: delta.text };
        }
      } else if (delta?.type === 'thinking_delta' && delta.thinking) {
        if (this.currentThinkingId) {
          yield { type: 'reasoning-delta', id: this.currentThinkingId, delta: delta.thinking };
        }
      } else if (delta?.type === 'input_json_delta' && delta.partial_json) {
        if (this.currentToolId) {
          yield { type: 'tool-input-delta', id: this.currentToolId, delta: delta.partial_json };
        }
      }
    }

    if (event.type === 'content_block_stop') {
      if (this.currentTextId) {
        yield { type: 'text-end', id: this.currentTextId };
        this.currentTextId = undefined;
      }
      if (this.currentThinkingId) {
        yield { type: 'reasoning-end', id: this.currentThinkingId };
        this.currentThinkingId = undefined;
      }
      if (this.currentToolId) {
        yield { type: 'tool-input-end', id: this.currentToolId };
        this.currentToolId = undefined;
      }

      this.blockIndex++;
    }

    if (event.type === 'message_delta') {
      const usage = event.usage;
      const delta = event.delta;

      const tokenUsage: LanguageTokenUsage = {
        inputTokens: { total: 0, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: {
          total: usage?.output_tokens ?? 0,
          reasoning: undefined,
        },
      };

      yield {
        type: 'finish',
        finishReason: decodeFinishReason(delta?.stop_reason ?? null),
        usage: tokenUsage,
      };
    }

    if (event.type === 'message_stop') {
      // Stream completed
    }
  }
}
