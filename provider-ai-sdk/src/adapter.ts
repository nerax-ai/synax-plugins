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
} from '@synax-ai/sdk';

function toSystem(messages: LanguageMessage[]): string | undefined {
  const parts = messages.filter(m => m.role === 'system').map(m =>
    typeof m.content === 'string' ? m.content : (m.content as any[]).map((p: any) => p.text).join('\n\n')
  );
  return parts.length ? parts.join('\n\n') : undefined;
}

function toMessages(messages: LanguageMessage[]): unknown[] {
  return messages.filter(m => m.role !== 'system').map((msg) => {
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') return { role: 'user', content: msg.content };
      return {
        role: 'user',
        content: msg.content.map((p) =>
          p.type === 'text'
            ? { type: 'text', text: p.text }
            : { type: 'file', data: p.data as string | URL, mimeType: p.mediaType },
        ),
      };
    }

    if (msg.role === 'assistant') {
      if (typeof msg.content === 'string') return { role: 'assistant', content: msg.content };
      return {
        role: 'assistant',
        content: msg.content.flatMap((p): any[] => {
          if (p.type === 'text') return [{ type: 'text', text: p.text }];
          if (p.type === 'reasoning') return [{ type: 'reasoning', text: p.reasoning, signature: p.signature }];
          if (p.type === 'tool-call') {
            let parsedArgs = p.input;
            if (typeof p.input === 'string') {
              try {
                parsedArgs = p.input.trim() ? JSON.parse(p.input) : {};
              } catch (e) {
                parsedArgs = {};
              }
            }
            return [{ type: 'tool-call', toolCallId: p.toolCallId, toolName: p.toolName, args: parsedArgs, input: parsedArgs }];
          }
          return [];
        }),
      };
    }

    return {
      role: 'tool',
      content: msg.content
        .filter((p) => p.type === 'tool-result')
        .map((p) => {
          if (p.type !== 'tool-result') return null!;
          return {
            type: 'tool-result',
            toolCallId: p.toolCallId,
            toolName: p.toolName,
            result: p.result,
            isError: p.isError,
          };
        }),
    };
  });
}

function toTools(core: AiSdkCore, tools: LanguageTool[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const tool of tools) {
    if (tool.type !== 'function') continue;
    
    const schema = tool.inputSchema && Object.keys(tool.inputSchema).length > 0
      ? core.jsonSchema(tool.inputSchema)
      : core.jsonSchema({ type: 'object', properties: {} });

    result[tool.name] = {
      description: tool.description,
      parameters: schema,
    };
  }
  return result;
}

function toFinishReason(reason: string): FinishReason {
  const map: Record<string, FinishReason> = {
    stop: 'stop', length: 'length', 'tool-calls': 'tool-calls',
    'content-filter': 'content-filter', error: 'error', other: 'other',
  };
  return map[reason] ?? 'other';
}

function toUsage(usage?: { promptTokens?: number; completionTokens?: number; inputTokens?: number; outputTokens?: number }): LanguageTokenUsage {
  return {
    inputTokens: { total: usage?.inputTokens ?? usage?.promptTokens, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: usage?.outputTokens ?? usage?.completionTokens, reasoning: undefined },
  };
}

