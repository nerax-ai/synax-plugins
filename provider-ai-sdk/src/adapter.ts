import type { AiSdkCore, AiSdkInstance } from './loader';
import type { LanguageModelUsage, UserContent, AssistantContent, ToolContent, TextPart, FilePart } from 'ai';
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

/** Assistant message content parts (excludes tool-result which belongs in tool messages) */
type AssistantContentPart = LanguageTextContent | LanguageReasoningContent | LanguageToolCallContent;

// ─── Helpers ────────────────────────────────────────────────────

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

  // Pull instructions from extra or common provider-specific locations to ensure 
  // they are not lost on non-GPT models that don't support an explicit 'instructions' field.
  if (request?.extra?.instructions) {
    parts.push(String(request.extra.instructions));
  }

  const openaiInstructions = (request?.providerOptions as any)?.openai?.instructions;
  if (typeof openaiInstructions === 'string') {
    parts.push(openaiInstructions);
  }

  return parts.length ? parts.join('\n\n') : undefined;
}

/**
 * Convert Synax messages → AI SDK ModelMessage[].
 *
 * AI SDK v6 message/content shapes:
 *   - ToolCallPart: { type:'tool-call', toolCallId, toolName, input }
 *   - ToolResultPart: { type:'tool-result', toolCallId, toolName, output }
 *   - TextPart: { type:'text', text }
 *
 * Synax SDK shapes:
 *   - LanguageToolCallContent: { type:'tool-call', toolCallId, toolName, input }
 *   - LanguageToolResultContent: { type:'tool-result', toolCallId, toolName, result }
 *
 * Since the two SDKs have slight differences in property names (e.g. `output`
 * vs `result`), and the AI SDK does not export `CoreMessage` in v6, we type
 * the return as the provider-utils `ModelMessage[]` equivalent via inline
 * object shapes.
 */
