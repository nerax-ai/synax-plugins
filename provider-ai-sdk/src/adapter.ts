import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Message,
  LanguageModelV3TextPart,
  LanguageModelV3FilePart,
  LanguageModelV3ReasoningPart,
  LanguageModelV3ToolCallPart,
  LanguageModelV3ToolResultPart,
  LanguageModelV3FunctionTool,
  LanguageModelV3ToolChoice,
  LanguageModelV3StreamPart,
  LanguageModelV3FinishReason,
} from '@ai-sdk/provider';

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
  LanguageTextContent,
  LanguageFileContent,
  LanguageReasoningContent,
  LanguageToolCallContent,
  LanguageToolResultContent,
  LanguageToolApprovalResponseContent,
} from '@synax-ai/sdk';

type AssistantContentPart = LanguageTextContent | LanguageReasoningContent | LanguageToolCallContent;

// ─── Message Conversion ─────────────────────────────────────────

function toV3Messages(messages: LanguageMessage[], logger?: Logger): LanguageModelV3Message[] {
  return messages
    .filter(m => m.role && m.role.toLowerCase() !== 'system')
    .map(msg => {
      const role = msg.role!.toLowerCase();

      if (role === 'user') {
        const parts = (msg.content as LanguageMessagePart[]) || [];
        const content: Array<LanguageModelV3TextPart | LanguageModelV3FilePart> = parts.map(p => {
          if (p.type === 'text') return { type: 'text', text: (p as LanguageTextContent).text || '' };
          if (p.type === 'file') {
            const f = p as LanguageFileContent;
            return { type: 'file', data: f.data as any, mediaType: f.mediaType || 'application/octet-stream' };
          }
          return { type: 'text', text: JSON.stringify(p) };
        });
        return { role: 'user' as const, content };
      }

      if (role === 'assistant') {
        const parts = (msg.content as AssistantContentPart[]) || [];
        const content: Array<LanguageModelV3TextPart | LanguageModelV3ReasoningPart | LanguageModelV3ToolCallPart | LanguageModelV3ToolResultPart> = parts.map(p => {
          if (p.type === 'tool-call') {
            return {
              type: 'tool-call' as const,
              toolCallId: p.toolCallId,
              toolName: p.toolName,
              input: p.input ?? {}
            };
          }
          if (p.type === 'reasoning') {
            return { type: 'reasoning' as const, text: p.reasoning || '' };
          }
          return { type: 'text' as const, text: (p as LanguageTextContent).text || '' };
        });
        return { role: 'assistant' as const, content };
      }

      if (role === 'tool') {
        const parts = (msg.content as LanguageMessagePart[]) || [];
        const content: Array<LanguageModelV3ToolResultPart | any> = parts
          .map(p => {
            if (p.type === 'tool-result') {
              let res = p.output;
              if (!res || typeof res !== 'object' || !('type' in res)) {
                res = { type: 'text', value: String(res ?? 'success') };
              }
              return {
                type: 'tool-result' as const,
                toolCallId: p.toolCallId,
                toolName: p.toolName,
                output: res,
              };
            }
            if (p.type === 'tool-approval-response') {
              return {
                type: 'tool-approval-response' as const,
                approvalId: p.approvalId,
                approved: !!p.approved,
                reason: p.reason,
              };
            }
            return null;
          })
          .filter((p): p is NonNullable<typeof p> => p !== null);
        return { role: 'tool' as const, content };
      }

      return { role: 'user' as const, content: [] };
    })
    .filter(m => Array.isArray(m.content) && m.content.length > 0);
}

function toSystem(messages: LanguageMessage[], request?: LanguageRequest): string | undefined {
  const parts = messages
    .filter(m => m.role === 'system')
    .map(m => {
      if (typeof m.content === 'string') return m.content;
      return (m.content as LanguageMessagePart[])
        .filter((p): p is LanguageTextContent => p.type === 'text')
        .map(p => p.text)
        .join('\n\n');
    });

  if (request?.extra?.instructions) {
    parts.push(String(request.extra.instructions));
  }

  const openaiInstructions = (request?.providerOptions as any)?.openai?.instructions;
  if (typeof openaiInstructions === 'string') {
    parts.push(openaiInstructions);
  }

  return parts.length ? parts.join('\n\n') : undefined;
}

// ─── Tool Conversion ────────────────────────────────────────────

function toV3Tools(tools: LanguageTool[]): LanguageModelV3FunctionTool[] {
  return tools
    .filter(t => (t as any).type === 'function' || (t as any).name)
    .map(t => {
      const tool = t as any;
      return {
        type: 'function' as const,
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema || { type: 'object', properties: {} },
      };
    });
}

function toV3ToolChoice(choice?: any): LanguageModelV3ToolChoice | undefined {
  if (!choice) return undefined;
  if (typeof choice === 'string') {
    if (choice === 'auto') return { type: 'auto' };
    if (choice === 'none') return { type: 'none' };
    if (choice === 'required') return { type: 'required' };
  }
  if (typeof choice === 'object' && choice.type === 'function') {
    return { type: 'tool', toolName: choice.function.name };
  }
  return undefined;
}

const FINISH_MAP: Record<string, FinishReason> = {
  stop: 'stop',
  length: 'length',
  'tool-calls': 'tool-calls',
  'content-filter': 'content-filter',
  error: 'error',
  other: 'other',
};

function toFinishReason(reason: LanguageModelV3FinishReason): FinishReason {
  return FINISH_MAP[reason.unified] ?? 'other';
}

