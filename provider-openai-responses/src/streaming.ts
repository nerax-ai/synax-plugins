import type { LanguageStreamPart, FinishReason, LanguageTokenUsage } from '@synax-ai/sdk';
import type {
  ResponsesOutputItem,
  ResponseOutputItemAddedEvent,
  ResponseOutputTextDeltaEvent,
  ResponseFunctionCallArgumentsDeltaEvent,
  ResponseOutputItemDoneEvent,
  ResponseCompletedEvent,
} from './types';

function decodeFinishReason(reason: string | undefined): FinishReason {
  if (reason === 'stop' || reason === 'end_turn') return 'stop';
  if (reason === 'max_tokens' || reason === 'max_output_tokens') return 'length';
  if (reason === 'tool_calls' || reason === 'tool_use') return 'tool-calls';
  return null;
}

export class StreamDecoder {
  private items = new Map<string, ResponsesOutputItem>();
  private textBuffers = new Map<string, string>();
  private toolBuffers = new Map<string, string>();
  private started = false;

  *handle(event: string, data: unknown): Generator<LanguageStreamPart> {
    if (!this.started) {
      this.started = true;
      yield { type: 'stream-start' };
    }

    if (event === 'response.created' || event === 'response.started') {
      const resp = data as { id?: string; model?: string };
      if (resp.id) {
        yield { type: 'response-metadata', id: resp.id, model: resp.model ?? '', created: Math.floor(Date.now() / 1000) };
      }
    }

    if (event === 'response.output_item.added') {
      const { item } = data as ResponseOutputItemAddedEvent;
      this.items.set(item.id, item);

      if (item.type === 'message') {
        yield { type: 'text-start', id: item.id };
      } else if (item.type === 'function_call') {
        yield { type: 'tool-input-start', id: item.id, toolName: item.name };
      } else if (item.type === 'reasoning') {
        yield { type: 'reasoning-start', id: item.id };
      }
    }

    if (event === 'response.output_text.delta') {
      const { item_id, delta } = data as ResponseOutputTextDeltaEvent;
      const buf = this.textBuffers.get(item_id) ?? '';
      this.textBuffers.set(item_id, buf + delta);
      yield { type: 'text-delta', id: item_id, delta };
    }

    if (event === 'response.function_call_arguments.delta') {
      const { item_id, delta } = data as ResponseFunctionCallArgumentsDeltaEvent;
      const buf = this.toolBuffers.get(item_id) ?? '';
      this.toolBuffers.set(item_id, buf + delta);
      yield { type: 'tool-input-delta', id: item_id, delta };
    }

    if (event === 'response.output_item.done') {
      const { item } = data as ResponseOutputItemDoneEvent;

      if (item.type === 'message') {
        yield { type: 'text-end', id: item.id };
      } else if (item.type === 'function_call') {
        yield { type: 'tool-input-end', id: item.id };
      } else if (item.type === 'reasoning') {
        const summary = item.summary?.map(s => s.text).join('\n') ?? '';
        if (summary) {
          yield { type: 'reasoning-delta', id: item.id, delta: summary };
        }
        yield { type: 'reasoning-end', id: item.id };
      }
    }

    if (event === 'response.completed') {
      const { response } = data as ResponseCompletedEvent;

      let usage: LanguageTokenUsage = {
        inputTokens: { total: 0, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 0, reasoning: undefined },
      };

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

      yield {
        type: 'finish',
        finishReason: decodeFinishReason(response.stop_reason),
        usage,
      };
    }
  }
}