function buildOptions(core: AiSdkCore, request: LanguageRequest) {
  const tools = request.tools?.length ? toTools(core, request.tools) : undefined;
  if (tools) {
    console.log(`[adapter] tools: ${Object.keys(tools).join(', ')}`);
  }
  
  let toolChoice: any = undefined;
  if (request.toolChoice) {
    if (typeof request.toolChoice === 'string') {
      toolChoice = request.toolChoice;
    } else if (typeof request.toolChoice === 'object' && request.toolChoice.type === 'function') {
      toolChoice = {
        type: 'tool',
        toolName: request.toolChoice.function.name,
      };
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

export async function* stream(core: AiSdkCore, model: unknown, request: LanguageRequest): AsyncGenerator<LanguageStreamPart> {
  const system = toSystem(request.messages);
  const messages = toMessages(request.messages);
  const result = core.streamText({ model, system, messages, ...buildOptions(core, request) });

  yield { type: 'stream-start' };

  let textId: string | null = null;
  let reasoningId: string | null = null;
  const startedToolCalls = new Set<string>();
  const endedToolCalls = new Set<string>();

  for await (const part of result.fullStream) {
    switch (part.type) {
      case 'text-delta':
        if (!textId) { textId = crypto.randomUUID(); yield { type: 'text-start', id: textId }; }
        yield { type: 'text-delta', id: textId, delta: part.text ?? part.textDelta ?? '' };
        break;
      case 'reasoning':
        if (!reasoningId) { reasoningId = crypto.randomUUID(); yield { type: 'reasoning-start', id: reasoningId }; }
        yield { type: 'reasoning-delta', id: reasoningId, delta: part.text ?? part.textDelta ?? '' };
        break;
      case 'tool-input-start': {
        const p = part as any;
        const callId = p.id ?? p.toolCallId;
        if (startedToolCalls.has(callId)) break;
        if (textId) { yield { type: 'text-end', id: textId }; textId = null; }
        yield { type: 'tool-input-start', id: callId, toolName: p.toolName };
        startedToolCalls.add(callId);
        break;
      }
      case 'tool-input-delta': {
        const p = part as any;
        const callId = p.id ?? p.toolCallId;
        if (endedToolCalls.has(callId)) break;
        yield { type: 'tool-input-delta', id: callId, delta: p.delta ?? p.inputTextDelta ?? '' };
        break;
      }
      case 'tool-input-end': {
        const p = part as any;
        const callId = p.id ?? p.toolCallId;
        if (endedToolCalls.has(callId)) break;
        yield { type: 'tool-input-end', id: callId };
        endedToolCalls.add(callId);
        break;
      }
      case 'tool-input-available': {
        const p = part as any;
        const callId = p.id ?? p.toolCallId;
        if (endedToolCalls.has(callId)) break;
        if (textId) { yield { type: 'text-end', id: textId }; textId = null; }
        if (!startedToolCalls.has(callId)) {
          yield { type: 'tool-input-start', id: callId, toolName: p.toolName };
          startedToolCalls.add(callId);
          yield { type: 'tool-input-delta', id: callId, delta: JSON.stringify(p.input ?? p.args) };
        }
        yield { type: 'tool-input-end', id: callId };
        endedToolCalls.add(callId);
        break;
      }
      // legacy fallback
      case 'tool-call-streaming-start': {
        const callId = (part as any).toolCallId;
        if (startedToolCalls.has(callId)) break;
        if (textId) { yield { type: 'text-end', id: textId }; textId = null; }
        yield { type: 'tool-input-start', id: callId, toolName: (part as any).toolName };
        startedToolCalls.add(callId);
        break;
      }
      case 'tool-call-delta': {
        const callId = (part as any).toolCallId;
        if (endedToolCalls.has(callId)) break;
        yield { type: 'tool-input-delta', id: callId, delta: (part as any).argsTextDelta };
        break;
      }
      case 'tool-call': {
        const p2 = part as any;
        const callId = p2.id ?? p2.toolCallId;
        if (endedToolCalls.has(callId)) break;
        if (textId) { yield { type: 'text-end', id: textId }; textId = null; }
        if (!startedToolCalls.has(callId)) {
          yield { type: 'tool-input-start', id: callId, toolName: p2.toolName };
          startedToolCalls.add(callId);
          yield { type: 'tool-input-delta', id: callId, delta: JSON.stringify(p2.input ?? p2.args) };
        }
        yield { type: 'tool-input-end', id: callId };
        endedToolCalls.add(callId);
        break;
      }
      case 'finish':
        if (textId) { yield { type: 'text-end', id: textId }; textId = null; }
        if (reasoningId) { yield { type: 'reasoning-end', id: reasoningId }; reasoningId = null; }
        yield { type: 'response-metadata', id: part.response?.id ?? '', model: part.response?.modelId ?? request.model, created: Math.floor((part.response?.timestamp?.getTime() ?? Date.now()) / 1000) };
        yield { type: 'finish', finishReason: toFinishReason(part.finishReason), usage: toUsage(part.usage) };
        break;
      case 'error':
        throw part.error;
    }
  }
}
