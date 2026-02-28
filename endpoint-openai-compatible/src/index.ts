import type {
  LanguageRequest,
  LanguageResponse,
  LanguageStreamPart,
  LanguageMessage,
  LanguageToolCallContent,
  Endpoint,
  EndpointContext,
} from '@synax-ai/sdk';

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
export interface OpenAIMessage {
  role: string;
  content?: string | any[];
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
}
export interface OpenAIRequest {
  model: string;
  messages?: OpenAIMessage[];
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  tools?: any[];
  tool_choice?: any;
  seed?: number;
  stream?: boolean;
}

// --- decode ---

function decodeMessages(messages: OpenAIMessage[]): LanguageMessage[] {
  return messages.map((m): LanguageMessage => {
    if (m.role === 'tool') {
      return {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: m.tool_call_id ?? '', toolName: m.name ?? '', result: typeof m.content === 'string' ? { type: 'text', value: m.content } : { type: 'text', value: m.content ? JSON.stringify(m.content) : '' } }],
      };
    }
    if (m.role === 'assistant' && m.tool_calls) {
      return {
        role: 'assistant',
        content: m.tool_calls.map((tc: any): LanguageToolCallContent => ({
          type: 'tool-call',
          toolCallId: tc.id,
          toolName: tc.function.name,
          input: tc.function.arguments,
        })),
      };
    }
    return { role: m.role, content: m.content ?? '' } as LanguageMessage;
  });
}

function decodeRequest(body: Partial<OpenAIRequest>): LanguageRequest {
  return {
    model: body.model ?? '',
    messages: decodeMessages(body.messages ?? []),
    maxOutputTokens: body.max_tokens ?? body.max_completion_tokens,
    temperature: body.temperature ?? undefined,
    topP: body.top_p ?? undefined,
    stopSequences: body.stop ? (Array.isArray(body.stop) ? body.stop : [body.stop]) : undefined,
    tools: body.tools,
    toolChoice: body.tool_choice,
    seed: body.seed ?? undefined,
  };
}

// --- encode non-streaming ---

function encodeResponse(res: LanguageResponse): any {
  const choice = res.choices[0];
  const content = choice?.message?.content;
  const toolCalls = Array.isArray(content)
    ? content.filter((p): p is LanguageToolCallContent => p.type === 'tool-call').map((p) => ({
        id: p.toolCallId,
        type: 'function',
        function: { name: p.toolName, arguments: typeof p.input === 'string' ? p.input : JSON.stringify(p.input) },
      }))
    : undefined;

  return {
    id: res.id,
    object: 'chat.completion',
    created: res.created,
    model: res.model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: typeof content === 'string' ? content : null,
        tool_calls: toolCalls?.length ? toolCalls : undefined,
      },
      finish_reason: choice?.finishReason ?? 'stop',
    }],
    usage: res.usage ? {
      prompt_tokens: res.usage.inputTokens.total,
      completion_tokens: res.usage.outputTokens.total,
      total_tokens: (res.usage.inputTokens.total ?? 0) + (res.usage.outputTokens.total ?? 0),
    } : undefined,
  };
}

// --- encode streaming ---

function encodeStreamPart(part: LanguageStreamPart, model: string, id: string): string | null {
  const chunk = (delta: any, finish_reason: string | null = null) =>
    `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`;

  if (part.type === 'text-delta') return chunk({ content: part.delta });
  if (part.type === 'tool-input-start') return chunk({ tool_calls: [{ index: 0, id: part.id, type: 'function', function: { name: part.toolName, arguments: '' } }] });
  if (part.type === 'tool-input-delta') return chunk({ tool_calls: [{ index: 0, function: { arguments: part.delta } }] });
  if (part.type === 'finish') return chunk({}, part.finishReason ?? 'stop');
  return null;
}

// --- endpoint ---

function createOpenAIEndpoint(options: Record<string, unknown>): Endpoint {
  const basePath = (options.basePath as string) ?? '/';
  return {
    basePath,
    registerRoutes(app: any, ctx: EndpointContext) {
      app.post('/v1/chat/completions', async (c: any) => {
        const body = await c.req.json();
        const req = decodeRequest(body);

        if (body.stream) {
          const signal: AbortSignal = c.req.raw.signal;
          const stream = ctx.language.stream({ ...req, abortSignal: signal });
          const id = `chatcmpl-${Math.random().toString(36).slice(2)}`;
          const model = req.model;

          return new Response(
            new ReadableStream({
              async start(controller) {
                const enc = new TextEncoder();
                try {
                  for await (const part of stream) {
                    if (signal.aborted) break;
                    const line = encodeStreamPart(part, model, id);
                    if (line) controller.enqueue(enc.encode(line));
                  }
                  controller.enqueue(enc.encode('data: [DONE]\n\n'));
                  controller.close();
                } catch (e: any) {
                  if (e?.name === 'AbortError') {
                    controller.close();
                    return;
                  }
                  const status = e?.statusCode ?? e?.status ?? 500;
                  ctx.logger.error(`stream error ${status}: ${e?.message ?? e}`);
                  controller.close();
                }
              },
            }),
            { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' } },
          );
        }

        const res = await ctx.language.generate(req);
        return c.json(encodeResponse(res));
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
  ctx.register('endpoint', 'openai-compatible', createOpenAIEndpoint);
}
