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

// --- Types ---

export interface InputTextContent {
  type: 'input_text';
  text: string;
}

export interface InputImageContent {
  type: 'input_image';
  image_url: string;
}

export interface OutputTextContent {
  type: 'output_text';
  text: string;
}

export type MessageContent = InputTextContent | InputImageContent | OutputTextContent | Record<string, unknown>;

export interface InputMessage {
  type?: 'message';
  role?: 'developer' | 'user' | 'assistant' | 'system';
  content?: string | MessageContent[];
}

export interface FunctionCallMessage {
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
}

export interface FunctionCallOutput {
  type: 'function_call_output';
  call_id: string;
  output: string;
}

export type RequestInput = InputMessage | FunctionCallMessage | FunctionCallOutput | string;

export interface ToolFunction {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
}

export interface Tool {
  type: 'function';
  function: ToolFunction;
}

export interface ResponsesRequest {
  model: string;
  input?: RequestInput[];
  instructions?: string;
  tools?: Tool[];
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
  stream?: boolean;
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  seed?: number;
  // Extended fields (Codex/Responses API)
  reasoning?: unknown;
  store?: boolean;
  include?: string[];
  prompt_cache_key?: string;
  parallel_tool_calls?: boolean;
}

// --- decode ---

function decodeContent(content: string | MessageContent[]): any[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  if (!Array.isArray(content)) {
    return [{ type: 'text', text: '' }];
  }

  return content.map((p: any): any => {
    if (p.type === 'input_text' || p.type === 'output_text') {
      return { type: 'text', text: p.text };
    }
    if (p.type === 'image_url') {
      return { type: 'file', data: new URL(p.image_url?.url ?? p.image_url), mediaType: 'image/jpeg' };
    }
    if (p.type === 'input_image') {
      return { type: 'file', data: new URL(p.image_url), mediaType: 'image/jpeg' };
    }
    return p;
  });
}

function decodeInput(input: RequestInput[] | string | undefined, instructions?: string): LanguageMessage[] {
  if (!input) return instructions ? [{ role: 'system', content: instructions }] : [];
  if (typeof input === 'string') {
    const messages: LanguageMessage[] = [];
    if (instructions) messages.push({ role: 'system', content: instructions });
    messages.push({ role: 'user', content: input });
    return messages;
  }
  if (!Array.isArray(input)) return [];

  const messages: LanguageMessage[] = [];

  // Add instructions as system message if present
  if (instructions) {
    messages.push({ role: 'system', content: instructions });
  }

  for (const item of input) {
    const { type, role, content, call_id, name, arguments: args, output } = item as any;

    // Handle role-based messages
    if (type === 'message' || role) {
      // Map 'developer' role to 'system' for compatibility
      const normalizedRole = role === 'developer' ? 'system' : role;

      if (typeof content === 'string') {
        messages.push({ role: normalizedRole, content } as LanguageMessage);
      } else if (Array.isArray(content)) {
        messages.push({
          role: normalizedRole,
          content: decodeContent(content),
        } as LanguageMessage);
      }
      continue;
    }

    // Handle function calls
    if (type === 'function_call') {
      messages.push({
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: call_id, toolName: name, input: args }],
      });
      continue;
    }

    // Handle function outputs
    if (type === 'function_call_output') {
      messages.push({
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: call_id, toolName: '', result: output ?? '' }],
      });
      continue;
    }

    // Fallback
    messages.push({ role: 'user', content: '' });
  }

  return messages;
}

function decodeTools(tools: any[] | undefined): LanguageTool[] | undefined {
  if (!tools) return undefined;

  return tools.map((tool): LanguageTool => {
    // Handle OpenAI format: { type: 'function', function: { name, parameters, ... } }
    if (tool.function && typeof tool.function === 'object') {
      return {
        type: 'function',
        name: tool.function.name ?? '',
        description: tool.function.description ?? '',
        inputSchema: tool.function.parameters ?? tool.function.input_schema ?? { type: 'object', properties: {} },
      };
    }
    // Handle direct format: { name, description, inputSchema/parameters, ... }
    return {
      type: tool.type ?? 'function',
      name: tool.name ?? '',
      description: tool.description ?? '',
      inputSchema: tool.inputSchema ?? tool.parameters ?? tool.input_schema ?? { type: 'object', properties: {} },
    };
  });
}

function decodeToolChoice(toolChoice: any): LanguageRequest['toolChoice'] {
  if (!toolChoice) return undefined;
  if (typeof toolChoice === 'string') return toolChoice;
  if (typeof toolChoice === 'object' && toolChoice.type === 'function' && toolChoice.function?.name) {
    return { type: 'function', function: { name: toolChoice.function.name } };
  }
  return undefined;
}

function decodeRequest(body: ResponsesRequest): LanguageRequest {
  return {
    model: body.model,
    messages: decodeInput(body.input, body.instructions),
    maxOutputTokens: body.max_output_tokens,
    temperature: body.temperature,
    topP: body.top_p,
    topK: body.top_k,
    frequencyPenalty: body.frequency_penalty,
    presencePenalty: body.presence_penalty,
    seed: body.seed,
    tools: decodeTools(body.tools),
    toolChoice: decodeToolChoice(body.tool_choice),
    // Pass through extended fields
    ...(body.parallel_tool_calls !== undefined && { parallelToolCalls: body.parallel_tool_calls }),
    ...(body.reasoning !== undefined && { reasoning: body.reasoning }),
  };
}

