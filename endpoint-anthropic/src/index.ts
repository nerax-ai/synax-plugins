import type {
  LanguageRequest,
  LanguageResponse,
  LanguageStreamPart,
  LanguageMessage,
  LanguageToolCallContent,
  LanguageTool,
  Endpoint,
  EndpointContext,
} from '@synax-ai/sdk';

// --- decode ---

function decodeMessages(messages: any[]): LanguageMessage[] {
  const missingIds = new Map<string, string>(); // `${msgIdx}:${blockIdx}` -> uuid
  const toolResultIds = new Map<string, string>(); // `${msgIdx}:${resultIdx}` -> id
  const toolNameMap = new Map<string, string>();
  let lastAssIdx = -1;

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'assistant') {
      lastAssIdx = i;
      if (Array.isArray(m.content)) {
        let bi = 0;
        for (const p of m.content) {
          if (p.type === 'tool_use') {
            const id = p.id ?? crypto.randomUUID();
            if (!p.id) missingIds.set(`${i}:${bi}`, id);
            if (p.name) toolNameMap.set(id, p.name);
            bi++;
          }
        }
      }
    } else if (m.role === 'user' && Array.isArray(m.content)) {
      let ri = 0;
      for (const p of m.content) {
        if (p.type === 'tool_result') {
          if (!p.tool_use_id && lastAssIdx >= 0) {
            toolResultIds.set(`${i}:${ri}`, missingIds.get(`${lastAssIdx}:${ri}`) ?? crypto.randomUUID());
          }
          ri++;
        }
      }
    }
  }

  return messages.map((m, i): LanguageMessage => {
    if (m.role === 'system') return { role: 'system', content: m.content };
    if (m.role === 'user') {
      if (!Array.isArray(m.content)) return { role: 'user', content: m.content ?? '' };
      const toolResults = m.content.filter((p: any) => p.type === 'tool_result');
      if (toolResults.length) {
        return {
          role: 'tool',
          content: toolResults.map((p: any, ri: number) => {
            const id = p.tool_use_id ?? toolResultIds.get(`${i}:${ri}`) ?? crypto.randomUUID();
            return {
              type: 'tool-result',
              toolCallId: id,
              toolName: toolNameMap.get(id) ?? id,
              result: Array.isArray(p.content) ? p.content.map((c: any) => c.text).join('') : (p.content ?? ''),
              isError: p.is_error ?? false,
            };
          }),
        };
      }
      return {
        role: 'user',
        content: m.content.map((p: any) => {
          if (p.type === 'text') return { type: 'text', text: p.text };
          if (p.type === 'image') return { type: 'file', data: p.source.url ?? p.source.data, mediaType: p.source.media_type ?? 'image/jpeg' };
          return { type: 'text', text: '' };
        }),
      } as LanguageMessage;
    }
    if (m.role === 'assistant') {
      if (!Array.isArray(m.content)) return { role: 'assistant', content: m.content ?? '' };
      let bi = 0;
      return {
        role: 'assistant',
        content: m.content.map((p: any) => {
          if (p.type === 'text') return { type: 'text', text: p.text };
          if (p.type === 'tool_use') {
            const id = p.id ?? missingIds.get(`${i}:${bi++}`) ?? crypto.randomUUID();
            return { type: 'tool-call', toolCallId: id, toolName: p.name, input: p.input };
          }
          return { type: 'text', text: '' };
        }),
      } as LanguageMessage;
    }
    return { role: 'user', content: '' };
  });
}

function decodeRequest(body: any): LanguageRequest {
  const messages: any[] = body.messages ?? [];
  const systemContent = Array.isArray(body.system)
    ? body.system.map((p: any) => p.text).join('\n')
    : body.system;
  const allMessages = systemContent
    ? [{ role: 'system', content: systemContent }, ...messages]
    : messages;
  return {
    model: body.model,
    messages: decodeMessages(allMessages),
    maxOutputTokens: body.max_tokens,
    temperature: body.temperature ?? undefined,
    topP: body.top_p ?? undefined,
    topK: body.top_k ?? undefined,
    stopSequences: body.stop_sequences ?? undefined,
    tools: body.tools?.map((t: any) => ({ 
      type: 'function',
      name: t.name, 
      description: t.description, 
      inputSchema: t.input_schema // This is a JSON Schema
    }) as LanguageTool),
    toolChoice: body.tool_choice,
  };
}

// --- encode non-streaming ---

function encodeFinishReason(r: string | null): string {
  if (r === 'tool-calls') return 'tool_use';
  if (r === 'length') return 'max_tokens';
  return 'end_turn';
}

function encodeResponse(res: LanguageResponse): any {
  const choice = res.choices[0];
  const content = choice?.message?.content;
  const blocks: any[] = [];

  if (typeof content === 'string') {
    blocks.push({ type: 'text', text: content });
  } else if (Array.isArray(content)) {
    for (const p of content) {
      if (p.type === 'text') blocks.push({ type: 'text', text: p.text });
      else if (p.type === 'reasoning') {
        // Convert reasoning to Anthropic's "thinking" block format
        const reasoning = (p as any).reasoning;
        let thinkingText = '';
        if (Array.isArray(reasoning)) {
          thinkingText = reasoning.map((r: any) => r.text ?? '').join('');
        } else if (typeof reasoning === 'string') {
          thinkingText = reasoning;
        }
        blocks.push({ type: 'thinking', thinking: thinkingText });
      }
      else if (p.type === 'tool-call') {
        const tc = p as LanguageToolCallContent;
        blocks.push({ type: 'tool_use', id: tc.toolCallId, name: tc.toolName, input: typeof tc.input === 'string' ? JSON.parse(tc.input) : tc.input });
      }
    }
  }

  return {
    id: res.id,
    type: 'message',
    role: 'assistant',
    model: res.model,
    content: blocks,
    stop_reason: encodeFinishReason(choice?.finishReason ?? null),
    usage: res.usage ? {
      input_tokens: res.usage.inputTokens.total ?? 0,
      output_tokens: res.usage.outputTokens.total ?? 0,
    } : undefined,
  };
}

