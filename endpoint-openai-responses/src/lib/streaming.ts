import type { LanguageStreamPart } from '@synax-ai/sdk';

function encodeFinishReason(r: string | null): string {
  if (r === 'tool-calls') return 'tool_calls';
  if (r === 'length') return 'max_output_tokens';
  return 'stop';
}

function sse(event: string, data: object): string {
  return `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`;
}

export class StreamEncoder {
  private outputIndex = 0;
  private idToIndex = new Map<string, number>();
  private toolArguments = new Map<string, string>();
  private toolNames = new Map<string, string>();

  private getOutputIndex(id: string): number {
    let idx = this.idToIndex.get(id);
    if (idx === undefined) {
      idx = this.outputIndex++;
      this.idToIndex.set(id, idx);
    }
    return idx;
  }

  encode(part: LanguageStreamPart, model: string, id: string): string | null {
    if (part.type === 'stream-start') return null;

    if (part.type === 'reasoning-start') {
      const idx = this.getOutputIndex(part.id);
      const item = { id: part.id, type: 'reasoning', encrypted_content: '', status: 'in_progress' };
      return sse('response.output_item.added', { output_index: idx, item });
    }
    if (part.type === 'reasoning-delta') return null;
    if (part.type === 'reasoning-end') {
      const idx = this.idToIndex.get(part.id) ?? 0;
      const item = { id: part.id, type: 'reasoning', status: 'completed' };
      return sse('response.output_item.done', { output_index: idx, item });
    }

    if (part.type === 'text-start') {
      const idx = this.getOutputIndex(part.id);
      const phase = (part.providerMetadata as any)?.openai?.phase;
      const item: any = { id: part.id, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '' }], status: 'in_progress' };
      if (phase) item.phase = phase;
      return sse('response.output_item.added', { output_index: idx, item })
        + sse('response.content_part.added', { item_id: part.id, output_index: idx, content_index: 0, part: { type: 'output_text', text: '', annotations: [], logprobs: [] } });
    }
    if (part.type === 'text-end') {
      const idx = this.idToIndex.get(part.id) ?? 0;
      const phase = (part.providerMetadata as any)?.openai?.phase;
      const item: any = { id: part.id, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '' }], status: 'completed' };
      if (phase) item.phase = phase;
      return sse('response.content_part.done', { item_id: part.id, output_index: idx, content_index: 0, part: { type: 'output_text', text: '' } })
        + sse('response.output_item.done', { output_index: idx, item });
    }
    if (part.type === 'text-delta') {
      const idx = this.idToIndex.get(part.id) ?? 0;
      return sse('response.output_text.delta', { item_id: part.id, output_index: idx, content_index: 0, delta: part.delta });
    }

    if (part.type === 'tool-input-start') {
      const idx = this.getOutputIndex(part.id);
      this.toolNames.set(part.id, part.toolName);
      const item = { id: part.id, type: 'function_call', call_id: part.id, name: part.toolName, arguments: '', status: 'in_progress' };
      return sse('response.output_item.added', { output_index: idx, item });
    }
    if (part.type === 'tool-input-delta') {
      const idx = this.idToIndex.get(part.id) ?? 0;
      const current = this.toolArguments.get(part.id) ?? '';
      this.toolArguments.set(part.id, current + part.delta);
      return sse('response.function_call_arguments.delta', { item_id: part.id, output_index: idx, delta: part.delta });
    }
    if (part.type === 'tool-input-end') {
      const idx = this.idToIndex.get(part.id) ?? 1;
      const args = this.toolArguments.get(part.id) ?? '';
      const name = this.toolNames.get(part.id) ?? '';
      const item = { id: part.id, type: 'function_call', call_id: part.id, name, arguments: args, status: 'completed' };
      return sse('response.output_item.done', { output_index: idx, item });
    }

    if (part.type === 'finish') {
      return sse('response.completed', {
        response: {
          id, object: 'response', created_at: Math.floor(Date.now() / 1000), model, status: 'completed',
          stop_reason: encodeFinishReason(part.finishReason ?? null),
          usage: {
            input_tokens: part.usage?.inputTokens.total ?? 0,
            output_tokens: part.usage?.outputTokens.total ?? 0,
            total_tokens: (part.usage?.inputTokens.total ?? 0) + (part.usage?.outputTokens.total ?? 0),
          },
        },
      });
    }
    return null;
  }
}
