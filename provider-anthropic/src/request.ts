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
} from '@synax-ai/sdk';
import type { AnthropicMessagesRequest, AnthropicContentBlock, AnthropicMessage, AnthropicTool, AnthropicToolChoice, AnthropicThinkingConfig } from './types';

function isTextContent(part: unknown): part is LanguageTextContent {
  return typeof part === 'object' && part !== null && (part as LanguageTextContent).type === 'text';
}

function isFileContent(part: unknown): part is LanguageFileContent {
  return typeof part === 'object' && part !== null && (part as LanguageFileContent).type === 'file';
}

function encodeContentPart(part: LanguageTextContent | LanguageFileContent): AnthropicContentBlock {
  if (part.type === 'text') {
    return { type: 'text', text: part.text };
  }
  if (part.type === 'file') {
    let data: string;
    const mediaType = part.mediaType;

    if (part.data instanceof URL) {
      return {
        type: 'image',
        source: {
          type: 'url',
          url: part.data.toString(),
        },
      };
    }

    if (typeof part.data === 'string') {
      if (part.data.startsWith('http://') || part.data.startsWith('https://')) {
        return {
          type: 'image',
          source: {
            type: 'url',
            url: part.data,
          },
        };
      }
      data = part.data;
    } else if (part.data instanceof Uint8Array) {
      data = Buffer.from(part.data).toString('base64');
    } else {
      data = String(part.data);
    }

    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: mediaType,
        data,
      },
    };
  }

  return { type: 'text', text: '' };
}

function encodeThinking(reasoning: LanguageReasoningConfig): AnthropicThinkingConfig | undefined {
  if (!reasoning.enabled) return undefined;

  if (reasoning.maxTokens) {
    return {
      type: 'enabled',
      budget_tokens: reasoning.maxTokens,
    };
  }

  const effortMap: Record<string, 'low' | 'medium' | 'high'> = {
    'none': 'low',
    'minimal': 'low',
    'low': 'low',
    'medium': 'medium',
    'high': 'high',
    'xhigh': 'high',
  };

  const effort = reasoning.effort ? effortMap[reasoning.effort] ?? 'medium' : 'medium';
  const budgetMap: Record<string, number> = {
    'low': 1024,
    'medium': 2048,
    'high': 4096,
  };

  return { type: 'enabled', budget_tokens: budgetMap[effort] };
}

export function encodeMessages(messages: LanguageMessage[]): { messages: AnthropicMessage[]; system: string | undefined } {
  const result: AnthropicMessage[] = [];
  const systemParts: string[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      // System message content is always a string in the SDK
      systemParts.push(msg.content);
      continue;
    }

    if (msg.role === 'user') {
      const userMsg = msg as LanguageUserMessage;

      if (typeof userMsg.content === 'string') {
        result.push({ role: 'user', content: [{ type: 'text', text: userMsg.content }] });
      } else if (Array.isArray(userMsg.content)) {
        const parts = userMsg.content
          .filter(p => isTextContent(p) || isFileContent(p))
          .map(p => encodeContentPart(p as LanguageTextContent | LanguageFileContent));
        result.push({ role: 'user', content: parts });
      }
      continue;
    }

    if (msg.role === 'assistant') {
      const assistantMsg = msg as LanguageAssistantMessage;

      if (typeof assistantMsg.content === 'string') {
        result.push({ role: 'assistant', content: [{ type: 'text', text: assistantMsg.content }] });
        continue;
      }

      const contentArray = Array.isArray(assistantMsg.content) ? assistantMsg.content : [];
      const content: AnthropicContentBlock[] = [];

      for (const part of contentArray) {
        if (isTextContent(part)) {
          content.push({ type: 'text', text: part.text });
        } else if (part.type === 'reasoning') {
          const reasoningText = typeof part.reasoning === 'string' ? part.reasoning : '';
          content.push({ type: 'thinking', thinking: reasoningText });
        } else if (part.type === 'tool-call') {
          const tc = part as LanguageToolCallContent;
          content.push({
            type: 'tool_use',
            id: tc.toolCallId,
            name: tc.toolName,
            input: typeof tc.input === 'string' ? JSON.parse(tc.input) : tc.input,
          });
        }
      }

      if (content.length > 0) {
        result.push({ role: 'assistant', content });
      }
      continue;
    }

    if (msg.role === 'tool') {
      for (const part of msg.content) {
        if (part.type === 'tool-result') {
          const tr = part;
          let outputContent: string;

          if (tr.result.type === 'text' || tr.result.type === 'error-text') {
            outputContent = String(tr.result.value);
          } else if (tr.result.type === 'json' || tr.result.type === 'error-json') {
            outputContent = JSON.stringify(tr.result.value);
          } else if (tr.result.type === 'content') {
            outputContent = tr.result.value.filter(isTextContent).map(p => p.text).join('');
          } else {
            outputContent = '';
          }

          result.push({
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: tr.toolCallId,
              content: outputContent,
              is_error: tr.isError,
            }],
          });
        }
      }
    }
  }

  const system = systemParts.length > 0 ? systemParts.join('\n\n') : undefined;

  return { messages: result, system };
}

function encodeTool(tool: LanguageTool): AnthropicTool | undefined {
  if (tool.type !== 'function') return undefined;
  const funcTool = tool as LanguageFunctionTool;
  return {
    name: funcTool.name,
    description: funcTool.description,
    input_schema: funcTool.inputSchema,
  };
}

export function encodeTools(tools: LanguageTool[] | undefined): AnthropicTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map(encodeTool).filter((t): t is AnthropicTool => t !== undefined);
}

export function encodeToolChoice(choice: LanguageRequest['toolChoice']): AnthropicToolChoice | undefined {
  if (!choice) return undefined;

  if (choice === 'auto') return { type: 'auto' };
  if (choice === 'none') return { type: 'any' };
  if (choice === 'required') return { type: 'any' };

  if (typeof choice === 'object' && choice.type === 'function') {
    return { type: 'tool', name: choice.function.name };
  }

  return undefined;
}

export function encodeRequest(request: LanguageRequest): AnthropicMessagesRequest {
  const { messages, system } = encodeMessages(request.messages);
  const tools = encodeTools(request.tools);
  const toolChoice = encodeToolChoice(request.toolChoice);
  const thinking = request.reasoning ? encodeThinking(request.reasoning) : undefined;

  const encoded: AnthropicMessagesRequest = {
    model: request.model,
    messages,
    max_tokens: request.maxOutputTokens ?? 4096,
    stream: true,
  };

  if (system) encoded.system = system;
  if (request.temperature !== undefined) encoded.temperature = request.temperature;
  if (request.topP !== undefined) encoded.top_p = request.topP;
  if (request.topK !== undefined) encoded.top_k = request.topK;
  if (request.stopSequences) encoded.stop_sequences = request.stopSequences;
  if (tools) encoded.tools = tools;
  if (toolChoice) encoded.tool_choice = toolChoice;
  if (thinking) encoded.thinking = thinking;

  return encoded;
}