// --- encode streaming ---

function event(type: string, data: object): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

class StreamEncoder {
  private blockIndex = 0;
  private idToIndex = new Map<string, number>();

  private getIndex(id: string): number {
    let idx = this.idToIndex.get(id);
    if (idx === undefined) {
      idx = this.blockIndex++;
      this.idToIndex.set(id, idx);
    }
    return idx;
  }

  encode(part: LanguageStreamPart, _model: string, _id: string): string | null {
    if (part.type === 'stream-start') return null;

    // --- Reasoning (Anthropic calls this "thinking") ---
    if (part.type === 'reasoning-start') {
      const idx = this.getIndex(part.id);
      return event('content_block_start', { index: idx, content_block: { type: 'thinking', thinking: '' } });
    }
    if (part.type === 'reasoning-delta') {
      const idx = this.idToIndex.get(part.id) ?? 0;
      return event('content_block_delta', { index: idx, delta: { type: 'thinking_delta', thinking: part.delta } });
    }
    if (part.type === 'reasoning-end') {
      const idx = this.idToIndex.get(part.id) ?? 0;
      return event('content_block_stop', { index: idx });
    }

    // --- Text ---
    if (part.type === 'text-start') {
      const idx = this.getIndex(part.id);
      return event('content_block_start', { index: idx, content_block: { type: 'text', text: '' } });
    }
    if (part.type === 'text-delta') {
      const idx = this.idToIndex.get(part.id) ?? 0;
      return event('content_block_delta', { index: idx, delta: { type: 'text_delta', text: part.delta } });
    }
    if (part.type === 'text-end') {
      const idx = this.idToIndex.get(part.id) ?? 0;
      return event('content_block_stop', { index: idx });
    }

    // --- Tool calls ---
    if (part.type === 'tool-input-start') {
      const idx = this.getIndex(part.id);
      return event('content_block_start', { index: idx, content_block: { type: 'tool_use', id: part.id, name: part.toolName, input: {} } });
    }
    if (part.type === 'tool-input-delta') {
      const idx = this.idToIndex.get(part.id) ?? 0;
      return event('content_block_delta', { index: idx, delta: { type: 'input_json_delta', partial_json: part.delta } });
    }
    if (part.type === 'tool-input-end') {
      const idx = this.idToIndex.get(part.id) ?? 0;
      return event('content_block_stop', { index: idx });
    }

    // --- Finish ---
    if (part.type === 'finish') {
      const delta = event('message_delta', { delta: { stop_reason: encodeFinishReason(part.finishReason ?? null) }, usage: { output_tokens: part.usage?.outputTokens.total ?? 0 } });
      return delta + event('message_stop', {});
    }
    return null;
  }
}

// --- endpoint ---

function createAnthropicEndpoint(options: Record<string, unknown>): Endpoint {
  const basePath = (options.basePath as string) ?? '/';
  return {
    basePath,
    registerRoutes(app: any, ctx: EndpointContext) {
      app.post('/v1/messages', async (c: any) => {
        try {
          const body = await c.req.json();
          const req = decodeRequest(body);

          if (body.stream) {
            const signal: AbortSignal = c.req.raw.signal;
            const stream = ctx.language.stream({ ...req, abortSignal: signal });
            const id = `msg_${Math.random().toString(36).slice(2)}`;
            const encoder = new StreamEncoder();

            return new Response(
              new ReadableStream({
                async start(controller) {
                  const enc = new TextEncoder();
                  controller.enqueue(enc.encode(event('message_start', { message: { id, type: 'message', role: 'assistant', content: [], model: req.model, stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } })));
                  let closed = false;
                  try {
                    for await (const part of stream) {
                      if (signal.aborted) {
                        closed = true;
                        break;
                      }
                      if (part.type === 'response-metadata') continue;
                      const line = encoder.encode(part, req.model, id);
                      if (line) controller.enqueue(enc.encode(line));
                    }
                    if (!closed) {
                      controller.close();
                      closed = true;
                    }
                  } catch (e: any) {
                    const status = e?.statusCode ?? e?.status ?? 500;
                    const msg = e?.message ?? String(e);
                    console.error(`[anthropic] stream error ${status}: ${msg}`);
                    if (!closed) {
                      try { controller.close(); } catch {}
                      closed = true;
                    }
                  }

              },
            }),
            { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' } },
          );
        }

        const res = await ctx.language.generate(req);
        return c.json(encodeResponse(res));
      } catch (e: any) {
        console.error('[anthropic] error:', e?.message, e?.cause?.message ?? '', e?.errors ? JSON.stringify(e.errors.map((x: any) => x.error?.message)) : '');
        return c.text(e?.message ?? 'Internal Server Error', 500);
      }

      });

      app.get('/v1/models', (c: any) => {
        const models = ctx.models();
        return c.json({
          data: models.map((m) => ({ id: m.id, display_name: m.id, created_at: new Date(0).toISOString() })),
        });
      });
    },
  };
}

// --- plugin ---

const schema = {
  fields: [
    { name: 'basePath', type: 'string', description: 'Base path for the endpoint', default: '/' }
  ]
};

export function setup(ctx: { register(type: 'endpoint', id: string, factory: (options: Record<string, unknown>) => Endpoint, options?: { schema?: unknown }): void }) {
  ctx.register('endpoint', 'anthropic', createAnthropicEndpoint, { schema });
}