function toMessages(messages: LanguageMessage[], logger?: Logger) {
  // 1. Initial conversion pass with strict schema compliance
  const converted = messages
    .filter(m => m.role?.toLowerCase() !== 'system' && m.role)
    .map(msg => {
      const role = msg.role!.toLowerCase();

      if (role === 'user') {
        if (typeof msg.content === 'string') {
          return { role: 'user' as const, content: msg.content || ' ' };
        }
        const parts = (Array.isArray(msg.content) ? msg.content : [msg.content]) as LanguageMessagePart[];
        const content = parts.map((p): TextPart | FilePart => {
          if (p.type === 'text') return { type: 'text', text: (p as LanguageTextContent).text || '' };
          if (p.type === 'file') {
            const f = p as LanguageFileContent;
            return { type: 'file', data: f.data as any, mediaType: f.mediaType || 'application/octet-stream' };
          }
          return { type: 'text', text: 'text' in p ? String((p as any).text || '') : JSON.stringify(p) };
        });

        // Optimization: Flatten to string if it's just a single text part
        if (content.length === 1 && content[0].type === 'text') {
          return { role: 'user' as const, content: content[0].text || ' ' };
        }
        
        return { role: 'user' as const, content };
      }

      if (role === 'assistant') {
        if (typeof msg.content === 'string') {
          return { role: 'assistant' as const, content: msg.content || ' ' };
        }
        const parts = (msg.content as AssistantContentPart[]) || [];
        const content = parts.map(part => {
          if (part.type === 'tool-call') {
            return { 
              type: 'tool-call' as const, 
              toolCallId: part.toolCallId, 
              toolName: part.toolName, 
              input: part.input ?? {} 
            };
          }
          if (part.type === 'reasoning') {
            return { type: 'reasoning' as const, text: part.reasoning || '' };
          }
          return { type: 'text' as const, text: (part as LanguageTextContent).text || '' };
        });

        // Optimization: Flatten to string if it's just a single text part
        if (content.length === 1 && content[0].type === 'text') {
          return { role: 'assistant' as const, content: content[0].text || ' ' };
        }
        
        return { role: 'assistant' as const, content: content.length > 0 ? content : ' ' };
      }

      if (role === 'tool') {
        const parts = (Array.isArray(msg.content) ? msg.content : []) as LanguageMessagePart[];
        const content = parts
          .map(p => {
            if (p.type === 'tool-result') {
              let res = p.result;
              
              // Ensure outcome is a valid ToolResultOutput { type, value }
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

        return { role: 'tool' as const, content: content as any[] };
      }

      // Fallback for unknown roles
      return { role: 'user' as const, content: '' };
    })
    .filter(m => {
      // AI SDK requires non-empty content for array-based messages
      if (Array.isArray(m.content) && m.content.length === 0) return false;
      return true;
    });

  // 2. Reorder messages to satisfy 'tool results must follow assistant tool-calls' constraint
  const finalMessages: typeof converted = [];
  const handledToolMessageIds = new Set<number>();
  
  for (let i = 0; i < converted.length; i++) {
    const msg = converted[i];
    if (handledToolMessageIds.has(i)) continue;
    
    finalMessages.push(msg);
    
    // Check if current message is an assistant making tool calls
    if (msg.role === 'assistant' && Array.isArray(msg.content) && msg.content.some(c => c.type === 'tool-call')) {
      const toolCallIds = new Set(
        msg.content
          .filter(c => c.type === 'tool-call')
          .map(c => (c as any).toolCallId)
      );
      
      // Look ahead for matching results
      for (let j = i + 1; j < converted.length; j++) {
        const nextMsg = converted[j];
        if (nextMsg.role === 'tool' && !handledToolMessageIds.has(j)) {
          const nextContentParts = Array.isArray(nextMsg.content) ? nextMsg.content : [];
          const matchingParts = nextContentParts.filter(p => p.type === 'tool-result' && toolCallIds.has(p.toolCallId));
          const remainingParts = nextContentParts.filter(p => !matchingParts.includes(p));
          
          if (matchingParts.length > 0) {
            finalMessages.push({ role: 'tool', content: matchingParts });
            matchingParts.forEach(p => toolCallIds.delete(p.toolCallId));
            
            if (remainingParts.length === 0) {
              handledToolMessageIds.add(j);
            } else {
              (nextMsg as any).content = remainingParts;
            }
          }
          
          if (toolCallIds.size === 0) break;
        }
      }
    }
  }

  return finalMessages;
}

// ─── Tool Conversion ────────────────────────────────────────────
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

const FINISH_MAP: Record<string, FinishReason> = {
  stop: 'stop', length: 'length', 'tool-calls': 'tool-calls',
  'content-filter': 'content-filter', error: 'error', other: 'other',
};

function toFinishReason(reason: string): FinishReason {
  return FINISH_MAP[reason] ?? 'other';
}

function toUsage(usage?: LanguageModelUsage): LanguageTokenUsage {
  return {
    inputTokens:  { total: usage?.inputTokens ?? 0, noCache: usage?.inputTokenDetails?.noCacheTokens, cacheRead: usage?.inputTokenDetails?.cacheReadTokens, cacheWrite: usage?.inputTokenDetails?.cacheWriteTokens },
    outputTokens: { total: usage?.outputTokens ?? 0, reasoning: usage?.outputTokenDetails?.reasoningTokens },
  };
}

function buildOptions(core: AiSdkCore, request: LanguageRequest) {
  const tools = request.tools?.length ? toTools(core, request.tools) : undefined;

  let toolChoice: 'auto' | 'none' | 'required' | { type: 'tool'; toolName: string } | undefined = undefined;
  if (request.toolChoice) {
    if (typeof request.toolChoice === 'string') {
      toolChoice = request.toolChoice as 'auto' | 'none' | 'required';
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
    ...(request.providerOptions && { providerOptions: request.providerOptions }),
  };
}

// ─── Generate (non-streaming) ───────────────────────────────────

export async function generate(core: AiSdkCore, instance: any, request: LanguageRequest, logger?: Logger): Promise<LanguageResponse> {
  if (logger) {
    logger.debug(`[AiSdkAdapter] [generate] request:\n${JSON.stringify(request, null, 2)}`);
  }
  const model = typeof instance === 'function' ? instance(request.model) : instance;
  const system = toSystem(request.messages, request);
  const messages = toMessages(request.messages, logger);
  const options = buildOptions(core, request);

  if (logger) {
    logger.debug(`[AiSdkAdapter] [generate] converted messages:\n${JSON.stringify(messages, null, 2)}`);
  }

  // AI SDK's generateText expects `LanguageModel` for `model`, and `messages`
  // for the prompt. LanguageModelV3 ⊂ LanguageModel so the cast is safe.
  const result = await core.generateText({ model, system, messages, ...options } as Parameters<typeof core.generateText>[0]);

  const content: AssistantContentPart[] = [];

  // result.reasoningText is the concatenated string of all reasoning parts
  if (result.reasoningText) {
    content.push({ type: 'reasoning', reasoning: result.reasoningText });
  }
  if (result.text) {
    content.push({ type: 'text', text: result.text });
  }
  // result.toolCalls[].input is the parsed tool call input (AI SDK v6 uses `input`, not `args`)
  for (const tc of result.toolCalls) {
    content.push({
      type: 'tool-call',
      toolCallId: tc.toolCallId,
      toolName: tc.toolName,
      input: tc.input,
    });
  }

  return {
    id: result.response.id ?? crypto.randomUUID(),
    created: Math.floor(result.response.timestamp.getTime() / 1000),
    model: result.response.modelId ?? request.model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: content.length === 1 && content[0].type === 'text'
          ? content[0].text
          : content,
      },
      finishReason: toFinishReason(result.finishReason),
    }],
    usage: toUsage(result.usage),
  };
}

// ─── Stream ─────────────────────────────────────────────────────
//
// AI SDK v6 fullStream events (TextStreamPart):
//   start, start-step, text-start, text-delta, text-end,
//   reasoning-start, reasoning-delta, reasoning-end,
//   tool-input-start, tool-input-delta, tool-input-end,
//   tool-call, tool-result, tool-error, tool-output-denied,
//   source, file, finish-step, finish, abort, error, raw
//
// AI SDK v6 TextStreamPart field names:
//   text-delta      → { id, text }
//   reasoning-delta → { id, text }
//   tool-input-delta→ { id, delta }
//   tool-input-start→ { id, toolName }
//   tool-call       → { toolCallId, toolName, input }
//   finish          → { finishReason, totalUsage }
//   finish-step     → { response, usage, finishReason }
//
// Synax stream events:
//   stream-start, text-start, text-delta, text-end,
//   reasoning-start, reasoning-delta, reasoning-end,
//   tool-input-start, tool-input-delta, tool-input-end,
//   response-metadata, finish

export async function* stream(core: AiSdkCore, instance: any, request: LanguageRequest, logger?: Logger): AsyncGenerator<LanguageStreamPart> {
  const model = typeof instance === 'function' ? instance(request.model) : instance;
  const system = toSystem(request.messages, request);
  const messages = toMessages(request.messages, logger);
  const options = buildOptions(core, request);

  const result = core.streamText({ model, system, messages, ...options } as Parameters<typeof core.streamText>[0]);

  yield { type: 'stream-start' };

  let textId: string | null = null;
  let reasoningId: string | null = null;
  let lastResponse: { id: string; modelId: string; timestamp: Date } | null = null;
  const endedToolCalls = new Set<string>();

  for await (const part of result.fullStream) {
    logger?.debug(`[SDK] [stream] event:\n${JSON.stringify(part, null, 2)}`);

    switch (part.type) {
      // --- Text ---
      case 'text-start':
        textId = part.id;
        yield { type: 'text-start', id: textId, providerMetadata: part.providerMetadata };
        break;
      case 'text-delta':
        if (!textId) {
          textId = part.id ?? crypto.randomUUID();
          yield { type: 'text-start', id: textId, providerMetadata: part.providerMetadata };
        }
        // AI SDK v6 TextStreamPart text-delta has `text`, Synax expects `delta`
        yield { type: 'text-delta', id: textId, delta: part.text, providerMetadata: part.providerMetadata };
        break;
      case 'text-end':
        if (textId) {
          yield { type: 'text-end', id: textId, providerMetadata: part.providerMetadata };
          textId = null;
        }
        break;

      // --- Reasoning ---
      case 'reasoning-start':
        reasoningId = part.id;
        yield { type: 'reasoning-start', id: reasoningId };
        break;
      case 'reasoning-delta':
        if (!reasoningId) {
          reasoningId = part.id ?? crypto.randomUUID();
          yield { type: 'reasoning-start', id: reasoningId };
        }
        // AI SDK v6 reasoning-delta has `text`, Synax expects `delta`
        yield { type: 'reasoning-delta', id: reasoningId, delta: part.text };
        break;
      case 'reasoning-end':
        if (reasoningId) {
          yield { type: 'reasoning-end', id: reasoningId };
          reasoningId = null;
        }
        break;

      // --- Tool streaming input ---
      case 'tool-input-start': {
        // AI SDK v6 uses `id` for the tool call identifier
        const callId = part.id;
        if (textId) { yield { type: 'text-end', id: textId }; textId = null; }
        yield { type: 'tool-input-start', id: callId, toolName: part.toolName };
        break;
      }
      case 'tool-input-delta': {
        const callId = part.id;
        if (!endedToolCalls.has(callId)) {
          yield { type: 'tool-input-delta', id: callId, delta: part.delta };
        }
        break;
      }
      case 'tool-input-end': {
        const callId = part.id;
        if (!endedToolCalls.has(callId)) {
          yield { type: 'tool-input-end', id: callId };
          endedToolCalls.add(callId);
        }
        break;
      }

      // --- Completed tool call ---
      case 'tool-call': {
        const callId = part.toolCallId;
        if (endedToolCalls.has(callId)) break;

        // Skip tool calls with empty input to prevent validation errors
        const input = part.input ?? {};
        if (Object.keys(input).length === 0) {
          endedToolCalls.add(callId);
          break;
        }

        if (textId) { yield { type: 'text-end', id: textId }; textId = null; }
        yield { type: 'tool-input-start', id: callId, toolName: part.toolName };
        yield { type: 'tool-input-delta', id: callId, delta: JSON.stringify(input) };
        yield { type: 'tool-input-end', id: callId };
        endedToolCalls.add(callId);
        break;
      }

      // --- Finish step (captures response metadata) ---
      case 'finish-step':
        lastResponse = part.response;
        break;

      // --- Finish ---
      case 'finish':
        if (textId) { yield { type: 'text-end', id: textId }; textId = null; }
        if (reasoningId) { yield { type: 'reasoning-end', id: reasoningId }; reasoningId = null; }
        yield {
          type: 'response-metadata',
          id: lastResponse?.id ?? '',
          model: lastResponse?.modelId ?? request.model,
          created: Math.floor((lastResponse?.timestamp?.getTime() ?? Date.now()) / 1000),
        };
        // AI SDK v6 finish event has `totalUsage`, not `usage`
        yield { type: 'finish', finishReason: toFinishReason(part.finishReason), usage: toUsage(part.totalUsage) };
        break;

      case 'error':
        throw part.error;

      // Ignore AI SDK internal events (start-step, start, abort, source, file, raw, etc.)
      default:
        break;
    }
  }
}
