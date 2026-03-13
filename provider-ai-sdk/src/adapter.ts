import type { AiSdkCore } from './loader';
import type {
  LanguageRequest,
  LanguageResponse,
  LanguageStreamPart,
  LanguageMessage,
  LanguageTool,
  FinishReason,
  LanguageTokenUsage,
  LanguageMessagePart,
  Logger,
} from '@synax-ai/sdk';

function toSystem(messages: LanguageMessage[]): string | undefined {
  const parts = messages
    .filter(m => m.role === 'system')
    .map(m => typeof m.content === 'string' ? m.content : (m.content as any[]).map((p: any) => p.text).join('\n\n'));
  return parts.length ? parts.join('\n\n') : undefined;
}

function toMessages(messages: LanguageMessage[]): unknown[] {
  return messages.filter(m => m.role !== 'system').flatMap((msg): unknown[] => {
    if (msg.role === 'user' || msg.role === 'assistant') {
      if (typeof msg.content === 'string') {
        return [{ role: msg.role, content: msg.content }];
      }
      if (Array.isArray(msg.content)) {
        return [{
          role: msg.role,
          content: msg.content.map(part => {
            if (part.type === 'tool-call') {
              let input = part.input;
              if (typeof input === 'string') {
                try {
                  input = JSON.parse(input);
                } catch {
                  // Keep as string if not valid JSON
                }
              }
              return { ...part, input };
            }
            return part;
          }),
        }];
      }
      return [{ role: msg.role, content: msg.content }];
    }

    if (msg.role === 'tool') {
      if (!Array.isArray(msg.content)) return [{ role: 'tool', content: msg.content }];
      // Map each tool-result: Synax `result` → AI SDK `output`
      return msg.content
        .filter(p => p.type === 'tool-result')
        .map(p => ({
          role: 'tool',
          content: [{
            type: 'tool-result',
            toolCallId: p.toolCallId,
            toolName: p.toolName,
            output: typeof p.result === 'string'
              ? { type: 'text', value: p.result }
              : { type: 'json', value: p.result },
          }],
        }));
    }

    return [];
  });
}

// --- Tool Conversion ---
// CRITICAL: AI SDK reads `inputSchema` (not `parameters`) from tool definitions.

function toTools(core: AiSdkCore, tools: LanguageTool[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const tool of tools) {
    if (tool.type !== 'function') continue;
    const schema = tool.inputSchema && Object.keys(tool.inputSchema).length > 0
      ? core.jsonSchema(tool.inputSchema)
      : core.jsonSchema({ type: 'object', properties: {} });
    result[tool.name] = { description: tool.description, inputSchema: schema };
  }
  return result;
}

// --- Helpers ---

const FINISH_MAP: Record<string, FinishReason> = {
  stop: 'stop', length: 'length', 'tool-calls': 'tool-calls',
  'content-filter': 'content-filter', error: 'error', other: 'other',
};

function toFinishReason(reason: string): FinishReason {
  return FINISH_MAP[reason] ?? 'other';
}

function toUsage(usage?: Record<string, number>): LanguageTokenUsage {
  return {
    inputTokens:  { total: usage?.inputTokens ?? usage?.promptTokens ?? 0, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: usage?.outputTokens ?? usage?.completionTokens ?? 0, reasoning: undefined },
  };
}

function buildOptions(core: AiSdkCore, request: LanguageRequest) {
  const tools = request.tools?.length ? toTools(core, request.tools) : undefined;

  let toolChoice: any = undefined;
  if (request.toolChoice) {
    if (typeof request.toolChoice === 'string') {
      toolChoice = request.toolChoice;
    } else if (typeof request.toolChoice === 'object' && request.toolChoice.type === 'function') {
      toolChoice = { type: 'tool', toolName: request.toolChoice.function.name };
    }
  }

  return {
    maxTokens: request.maxOutputTokens,
    temperature: request.temperature,
    topP: request.topP,
    topK: request.topK,
    presencePenalty: request.presencePenalty,
    frequencyPenalty: request.frequencyPenalty,
    stopSequences: request.stopSequences,
    seed: request.seed,
    tools,
    toolChoice,
    abortSignal: request.abortSignal,
  };
}

// --- Generate (non-streaming) ---

export async function generate(core: AiSdkCore, model: unknown, request: LanguageRequest): Promise<LanguageResponse> {
  const system = toSystem(request.messages);
  const messages = toMessages(request.messages);
  const result = await core.generateText({ model, system, messages, ...buildOptions(core, request) });

  const content: LanguageMessagePart[] = [];
  if (result.reasoning?.length) content.push({ type: 'reasoning', reasoning: result.reasoning });
  if (result.text) content.push({ type: 'text', text: result.text });
  for (const tc of result.toolCalls ?? []) {
    content.push({ type: 'tool-call', toolCallId: tc.toolCallId, toolName: tc.toolName, input: tc.input ?? tc.args });
  }

  return {
    id: result.response.id ?? crypto.randomUUID(),
    created: Math.floor(result.response.timestamp.getTime() / 1000),
    model: result.response.modelId ?? request.model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: content.length === 1 && content[0].type === 'text' ? (content[0] as any).text : content as any,
      },
      finishReason: toFinishReason(result.finishReason),
    }],
    usage: toUsage(result.usage),
  };
}