// --- encode non-streaming ---

function encodeFinishReason(r: string | null): string {
  if (r === 'tool-calls') return 'tool_calls';
  if (r === 'length') return 'max_output_tokens';
  return 'stop';
}

function encodeResponse(res: LanguageResponse, inputTokens: number): Record<string, unknown> {
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
        const reasoning = (p as any).reasoning;
        if (Array.isArray(reasoning)) {
          reasoningContent = reasoning.map((r: any) => r.text ?? '').join('');
        } else if (typeof reasoning === 'string') {
          reasoningContent = reasoning;
        }
      } else if (p.type === 'tool-call') {
        const tc = p as LanguageToolCallContent;
        toolCalls.push({
          type: 'function_call',
          id: `fc_${tc.toolCallId}`,
          call_id: tc.toolCallId,
          name: tc.toolName,
          arguments: typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input),
        });
      }
    }
  }

  // Order: reasoning -> message -> function_calls
  if (reasoningContent) {
    output.push({ type: 'reasoning', id: `rs_${res.id}`, encrypted_content: reasoningContent, status: 'completed' });
  }
  if (textParts.length) {
    output.push({
      type: 'message',
      id: `msg_${res.id}`,
      role: 'assistant',
      content: [{ type: 'output_text', text: textParts.join('') }],
      status: 'completed',
    });
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
    usage: res.usage
      ? {
          input_tokens: inputTokens,
          output_tokens: res.usage.outputTokens.total ?? 0,
          total_tokens: inputTokens + (res.usage.outputTokens.total ?? 0),
        }
      : undefined,
  };
}

// --- encode streaming ---

function sse(event: string, data: object): string {
  return `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`;
}

class StreamEncoder {
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

    // --- Reasoning ---
    if (part.type === 'reasoning-start') {
      const idx = this.getOutputIndex(part.id);
      const item = { id: part.id, type: 'reasoning', encrypted_content: '', status: 'in_progress' };
      return sse('response.output_item.added', { output_index: idx, item });
    }
    if (part.type === 'reasoning-delta') {
      // OpenAI Responses API doesn't expose reasoning deltas
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
      const msgId = part.id;
      const phase = (part.providerMetadata as any)?.openai?.phase;
      const item: any = {
        id: msgId,
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: '' }],
        status: 'in_progress',
      };
      if (phase) item.phase = phase;
      return (
        sse('response.output_item.added', { output_index: idx, item }) +
        sse('response.content_part.added', {
          item_id: msgId,
          output_index: idx,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [], logprobs: [] },
        })
      );
    }
    if (part.type === 'text-end') {
      const idx = this.idToIndex.get(part.id) ?? 0;
      const msgId = part.id;
      const phase = (part.providerMetadata as any)?.openai?.phase;
      const item: any = {
        id: msgId,
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: '' }],
        status: 'completed',
      };
      if (phase) item.phase = phase;
      return (
        sse('response.content_part.done', {
          item_id: msgId,
          output_index: idx,
          content_index: 0,
          part: { type: 'output_text', text: '' },
        }) + sse('response.output_item.done', { output_index: idx, item })
      );
    }
    if (part.type === 'text-delta') {
      const idx = this.idToIndex.get(part.id) ?? 0;
      const msgId = part.id;
      return sse('response.output_text.delta', { item_id: msgId, output_index: idx, content_index: 0, delta: part.delta });
    }

    // --- Tool calls ---
    if (part.type === 'tool-input-start') {
      const idx = this.getOutputIndex(part.id);
      this.toolNames.set(part.id, part.toolName);
      const item = {
        id: part.id,
        type: 'function_call',
        call_id: part.id,
        name: part.toolName,
        arguments: '',
        status: 'in_progress',
      };
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
      const item = {
        id: part.id,
        type: 'function_call',
        call_id: part.id,
        name,
        arguments: args,
        status: 'completed',
      };
      return sse('response.output_item.done', { output_index: idx, item });
    }

    // --- Finish ---
    if (part.type === 'finish') {
      return sse('response.completed', {
        response: {
          id,
          object: 'response',
          created_at: Math.floor(Date.now() / 1000),
          model,
          status: 'completed',
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

// --- endpoint ---

function createOpenAIResponsesEndpoint(options: Record<string, unknown>): Endpoint {
  const basePath = (options.basePath as string) ?? '/';
  return {
    basePath,
    registerRoutes(app: any, ctx: EndpointContext) {
      const log = ctx.logger;

      app.post('/v1/responses', async (c: any) => {
        const body = await c.req.json() as ResponsesRequest;
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
                controller.enqueue(
                  enc.encode(
                    sse('response.created', {
                      response: {
                        id,
                        object: 'response',
                        created_at: Math.floor(Date.now() / 1000),
                        model: req.model,
                        status: 'in_progress',
                      },
                    })
                  )
                );
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
            {
              headers: {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive',
                'X-Accel-Buffering': 'no',
              },
            }
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
          data: models.map((m) => ({
            id: m.id,
            object: 'model',
            created: Math.floor(Date.now() / 1000),
            owned_by: m.ownedBy ?? 'synax',
          })),
        });
      });
    },
  };
}

// --- plugin ---

export function setup(ctx: { register(type: 'endpoint', id: string, factory: (options: Record<string, unknown>) => Endpoint): void }) {
  ctx.register('endpoint', 'openai-responses', createOpenAIResponsesEndpoint);
}
