import type {
  LanguageRequest,
  LanguageMessage,
  LanguageTextContent,
  LanguageFileContent,
  LanguageToolCallContent,
  LanguageTool,
  LanguageReasoningConfig,
  LanguageUserMessage,
  LanguageAssistantMessage,
  LanguageFunctionTool,
  JSONSchema,
} from '@synax-ai/sdk';
import type { OpenAIResponsesRequest, ResponsesInputItem, ResponsesContentPart, ResponsesReasoningConfig } from './types';

function isTextContent(part: unknown): part is LanguageTextContent {
  return typeof part === 'object' && part !== null && (part as LanguageTextContent).type === 'text';
}

function isFileContent(part: unknown): part is LanguageFileContent {
  return typeof part === 'object' && part !== null && (part as LanguageFileContent).type === 'file';
}

function encodeContentPart(part: LanguageTextContent | LanguageFileContent): ResponsesContentPart {
  if (part.type === 'text') {
    return { type: 'input_text', text: part.text };
  }
  if (part.type === 'file') {
    let url: string;
    if (part.data instanceof URL) {
      url = part.data.toString();
    } else if (typeof part.data === 'string') {
      url = part.data.startsWith('http') || part.data.startsWith('data:')
        ? part.data
        : `data:${part.mediaType};base64,${part.data}`;
    } else {
      const base64 = Buffer.from(part.data as Uint8Array).toString('base64');
      url = `data:${part.mediaType};base64,${base64}`;
    }
    return { type: 'input_image', image_url: url };
  }
  return { type: 'input_text', text: '' };
}

function encodeReasoning(reasoning: LanguageReasoningConfig): ResponsesReasoningConfig | undefined {
  if (!reasoning.enabled) return undefined;

  const effortMap: Record<string, 'low' | 'medium' | 'high'> = {
    'none': 'low',
    'minimal': 'low',
    'low': 'low',
    'medium': 'medium',
    'high': 'high',
    'xhigh': 'high',
  };

  const effort = reasoning.effort ? effortMap[reasoning.effort] ?? 'medium' : 'medium';
  return { effort };
}

function isDeveloperMessage(msg: LanguageMessage): boolean {
  return msg.role === 'system' && (msg as any).providerMetadata?.openai?.originalRole === 'developer';
}

function extractTextContent(msg: LanguageMessage): string {
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter(isTextContent)
      .map(p => p.text)
      .join('');
  }
  return '';
}

export function encodeInput(messages: LanguageMessage[]): { input: ResponsesInputItem[]; instructions?: string } {
  const input: ResponsesInputItem[] = [];
  let instructions: string | undefined;

  // Separate: system messages (→ instructions) vs developer messages (→ input with role:'developer')
  const systemTexts: string[] = [];
  for (const msg of messages) {
    if (msg.role === 'system' && !isDeveloperMessage(msg)) {
      systemTexts.push(extractTextContent(msg));
    }
  }
  if (systemTexts.length > 0) {
    instructions = systemTexts.join('\n\n');
  }

  for (const msg of messages) {
    // Skip non-developer system messages (they go to instructions)
    if (msg.role === 'system' && !isDeveloperMessage(msg)) continue;

    // Developer messages: emit as input items with role:'developer'
    if (isDeveloperMessage(msg)) {
      const text = extractTextContent(msg);
      input.push({
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text }],
      });
      continue;
    }

    if (msg.role === 'user') {
      const userMsg = msg as LanguageUserMessage;

      if (typeof userMsg.content === 'string') {
        input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: userMsg.content }] });
      } else if (Array.isArray(userMsg.content)) {
        if (userMsg.content.length === 1 && isTextContent(userMsg.content[0])) {
          input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: userMsg.content[0].text }] });
        } else {
          const parts = userMsg.content
            .filter(p => isTextContent(p) || isFileContent(p))
            .map(p => encodeContentPart(p as LanguageTextContent | LanguageFileContent));
          input.push({ type: 'message', role: 'user', content: parts });
        }
      }
    } else if (msg.role === 'assistant') {
      const assistantMsg = msg as LanguageAssistantMessage;

      if (typeof assistantMsg.content === 'string') {
        input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: assistantMsg.content }] });
        continue;
      }

      const contentArray = Array.isArray(assistantMsg.content) ? assistantMsg.content : [];
      const parts: ResponsesContentPart[] = [];
      const functionCalls: ResponsesInputItem[] = [];

      for (const part of contentArray) {
        if (isTextContent(part)) {
          parts.push({ type: 'output_text', text: part.text });
        } else if (part.type === 'tool-call') {
          const tc = part as LanguageToolCallContent;
          functionCalls.push({
            type: 'function_call',
            call_id: tc.toolCallId,
            name: tc.toolName,
            arguments: typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input),
          });
        }
      }

      if (parts.length > 0) {
        input.push({ type: 'message', role: 'assistant', content: parts });
      }
      input.push(...functionCalls);
    } else if (msg.role === 'tool') {
      for (const part of msg.content) {
        if (part.type === 'tool-result') {
          const tr = part;
          let output: string;

          if (tr.result.type === 'text' || tr.result.type === 'error-text') {
            output = String(tr.result.value);
          } else if (tr.result.type === 'json' || tr.result.type === 'error-json') {
            output = JSON.stringify(tr.result.value);
          } else if (tr.result.type === 'content') {
            output = tr.result.value.filter(isTextContent).map(p => p.text).join('');
          } else {
            output = '';
          }

          input.push({
            type: 'function_call_output',
            call_id: tr.toolCallId,
            output,
          });
        }
      }
    }
  }

  return { input, instructions };
}

