import type {
  LanguageRequest,
  LanguageMessage,
  LanguageTextContent,
  LanguageFileContent,
  LanguageToolCallContent,
  LanguageTool,
  LanguageUserMessage,
  LanguageAssistantMessage,
} from '@synax-ai/sdk';
import type { OpenAIMessage, OpenAIChatRequest, OpenAITool, OpenAIContentPart } from './types';

function isTextContent(part: unknown): part is LanguageTextContent {
  return typeof part === 'object' && part !== null && (part as LanguageTextContent).type === 'text';
}

function isFileContent(part: unknown): part is LanguageFileContent {
  return typeof part === 'object' && part !== null && (part as LanguageFileContent).type === 'file';
}

function encodeContentPart(part: LanguageTextContent | LanguageFileContent): OpenAIContentPart | string {
  if (part.type === 'text') return part.text;
  if (part.type === 'file') {
    if (part.data instanceof URL) {
      return { type: 'image_url', image_url: { url: part.data.toString() } };
    }
    const data = typeof part.data === 'string' ? part.data : Buffer.from(part.data as Uint8Array).toString('base64');
    if (part.data instanceof Uint8Array || typeof part.data !== 'string') {
      return { type: 'image_url', image_url: { url: `data:${part.mediaType};base64,${data}` } };
    }
    // Assume it's a URL string or base64 string
    if (data.startsWith('http://') || data.startsWith('https://') || data.startsWith('data:')) {
      return { type: 'image_url', image_url: { url: data } };
    }
    return { type: 'image_url', image_url: { url: `data:${part.mediaType};base64,${data}` } };
  }
  return '';
}

function encodeTool(tool: LanguageTool): OpenAITool | undefined {
  if (tool.type !== 'function') return undefined;
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

export function encodeMessages(messages: LanguageMessage[]): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      result.push({
        role: 'system',
        content: typeof msg.content === 'string' ? msg.content : '',
      });
    } else if (msg.role === 'user') {
      const userMsg = msg as LanguageUserMessage;

      if (typeof userMsg.content === 'string') {
        result.push({ role: 'user', content: userMsg.content });
      } else if (Array.isArray(userMsg.content)) {
        if (userMsg.content.length === 1 && isTextContent(userMsg.content[0])) {
          result.push({ role: 'user', content: userMsg.content[0].text });
        } else {
          const parts = userMsg.content
            .filter(p => isTextContent(p) || isFileContent(p))
            .map(p => encodeContentPart(p as LanguageTextContent | LanguageFileContent))
            .filter((p): p is OpenAIContentPart => typeof p !== 'string');
          result.push({ role: 'user', content: parts });
        }
      } else {
        result.push({ role: 'user', content: '' });
      }
    } else if (msg.role === 'assistant') {
      const assistantMsg = msg as LanguageAssistantMessage;

      if (typeof assistantMsg.content === 'string') {
        result.push({ role: 'assistant', content: assistantMsg.content });
        continue;
      }

      const contentArray = Array.isArray(assistantMsg.content) ? assistantMsg.content : [];
      const hasToolCalls = contentArray.some(p => p.type === 'tool-call');

      if (hasToolCalls) {
        const toolCalls = contentArray
          .filter((p): p is LanguageToolCallContent => p.type === 'tool-call')
          .map(tc => ({
            id: tc.toolCallId,
            type: 'function' as const,
            function: {
              name: tc.toolName,
              arguments: typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input),
            },
          }));

        const textContent = contentArray
          .filter(isTextContent)
          .map(p => p.text)
          .join('');

        result.push({
          role: 'assistant',
          content: textContent || undefined,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        });
      } else {
        const content = contentArray
          .filter(isTextContent)
          .map(p => p.text)
          .join('');
        result.push({ role: 'assistant', content: content || undefined });
      }
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
            output = tr.result.value.map(p => (isTextContent(p) ? p.text : '')).join('');
          } else {
            output = '';
          }

          result.push({
            role: 'tool',
            tool_call_id: tr.toolCallId,
            content: output,
          });
        }
      }
    }
  }

  return result;
}

export function encodeRequest(request: LanguageRequest): OpenAIChatRequest {
  const encoded: OpenAIChatRequest = {
    model: request.model,
    messages: encodeMessages(request.messages),
    stream: true,
  };

  if (request.maxOutputTokens !== undefined) encoded.max_tokens = request.maxOutputTokens;
  if (request.temperature !== undefined) encoded.temperature = request.temperature;
  if (request.topP !== undefined) encoded.top_p = request.topP;
  if (request.stopSequences !== undefined && request.stopSequences.length > 0) {
    encoded.stop = request.stopSequences;
  }

  if (request.tools && request.tools.length > 0) {
    encoded.tools = request.tools.map(encodeTool).filter((t): t is OpenAITool => t !== undefined);
    if (request.toolChoice) {
      if (request.toolChoice === 'auto' || request.toolChoice === 'none' || request.toolChoice === 'required') {
        encoded.tool_choice = request.toolChoice;
      } else if (typeof request.toolChoice === 'object' && request.toolChoice.type === 'function') {
        encoded.tool_choice = { type: 'function', function: { name: request.toolChoice.function.name } };
      }
    }
  }

  if (request.responseFormat) {
    if (request.responseFormat.type === 'json-object') {
      encoded.response_format = { type: 'json_object' };
    } else if (request.responseFormat.type === 'json-schema' && request.responseFormat.schema) {
      encoded.response_format = {
        type: 'json_schema',
        json_schema: {
          name: request.responseFormat.name || 'schema',
          schema: request.responseFormat.schema,
          strict: request.responseFormat.strict,
        },
      };
    }
  }

  return encoded;
}