function toUsage(usage?: any): LanguageTokenUsage {
  return {
    inputTokens: {
      total: usage?.inputTokens?.total ?? 0,
      noCache: usage?.inputTokens?.noCache,
      cacheRead: usage?.inputTokens?.cacheRead,
      cacheWrite: usage?.inputTokens?.cacheWrite,
    },
    outputTokens: {
      total: usage?.outputTokens?.total ?? 0,
      reasoning: usage?.outputTokens?.reasoning,
    },
  };
}

// ─── Generate ───────────────────────────────────────────────────

export async function generate(
  model: LanguageModelV3,
  request: LanguageRequest,
  logger?: Logger
): Promise<LanguageResponse> {
  if (logger?.debug) {
    logger.debug(`[V3Adapter] [generate] request:\n${JSON.stringify(request, null, 2)}`);
  }

  const prompt = toV3Messages(request.messages, logger);
  const systemMessage = toSystem(request.messages, request);

  if (systemMessage) {
    prompt.unshift({ role: 'system', content: systemMessage });
  }

  const options: LanguageModelV3CallOptions = {
    prompt,
    maxOutputTokens: request.maxOutputTokens,
    temperature: request.temperature,
    topP: request.topP,
    topK: request.topK,
    presencePenalty: request.presencePenalty,
    frequencyPenalty: request.frequencyPenalty,
    stopSequences: request.stopSequences,
    seed: request.seed,
    tools: request.tools?.length ? toV3Tools(request.tools) : undefined,
    toolChoice: toV3ToolChoice(request.toolChoice),
    abortSignal: request.abortSignal,
    providerOptions: request.providerOptions,
    ...(request.extra as any),
  };

  const result = await model.doGenerate(options);

  const content: AssistantContentPart[] = [];

  for (const part of result.content) {
    if (part.type === 'text') {
      content.push({ type: 'text', text: part.text });
    } else if (part.type === 'reasoning') {
      content.push({ type: 'reasoning', reasoning: part.reasoning });
    } else if (part.type === 'tool-call') {
      content.push({
        type: 'tool-call',
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: part.input,
      });
    }
  }

  return {
    id: result.response?.id ?? crypto.randomUUID(),
    created: Math.floor((result.response?.timestamp?.getTime() ?? Date.now()) / 1000),
    model: result.response?.modelId ?? request.model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content,
        },
        finishReason: toFinishReason(result.finishReason),
      },
    ],
    usage: toUsage(result.usage),
  };
}

// ─── Stream ─────────────────────────────────────────────────────

export async function* stream(
  model: LanguageModelV3,
  request: LanguageRequest,
  logger?: Logger
): AsyncGenerator<LanguageStreamPart> {
  if (logger?.debug) {
    logger.debug(`[V3Adapter] [stream] request:\n${JSON.stringify(request, null, 2)}`);
  }

  const prompt = toV3Messages(request.messages, logger);
  const systemMessage = toSystem(request.messages, request);

  if (systemMessage) {
    prompt.unshift({ role: 'system', content: systemMessage });
  }

  const options: LanguageModelV3CallOptions = {
    prompt,
    maxOutputTokens: request.maxOutputTokens,
    temperature: request.temperature,
    topP: request.topP,
    topK: request.topK,
    presencePenalty: request.presencePenalty,
    frequencyPenalty: request.frequencyPenalty,
    stopSequences: request.stopSequences,
    seed: request.seed,
    tools: request.tools?.length ? toV3Tools(request.tools) : undefined,
    toolChoice: toV3ToolChoice(request.toolChoice),
    abortSignal: request.abortSignal,
    providerOptions: request.providerOptions,
    ...(request.extra as any),
  };

  const result = await model.doStream(options);

  yield { type: 'stream-start' };

  let lastResponse: { id: string; modelId: string; timestamp: Date } | null = null;

  for await (const part of result.stream) {
    logger?.debug(`[V3Adapter] [stream] event:\n${JSON.stringify(part, null, 2)}`);

    switch (part.type) {
      case 'text-start':
        yield { type: 'text-start', id: part.id, providerMetadata: part.providerMetadata };
        break;
      case 'text-delta':
        yield { type: 'text-delta', id: part.id, delta: part.delta, textDelta: part.delta, providerMetadata: part.providerMetadata } as any;
        break;
      case 'text-end':
        yield { type: 'text-end', id: part.id, providerMetadata: part.providerMetadata };
        break;

      case 'reasoning-start':
        yield { type: 'reasoning-start', id: part.id };
        break;
      case 'reasoning-delta':
        yield { type: 'reasoning-delta', id: part.id, delta: part.delta, reasoningDelta: part.delta } as any;
        break;
      case 'reasoning-end':
        yield { type: 'reasoning-end', id: part.id };
        break;

      case 'tool-input-start':
        yield { type: 'tool-input-start', id: part.id, toolName: part.toolName };
        break;
      case 'tool-input-delta':
        yield { type: 'tool-input-delta', id: part.id, delta: part.delta };
        break;
      case 'tool-input-end':
        yield { type: 'tool-input-end', id: part.id };
        break;

      case 'response-metadata':
        lastResponse = { id: part.id, modelId: part.modelId, timestamp: part.timestamp };
        yield {
          type: 'response-metadata',
          id: part.id,
          model: part.modelId,
          created: Math.floor(part.timestamp.getTime() / 1000),
        };
        break;

      case 'finish':
        yield {
          type: 'finish',
          finishReason: toFinishReason(part.finishReason),
          usage: toUsage(part.usage),
        };
        break;

      case 'error':
        throw part.error;

      default:
        break;
    }
  }
}
