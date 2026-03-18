import type { LanguageStreamPart, FinishReason, LanguageTokenUsage } from '@synax-ai/sdk';
import type { OpenAIStreamChunk } from './types';

function decodeFinishReason(reason: string | null): FinishReason {
  if (reason === 'stop') return 'stop';
  if (reason === 'length') return 'length';
  if (reason === 'tool_calls') return 'tool-calls';
  if (reason === 'content_filter') return 'content-filter';
  return null;
}

export class StreamDecoder {
  private toolCallIndex = new Map<number, { id: string; name: string; arguments: string }>();
  private textId?: string;
  private started = false;

  *decode(data: string): Generator<LanguageStreamPart> {
    let chunk: OpenAIStreamChunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      return;
    }

    if (!this.started) {
      this.started = true;
      yield { type: 'stream-start' };
      yield {
        type: 'response-metadata',
        id: chunk.id,
        model: chunk.model,
        created: chunk.created,
      };
    }

    const choice = chunk.choices[0];
    if (!choice) return;

    const delta = choice.delta;

    // Handle text content
    if (delta.content) {
      if (!this.textId) {
        this.textId = `text-${Date.now()}`;
        yield { type: 'text-start', id: this.textId };
      }
      yield { type: 'text-delta', id: this.textId, delta: delta.content };
    }

    // Handle tool calls
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index;

        if (tc.id) {
          // New tool call
          this.toolCallIndex.set(idx, {
            id: tc.id,
            name: tc.function?.name ?? '',
            arguments: '',
          });
          yield {
            type: 'tool-input-start',
            id: tc.id,
            toolName: tc.function?.name ?? '',
          };
        }

        if (tc.function?.arguments) {
          const existing = this.toolCallIndex.get(idx);
          if (existing) {
            existing.arguments += tc.function.arguments;
            yield {
              type: 'tool-input-delta',
              id: existing.id,
              delta: tc.function.arguments,
            };
          }
        }
      }
    }

    // Handle finish
    if (choice.finish_reason) {
      // Close text if open
      if (this.textId) {
        yield { type: 'text-end', id: this.textId };
      }

      // Close all tool calls
      for (const [idx, tc] of this.toolCallIndex) {
        yield { type: 'tool-input-end', id: tc.id };
      }

      let usage: LanguageTokenUsage | undefined;
      if (chunk.usage) {
        usage = {
          inputTokens: {
            total: chunk.usage.prompt_tokens ?? 0,
            noCache: undefined,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: {
            total: chunk.usage.completion_tokens ?? 0,
            reasoning: undefined,
          },
        };
      }

      yield {
        type: 'finish',
        finishReason: decodeFinishReason(choice.finish_reason),
        usage: usage ?? {
          inputTokens: { total: 0, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 0, reasoning: undefined },
        },
      };
    }
  }
}
