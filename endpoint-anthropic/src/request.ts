import type { LanguageRequest, LanguageMessage, LanguageTool, LanguageTextContent, LanguageFileContent, LanguageSystemMessage } from '@synax-ai/sdk';

export function decodeMessages(messages: any[]): LanguageMessage[] {
  const missingIds = new Map<string, string>();
  const toolResultIds = new Map<string, string>();
  const toolNameMap = new Map<string, string>();
  let lastAssIdx = -1;

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'assistant') {
      lastAssIdx = i;
      if (Array.isArray(m.content)) {
        let bi = 0;
        for (const p of m.content) {
          if (p.type === 'tool_use') {
            const id = p.id ?? crypto.randomUUID();
            if (!p.id) missingIds.set(`${i}:${bi}`, id);
            if (p.name) toolNameMap.set(id, p.name);
            bi++;
          }
        }
      }
    } else if (m.role === 'user' && Array.isArray(m.content)) {
      let ri = 0;
      for (const p of m.content) {
        if (p.type === 'tool_result') {
          if (!p.tool_use_id && lastAssIdx >= 0) {
            toolResultIds.set(`${i}:${ri}`, missingIds.get(`${lastAssIdx}:${ri}`) ?? crypto.randomUUID());
          }
          ri++;
        }
      }
    }
  }

  return messages.map((m, i): LanguageMessage => {
    if (m.role === 'system') {
      if (typeof m.content === 'string') {
        return { role: 'system', content: [{ type: 'text' as const, text: m.content }] };
      }
      if (Array.isArray(m.content)) {
        return {
          role: 'system',
          content: m.content.map((p: any): LanguageTextContent => {
            if (typeof p === 'string') return { type: 'text' as const, text: p };
            return {
              type: 'text' as const,
              text: p.text || '',
              ...(p.cache_control && { cacheControl: p.cache_control })
            };
          })
        };
      }
      return { role: 'system', content: [{ type: 'text' as const, text: String(m.content ?? '') }] };
    }

    if (m.role === 'user') {
      if (!Array.isArray(m.content)) {
        return { role: 'user', content: [{ type: 'text' as const, text: m.content ?? '' }] };
      }
      const toolResults = m.content.filter((p: any) => p.type === 'tool_result');
      if (toolResults.length) {
        return {
          role: 'tool',
          content: toolResults.map((p: any, ri: number) => {
            const id = p.tool_use_id ?? toolResultIds.get(`${i}:${ri}`) ?? crypto.randomUUID();
            const resultContent = Array.isArray(p.content)
              ? p.content.map((c: any) => c.text).join('')
              : (p.content ?? '');
            return {
              type: 'tool-result' as const,
              toolCallId: id,
              toolName: toolNameMap.get(id) ?? id,
              output: { type: 'text' as const, value: resultContent },
              isError: p.is_error ?? false,
            };
          }),
        };
      }
      return {
        role: 'user',
        content: m.content.map((p: any): LanguageTextContent | LanguageFileContent => {
          if (p.type === 'text') {
            return {
              type: 'text' as const,
              text: p.text,
              ...(p.cache_control && { cacheControl: p.cache_control })
            };
          }
          if (p.type === 'image') return {
            type: 'file' as const,
            data: p.source.url ?? p.source.data,
            mediaType: p.source.media_type ?? 'image/jpeg',
            ...(p.cache_control && { cacheControl: p.cache_control })
          };
          return { type: 'text' as const, text: '' };
        }),
      };
    }

    if (m.role === 'assistant') {
      if (!Array.isArray(m.content)) {
        return { role: 'assistant', content: [{ type: 'text' as const, text: m.content ?? '' }] };
      }
      let bi = 0;
      return {
        role: 'assistant',
        content: m.content.map((p: any) => {
          if (p.type === 'text') {
            return {
              type: 'text' as const,
              text: p.text,
              ...(p.cache_control && { cacheControl: p.cache_control })
            };
          }
          if (p.type === 'thinking') return { type: 'reasoning' as const, reasoning: p.thinking };
          if (p.type === 'tool_use') {
            const id = p.id ?? missingIds.get(`${i}:${bi++}`) ?? crypto.randomUUID();
            return {
              type: 'tool-call' as const,
              toolCallId: id,
              toolName: p.name,
              input: p.input,
              ...(p.cache_control && { cacheControl: p.cache_control })
            };
          }
          return { type: 'text' as const, text: '' };
        }),
      };
    }

    return { role: 'user', content: [{ type: 'text' as const, text: '' }] };
  });
}

export function decodeRequest(body: any): LanguageRequest {
  let messages = decodeMessages(body.messages ?? []);

  // Handle system prompt if provided as a separate field by prepending it to messages
  if (body.system) {
    let systemContent: LanguageTextContent[];
    if (typeof body.system === 'string') {
      systemContent = [{ type: 'text' as const, text: body.system }];
    } else if (Array.isArray(body.system)) {
      systemContent = body.system.map((part: any): LanguageTextContent => {
        if (typeof part === 'string') return { type: 'text' as const, text: part };
        return {
          type: 'text' as const,
          text: part.text || '',
          ...(part.cache_control && { cacheControl: part.cache_control })
        };
      });
    } else {
      systemContent = [{ type: 'text' as const, text: String(body.system) }];
    }
    
    messages.unshift({ role: 'system', content: systemContent });
  }

  const decoded: LanguageRequest = {
    model: body.model || 'default',
    messages,
    maxOutputTokens: body.max_tokens,
    temperature: body.temperature,
    topP: body.top_p,
    topK: body.top_k,
    stopSequences: body.stop_sequences,
    tools: body.tools?.map((t: any) => ({
      type: 'function' as const,
      name: t.name,
      description: t.description,
      inputSchema: t.input_schema,
    })),
    toolChoice: body.tool_choice,
    providerOptions: body.provider_options,
    extra: body.metadata ? { metadata: body.metadata } : {},
  };

  // Map output_config to reasoning and responseFormat
  if (body.output_config) {
    if (body.output_config.effort) {
      decoded.reasoning = {
        enabled: true,
        effort: body.output_config.effort
      };
    }
    if (body.output_config.format) {
      decoded.responseFormat = {
        type: body.output_config.format.type === 'json_schema' ? 'json-schema' : 
              body.output_config.format.type === 'json_object' ? 'json-object' : 'text',
        schema: body.output_config.format.schema,
      };
    }
  }

  return decoded;
}