function encodeTool(tool: LanguageTool): { type: 'function'; name: string; description?: string; parameters?: import('@synax-ai/sdk').JSONSchema } | undefined {
  if (tool.type !== 'function') return undefined;
  const funcTool = tool as LanguageFunctionTool;
  return {
    type: 'function',
    name: funcTool.name,
    description: funcTool.description,
    parameters: funcTool.inputSchema,
  };
}

export function encodeRequest(request: LanguageRequest): OpenAIResponsesRequest {
  const { input, instructions } = encodeInput(request.messages);
  const openaiOpts = (request as any).providerOptions?.openai as Record<string, any> | undefined;

  const encoded: OpenAIResponsesRequest = {
    model: request.model,
    input,
    stream: true,
  };

  // Instructions: prefer providerOptions.openai.instructions, fall back to system messages
  const effectiveInstructions = openaiOpts?.instructions ?? instructions;
  if (effectiveInstructions) encoded.instructions = effectiveInstructions;

  if (request.maxOutputTokens) encoded.max_output_tokens = request.maxOutputTokens;
  if (request.temperature !== undefined) encoded.temperature = request.temperature;
  if (request.topP !== undefined) encoded.top_p = request.topP;
  if ((request as any).frequencyPenalty !== undefined) encoded.frequency_penalty = (request as any).frequencyPenalty;
  if ((request as any).presencePenalty !== undefined) encoded.presence_penalty = (request as any).presencePenalty;
  if ((request as any).seed !== undefined) encoded.seed = (request as any).seed;
  if ((request as any).stopSequences !== undefined) encoded.stop = (request as any).stopSequences;

  if (request.tools && request.tools.length > 0) {
    encoded.tools = request.tools.map(encodeTool).filter((t): t is NonNullable<ReturnType<typeof encodeTool>> => t !== undefined);

    if (request.toolChoice) {
      if (request.toolChoice === 'auto' || request.toolChoice === 'none' || request.toolChoice === 'required') {
        encoded.tool_choice = request.toolChoice;
      } else if (typeof request.toolChoice === 'object' && request.toolChoice.type === 'function') {
        encoded.tool_choice = { type: 'function', name: request.toolChoice.function.name };
      }
    }
  }

  if (request.reasoning?.enabled) {
    encoded.reasoning = encodeReasoning(request.reasoning);
  } else if (openaiOpts?.reasoning) {
    encoded.reasoning = openaiOpts.reasoning;
  }

  // Forward provider-specific options
  if (openaiOpts?.parallelToolCalls !== undefined) encoded.parallel_tool_calls = openaiOpts.parallelToolCalls;
  if (openaiOpts?.store !== undefined) encoded.store = openaiOpts.store;
  if (openaiOpts?.include) encoded.include = openaiOpts.include;

  return encoded;
}
