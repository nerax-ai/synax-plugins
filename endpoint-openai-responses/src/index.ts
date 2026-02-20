import type {
  LanguageRequest,
  LanguageResponse,
  LanguageStreamPart,
  LanguageMessage,
  LanguageToolCallContent,
  Endpoint,
  EndpointContext,
} from '@synax-ai/sdk';

// --- decode ---

function decodeInput(input: any): LanguageMessage[] {
  if (typeof input === 'string') {
    return [{ role: 'user', content: input }];
  }
  if (!Array.isArray(input)) return [];

  return input.map((item: any): LanguageMessage => {
    if (item.type === 'message' || item.role) {
      const content = item.content;
      if (typeof content === 'string') return { role: item.role, content } as LanguageMessage;
      if (Array.isArray(content)) {
        return {
          role: item.role,
          content: content.map((p: any) => {
            if (p.type === 'input_text' || p.type === 'output_text') return { type: 'text' as const, text: p.text };
            if (p.type === 'image_url') return { type: 'file' as const, data: new URL(p.image_url.url), mediaType: 'image/jpeg' };
            return { type: 'text' as const, text: '' };
          }),
        } as LanguageMessage;
      }
    }
    if (item.type === 'function_call') {
      return {
        role: 'assistant',
        content: [{ type: 'tool-call' as const, toolCallId: item.call_id, toolName: item.name, input: item.arguments }],
      };
    }
    if (item.type === 'function_call_output') {
      return {
        role: 'tool',
        content: [{ type: 'tool-result' as const, toolCallId: item.call_id, toolName: '', result: item.output ?? '' }],
      };
    }
    return { role: 'user', content: '' };
  });
}

function decodeRequest(body: any): LanguageRequest {
  return {
    model: body.model,
    messages: decodeInput(body.input),
    maxOutputTokens: body.max_output_tokens ?? undefined,
    temperature: body.temperature ?? undefined,
    topP: body.top_p ?? undefined,
    tools: body.tools,
    toolChoice: body.tool_choice,
  };
}

// --- encode non-streaming ---

function encodeFinishReason(r: string | null): string {
  if (r === 'tool-calls') return 'tool_calls';
  if (r === 'length') return 'max_output_tokens';
  return 'stop';
}

function encodeResponse(res: LanguageResponse, inputTokens: number): any {
  const choice = res.choices[0];
  const content = choice?.message?.content;
  const output: any[] = [];

  const textParts: string[] = [];
  const toolCalls: any[] = [];

  if (typeof content === 'string') {
    textParts.push(content);
  } else if (Array.isArray(content)) {
    for (const p of content) {
      if (p.type === 'text') textParts.push(p.text);
      else if (p.type === 'tool-call') {
        const tc = p as LanguageToolCallContent;
        toolCalls.push({ type: 'function_call', id: `fc_${tc.toolCallId}`, call_id: tc.toolCallId, name: tc.toolName, arguments: typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input) });
      }
    }
  }

  if (textParts.length) {
    output.push({ type: 'message', id: `msg_${res.id}`, role: 'assistant', content: [{ type: 'output_text', text: textParts.join('') }], status: 'completed' });
  }
  output.push(...toolCalls);

  return {
    id: res.id,
    object: 'response',
    created_at: res.created,
    model: res.model,
    output,
    status: 'completed',
    stop_reason: encodeFinishReason(choice?.finishReason ?? null),
    usage: res.usage ? {
      input_tokens: inputTokens,
      output_tokens: res.usage.outputTokens.total ?? 0,
      total_tokens: inputTokens + (res.usage.outputTokens.total ?? 0),
    } : undefined,
  };
}

// --- encode streaming ---

function encodeStreamPart(part: LanguageStreamPart, model: string, id: string): string | null {
  if (part.type === 'text-start') {
    const item = { id: `msg_${id}`, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '' }], status: 'in_progress' };
    return sse('response.output_item.added', { output_index: 0, item })
      + sse('response.output_text.delta', { item_id: `msg_${id}`, output_index: 0, content_index: 0, delta: '' });
  }
  if (part.type === 'text-end') {
    const item = { id: `msg_${id}`, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '' }], status: 'completed' };
    return sse('response.output_item.done', { output_index: 0, item });
  }
  if (part.type === 'text-delta') {
    return sse('response.output_text.delta', { item_id: `msg_${id}`, output_index: 0, content_index: 0, delta: part.delta });
  }
  if (part.type === 'tool-input-start') {
    return sse('response.function_call_arguments.delta', { item_id: part.id, output_index: 1, delta: '' });
  }
  if (part.type === 'tool-input-delta') {
    return sse('response.function_call_arguments.delta', { item_id: part.id, output_index: 1, delta: part.delta });
  }
  if (part.type === 'finish') {
    return sse('response.completed', {
      response: {
        id, object: 'response', created_at: Math.floor(Date.now() / 1000), model, status: 'completed',
        stop_reason: encodeFinishReason(part.finishReason ?? null),
        usage: { input_tokens: part.usage?.inputTokens.total ?? 0, output_tokens: part.usage?.outputTokens.total ?? 0 },
      },
    });
  }
  return null;
}

function sse(event: string, data: object): string {
  return `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`;
}

// --- endpoint ---

function createOpenAIResponsesEndpoint(options: Record<string, unknown>): Endpoint {
  const basePath = (options.basePath as string) ?? '/';
  return {
    basePath,
    registerRoutes(app: any, ctx: EndpointContext) {
      app.post('/v1/responses', async (c: any) => {
        const body = await c.req.json();
        const req = decodeRequest(body);

        if (body.stream) {
          const signal: AbortSignal = c.req.raw.signal;
          const stream = ctx.language.stream({ ...req, abortSignal: signal });
          const id = `resp_${Math.random().toString(36).slice(2)}`;

          return new Response(
            new ReadableStream({
              async start(controller) {
                const enc = new TextEncoder();
                controller.enqueue(enc.encode(sse('response.created', { response: { id, object: 'response', created_at: Math.floor(Date.now() / 1000), model: req.model, status: 'in_progress' } })));
                try {
                  for await (const part of stream) {
                    if (signal.aborted) break;
                    if (part.type === 'response-metadata') continue;
                    const line = encodeStreamPart(part, req.model, id);
                    if (line) controller.enqueue(enc.encode(line));
                  }
                  controller.close();
                } catch (e: any) {
                  const status = e?.statusCode ?? e?.status ?? 500;
                  console.error(`[openai-responses] stream error ${status}: ${e?.message ?? e}`);
                  controller.close();
                }
              },
            }),
            { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' } },
          );
        }

        const res = await ctx.language.generate(req);
        return c.json(encodeResponse(res, res.usage?.inputTokens.total ?? 0));
      });

      app.get('/v1/models', (c: any) => {
        const models = ctx.models();
        return c.json({
          object: 'list',
          data: models.map((m) => ({ id: m.id, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: m.ownedBy ?? 'synax' })),
        });
      });
    },
  };
}

// --- plugin ---

export function setup(ctx: { register(type: 'endpoint', id: string, factory: (options: Record<string, unknown>) => Endpoint): void }) {
  ctx.register('endpoint', 'openai-responses', createOpenAIResponsesEndpoint);
}
