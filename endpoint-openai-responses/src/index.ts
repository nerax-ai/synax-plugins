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
  if (typeof input === 'string') return [{ role: 'user', content: input }];
  if (!Array.isArray(input)) return [];

  return input.map((item: any): LanguageMessage => {
    const { type, role, content, call_id, name, arguments: args, output } = item;
    // Map 'developer' role (Anthropic) to 'system' for OpenAI compatibility
    const normalizedRole = role === 'developer' ? 'system' : role;
    if (type === 'message' || role) {
      if (typeof content === 'string') return { role: normalizedRole, content } as LanguageMessage;
      if (Array.isArray(content)) {
        return {
          role: normalizedRole,
          content: content.map((p: any) =>
            (p.type === 'input_text' || p.type === 'output_text') ? { type: 'text', text: p.text } :
            (p.type === 'image_url') ? { type: 'file', data: new URL(p.image_url.url), mediaType: 'image/jpeg' } :
            { type: 'text', text: '' }
          ),
        } as LanguageMessage;
      }
    }
    if (type === 'function_call') return { role: 'assistant', content: [{ type: 'tool-call', toolCallId: call_id, toolName: name, input: args }] };
    if (type === 'function_call_output') return { role: 'tool', content: [{ type: 'tool-result', toolCallId: call_id, toolName: '', result: output ?? '' }] };
    return { role: 'user', content: '' };
  });
}

function decodeRequest(body: any): LanguageRequest {
  // Convert tools parameters schema (OpenAI format) to inputSchema (Synax format)
  const tools = body.tools?.map((tool: any) => {
    if (tool.parameters && !tool.inputSchema) {
      return { ...tool, inputSchema: tool.parameters };
    }
    return tool;
  });

  return {
    model: body.model,
    messages: decodeInput(body.input),
    maxOutputTokens: body.max_output_tokens ?? undefined,
    temperature: body.temperature ?? undefined,
    topP: body.top_p ?? undefined,
    tools,
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
  let reasoningContent = '';

  if (typeof content === 'string') {
    textParts.push(content);
  } else if (Array.isArray(content)) {
    for (const p of content) {
      if (p.type === 'text') textParts.push(p.text);
      else if (p.type === 'reasoning') {
        // Extract reasoning text from the reasoning object
        const reasoning = (p as any).reasoning;
        if (Array.isArray(reasoning)) {
          reasoningContent = reasoning.map((r: any) => r.text ?? '').join('');
        } else if (typeof reasoning === 'string') {
          reasoningContent = reasoning;
        }
      }
      else if (p.type === 'tool-call') {
        const tc = p as LanguageToolCallContent;
        toolCalls.push({ type: 'function_call', id: `fc_${tc.toolCallId}`, call_id: tc.toolCallId, name: tc.toolName, arguments: typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input) });
      }
    }
  }

  // Add reasoning output first (OpenAI Responses API order: reasoning -> message -> function_calls)
  if (reasoningContent) {
    output.push({ type: 'reasoning', id: `rs_${res.id}`, encrypted_content: reasoningContent, status: 'completed' });
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

class StreamEncoder {
  private outputIndex = 0;
  private idToIndex = new Map<string, number>();
  private toolArguments = new Map<string, string>();

  private getOutputIndex(id: string): number {
    let idx = this.idToIndex.get(id);
    if (idx === undefined) {
      idx = this.outputIndex++;
      this.idToIndex.set(id, idx);
    }
    return idx;
  }

  encode(part: LanguageStreamPart, model: string, id: string): string | null {
    // Handle stream-start: already emitted in route handler
    if (part.type === 'stream-start') return null;

    // --- Reasoning (encrypted content in OpenAI Responses API) ---
    if (part.type === 'reasoning-start') {
      const idx = this.getOutputIndex(part.id);
      const item = { id: part.id, type: 'reasoning', encrypted_content: '', status: 'in_progress' };
      return sse('response.output_item.added', { output_index: idx, item });
    }
    if (part.type === 'reasoning-delta') {
      const idx = this.idToIndex.get(part.id) ?? 0;
      // OpenAI Responses API doesn't expose reasoning deltas, so we skip
      // but we track the index for proper ordering
      return null;
    }
    if (part.type === 'reasoning-end') {
      const idx = this.idToIndex.get(part.id) ?? 0;
      const item = { id: part.id, type: 'reasoning', status: 'completed' };
      return sse('response.output_item.done', { output_index: idx, item });
    }

    // --- Text ---
    if (part.type === 'text-start') {
      const idx = this.getOutputIndex(part.id);
      const item = { id: `msg_${id}`, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '' }], status: 'in_progress' };
      return sse('response.output_item.added', { output_index: idx, item })
        + sse('response.content_part.added', { item_id: `msg_${id}`, output_index: idx, content_index: 0, part: { type: 'output_text', text: '', annotations: [], logprobs: [] } });
    }
    if (part.type === 'text-end') {
      const idx = this.idToIndex.get(part.id) ?? 0;
      const item = { id: `msg_${id}`, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '' }], status: 'completed' };
      return sse('response.content_part.done', { item_id: `msg_${id}`, output_index: idx, content_index: 0, part: { type: 'output_text', text: '' } })
        + sse('response.output_item.done', { output_index: idx, item });
    }
    if (part.type === 'text-delta') {
      const idx = this.idToIndex.get(part.id) ?? 0;
      return sse('response.output_text.delta', { item_id: `msg_${id}`, output_index: idx, content_index: 0, delta: part.delta });
    }

    // --- Tool calls ---
    if (part.type === 'tool-input-start') {
      const idx = this.getOutputIndex(part.id);
      const item = { id: part.id, type: 'function_call', name: part.toolName, arguments: '', status: 'in_progress' };
      return sse('response.output_item.added', { output_index: idx, item });
    }
    if (part.type === 'tool-input-delta') {
      const idx = this.idToIndex.get(part.id) ?? 0;
      // Accumulate arguments for this tool call
      const current = this.toolArguments.get(part.id) ?? '';
      this.toolArguments.set(part.id, current + part.delta);
      return sse('response.function_call_arguments.delta', { item_id: part.id, output_index: idx, delta: part.delta });
    }
    if (part.type === 'tool-input-end') {
      const idx = this.idToIndex.get(part.id) ?? 0;
      const arguments = this.toolArguments.get(part.id) ?? '';
      const item = { id: part.id, type: 'function_call', arguments, status: 'completed' };
      return sse('response.output_item.done', { output_index: idx, item });
    }

    // --- Finish ---
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

