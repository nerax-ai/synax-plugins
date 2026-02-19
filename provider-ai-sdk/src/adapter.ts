import type { AiSdkCore } from './loader';
import type {
  LanguageRequest,
  LanguageResponse,
  LanguageStreamPart,
  LanguageMessage,
  LanguageTool,
  LanguageToolResultOutput,
  FinishReason,
  LanguageTokenUsage,
  LanguageMessagePart,
} from '@synax-ai/sdk';

function toolResultValue(result: LanguageToolResultOutput): unknown {
  if (result.type === 'text' || result.type === 'error-text') return result.value;
  if (result.type === 'json' || result.type === 'error-json') return result.value;
  if (result.type === 'execution-denied') return { denied: true, reason: result.reason };
  return result;
}

function toMessages(messages: LanguageMessage[]): unknown[] {
  return messages.map((msg) => {
    if (msg.role === 'system') return { role: 'system', content: msg.content };

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
          if (p.type === 'tool-call') return [{ type: 'tool-call', toolCallId: p.toolCallId, toolName: p.toolName, args: p.input }];
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
            result: toolResultValue(p.result),
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
    result[tool.name] = {
      description: tool.description,
      parameters: core.jsonSchema(tool.inputSchema ?? { type: 'object', properties: {} }),
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

function toUsage(usage?: { promptTokens?: number; completionTokens?: number }): LanguageTokenUsage {
  return {
    inputTokens: { total: usage?.promptTokens, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: usage?.completionTokens, reasoning: undefined },
  };
}

function buildOptions(core: AiSdkCore, request: LanguageRequest) {
  return {
    maxTokens: request.maxOutputTokens,
    temperature: request.temperature,
    topP: request.topP,
    topK: request.topK,
    presencePenalty: request.presencePenalty,
    frequencyPenalty: request.frequencyPenalty,
    stopSequences: request.stopSequences,
    seed: request.seed,
    tools: request.tools?.length ? toTools(core, request.tools) : undefined,
    toolChoice: request.toolChoice as any,
    abortSignal: request.abortSignal,
  };
}

export async function generate(core: AiSdkCore, model: unknown, request: LanguageRequest): Promise<LanguageResponse> {
  const result = await core.generateText({ model, messages: toMessages(request.messages), ...buildOptions(core, request) });

  const content: LanguageMessagePart[] = [];
  if (result.reasoning?.length) content.push({ type: 'reasoning', reasoning: result.reasoning });
  if (result.text) content.push({ type: 'text', text: result.text });
  for (const tc of result.toolCalls ?? []) {
    content.push({ type: 'tool-call', toolCallId: tc.toolCallId, toolName: tc.toolName, input: tc.args });
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
  const result = core.streamText({ model, messages: toMessages(request.messages), ...buildOptions(core, request) });

  yield { type: 'stream-start' };

  let textId: string | null = null;
  let reasoningId: string | null = null;

  for await (const part of result.fullStream) {
    switch (part.type) {
      case 'text-delta':
        if (!textId) { textId = crypto.randomUUID(); yield { type: 'text-start', id: textId }; }
        yield { type: 'text-delta', id: textId, delta: part.textDelta };
        break;
      case 'reasoning':
        if (!reasoningId) { reasoningId = crypto.randomUUID(); yield { type: 'reasoning-start', id: reasoningId }; }
        yield { type: 'reasoning-delta', id: reasoningId, delta: part.textDelta };
        break;
      case 'tool-call-streaming-start':
        if (textId) { yield { type: 'text-end', id: textId }; textId = null; }
        yield { type: 'tool-input-start', id: part.toolCallId, toolName: part.toolName };
        break;
      case 'tool-call-delta':
        yield { type: 'tool-input-delta', id: part.toolCallId, delta: part.argsTextDelta };
        break;
      case 'tool-call':
        if (textId) { yield { type: 'text-end', id: textId }; textId = null; }
        yield { type: 'tool-input-start', id: part.toolCallId, toolName: part.toolName };
        yield { type: 'tool-input-delta', id: part.toolCallId, delta: JSON.stringify(part.args) };
        yield { type: 'tool-input-end', id: part.toolCallId };
        break;
      case 'finish':
        if (textId) { yield { type: 'text-end', id: textId }; textId = null; }
        if (reasoningId) { yield { type: 'reasoning-end', id: reasoningId }; reasoningId = null; }
        yield { type: 'response-metadata', id: part.response?.id ?? '', model: part.response?.modelId ?? request.model, created: Math.floor((part.response?.timestamp?.getTime() ?? Date.now()) / 1000) };
        yield { type: 'finish', finishReason: toFinishReason(part.finishReason), usage: toUsage(part.usage) };
        break;
      case 'error':
        yield { type: 'error', error: part.error };
        break;
    }
  }
}