// --- Stream ---
// fullStream events from AI SDK:
//   start-step, text-start, text-delta, text-end, reasoning-start, reasoning-delta, reasoning-end,
//   tool-input-start, tool-input-delta, tool-input-end, tool-call, tool-result,
//   finish-step, finish, error
//
// Synax stream events:
//   stream-start, text-start, text-delta, text-end, reasoning-start, reasoning-delta, reasoning-end,
//   tool-input-start, tool-input-delta, tool-input-end,
//   response-metadata, finish

export async function* stream(core: AiSdkCore, model: unknown, request: LanguageRequest, logger?: Logger): AsyncGenerator<LanguageStreamPart> {
  const system = toSystem(request.messages);
  const messages = toMessages(request.messages);
  const result = core.streamText({ model, system, messages, ...buildOptions(core, request) });

  yield { type: 'stream-start' };

  let textId: string | null = null;
  let reasoningId: string | null = null;
  const endedToolCalls = new Set<string>();

  for await (const part of result.fullStream) {
    const p = part as any;
    logger?.debug(`[stream] event: ${JSON.stringify(part)}`);

    switch (part.type) {
      // --- Text ---
      case 'text-start':
        textId = p.id;
        yield { type: 'text-start', id: textId!, providerMetadata: p.providerMetadata };
        break;
      case 'text-delta':
        if (!textId) { textId = p.id ?? crypto.randomUUID(); yield { type: 'text-start', id: textId!, providerMetadata: p.providerMetadata }; }
        yield { type: 'text-delta', id: textId!, delta: p.text ?? p.textDelta ?? '', providerMetadata: p.providerMetadata };
        break;
      case 'text-end':
        if (textId) { yield { type: 'text-end', id: textId, providerMetadata: p.providerMetadata }; textId = null; }
        break;

      // --- Reasoning ---
      case 'reasoning-start':
        reasoningId = p.id;
        yield { type: 'reasoning-start', id: reasoningId! };
        break;
      case 'reasoning-delta':
      case 'reasoning':
        if (!reasoningId) { reasoningId = p.id ?? crypto.randomUUID(); yield { type: 'reasoning-start', id: reasoningId! }; }
        yield { type: 'reasoning-delta', id: reasoningId!, delta: p.text ?? p.textDelta ?? p.delta ?? '' };
        break;
      case 'reasoning-end':
        if (reasoningId) { yield { type: 'reasoning-end', id: reasoningId }; reasoningId = null; }
        break;

      // --- Tool streaming input ---
      case 'tool-input-start': {
        const callId = p.id ?? p.toolCallId;
        if (textId) { yield { type: 'text-end', id: textId }; textId = null; }
        yield { type: 'tool-input-start', id: callId, toolName: p.toolName };
        break;
      }
      case 'tool-input-delta': {
        const callId = p.id ?? p.toolCallId;
        if (!endedToolCalls.has(callId)) {
          yield { type: 'tool-input-delta', id: callId, delta: p.delta ?? p.inputTextDelta ?? '' };
        }
        break;
      }
      case 'tool-input-end': {
        const callId = p.id ?? p.toolCallId;
        if (!endedToolCalls.has(callId)) {
          yield { type: 'tool-input-end', id: callId };
          endedToolCalls.add(callId);
        }
        break;
      }

      // --- Completed tool call (comes after tool-input-start/delta/end in V3) ---
      case 'tool-call': {
        const callId = p.id ?? p.toolCallId;
        if (endedToolCalls.has(callId)) break; // already streamed via deltas
        // Fallback: emit as single chunk if no prior streaming
        if (textId) { yield { type: 'text-end', id: textId }; textId = null; }
        yield { type: 'tool-input-start', id: callId, toolName: p.toolName };
        const inputStr = typeof p.input === 'string' ? p.input : JSON.stringify(p.input ?? p.args ?? {});
        yield { type: 'tool-input-delta', id: callId, delta: inputStr };
        yield { type: 'tool-input-end', id: callId };
        endedToolCalls.add(callId);
        break;
      }

      // --- Finish ---
      case 'finish':
        if (textId) { yield { type: 'text-end', id: textId }; textId = null; }
        if (reasoningId) { yield { type: 'reasoning-end', id: reasoningId }; reasoningId = null; }
        yield {
          type: 'response-metadata',
          id: p.response?.id ?? '',
          model: p.response?.modelId ?? request.model,
          created: Math.floor((p.response?.timestamp?.getTime() ?? Date.now()) / 1000),
        };
        yield { type: 'finish', finishReason: toFinishReason(p.finishReason), usage: toUsage(p.totalUsage ?? p.usage) };
        break;

      case 'error':
        throw p.error;

      // Ignore AI SDK internal events (start-step, finish-step, start, abort, etc.)
      default:
        break;
    }
  }
}