function sse(event: string, data: object): string {
  return `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`;
}

// --- endpoint ---

function createOpenAIResponsesEndpoint(options: Record<string, unknown>): Endpoint {
  const basePath = (options.basePath as string) ?? '/';
  return {
    basePath,
    registerRoutes(app: any, ctx: EndpointContext) {
      const log = ctx.logger;

      app.post('/v1/responses', async (c: any) => {
        const body = await c.req.json();
        log.debug(`[openai-responses] Request:\n${JSON.stringify(body, null, 2)}`);
        const req = decodeRequest(body);

        if (body.stream) {
          const signal: AbortSignal = c.req.raw.signal;
          const stream = ctx.language.stream({ ...req, abortSignal: signal });
          const id = `resp_${Math.random().toString(36).slice(2)}`;
          const encoder = new StreamEncoder();

          return new Response(
            new ReadableStream({
              async start(controller) {
                const enc = new TextEncoder();
                controller.enqueue(enc.encode(sse('response.created', { response: { id, object: 'response', created_at: Math.floor(Date.now() / 1000), model: req.model, status: 'in_progress' } })));
                try {
                  for await (const part of stream) {
                    if (signal.aborted) break;
                    log.debug(`[openai-responses] Stream part: ${JSON.stringify(part)}`);
                    if (part.type === 'response-metadata') continue;
                    const line = encoder.encode(part, req.model, id);
                    if (line) {
                      log.debug(`[openai-responses] SSE: ${line.trim()}`);
                      controller.enqueue(enc.encode(line));
                    }
                  }
                  log.debug(`[openai-responses] Stream completed`);
                  controller.close();
                } catch (e: any) {
                  const status = e?.statusCode ?? e?.status ?? 500;
                  log.error(`[openai-responses] stream error ${status}: ${e?.message ?? e}`);
                  controller.close();
                }
              },
            }),
            { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' } },
          );
        }

        const res = await ctx.language.generate(req);
        const encoded = encodeResponse(res, res.usage?.inputTokens.total ?? 0);
        log.debug(`[openai-responses] Response:\n${JSON.stringify(encoded, null, 2)}`);
        return c.json(encoded);
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
