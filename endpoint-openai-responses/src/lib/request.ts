import type { LanguageRequest, LanguageMessage } from '@synax-ai/sdk';

function decodeInput(input: any): LanguageMessage[] {
  if (typeof input === 'string') return [{ role: 'user', content: input }];
  if (!Array.isArray(input)) return [];

  return input.map((item: any): LanguageMessage | null => {
    const { type, role, content, call_id, name, arguments: args, output } = item;

    if (type === 'message' || role) {
      const normalizedRole = role === 'developer' ? 'user' : role;
      if (typeof content === 'string') {
        return { role: normalizedRole, content };
      }
      if (Array.isArray(content)) {
        const parts = content
          .filter((p: any) => (p.type === 'input_text' || p.type === 'output_text') && p.text)
          .map((p: any) => ({ type: 'text' as const, text: p.text }));

        if (parts.length === 0) {
          return null as any;
        }

        return { role: normalizedRole, content: parts };
      }
      return { role: normalizedRole, content: '' };
    }
    if (type === 'function_call') return { role: 'assistant', content: [{ type: 'tool-call', toolCallId: call_id, toolName: name, input: args }] };
    if (type === 'function_call_output') {
      const result = typeof output === 'string' ? { type: 'text', value: output } : output ?? { type: 'text', value: '' };
      return { role: 'tool', content: [{ type: 'tool-result', toolCallId: call_id, toolName: name || '', result }] };
    }
    return { role: 'user', content: '' };
  }).filter((msg): msg is LanguageMessage => msg !== null);
}

export function decodeRequest(body: any): LanguageRequest {
  const tools = body.tools?.map((tool: any) => {
    const result: any = { ...tool };
    if (tool.parameters && !tool.inputSchema) {
      result.inputSchema = tool.parameters;
    }
    return result;
  });

  const req: any = {
    model: body.model,
    messages: decodeInput(body.input),
    maxOutputTokens: body.max_output_tokens ?? undefined,
    temperature: body.temperature ?? undefined,
    topP: body.top_p ?? undefined,
    topK: body.top_k ?? undefined,
    frequencyPenalty: body.frequency_penalty ?? undefined,
    presencePenalty: body.presence_penalty ?? undefined,
    stopSequences: body.stop ?? undefined,
    seed: body.seed ?? undefined,
    tools,
    toolChoice: body.tool_choice,
  };

  // Build provider options
  const openaiOptions: any = {};
  if (body.instructions) openaiOptions.instructions = body.instructions;
  if (body.parallel_tool_calls !== undefined) openaiOptions.parallelToolCalls = body.parallel_tool_calls;
  if (body.reasoning !== undefined) openaiOptions.reasoning = body.reasoning;
  if (body.store !== undefined) openaiOptions.store = body.store;
  if (body.include) openaiOptions.include = body.include;
  if (body.prompt_cache_key) openaiOptions.promptCacheKey = body.prompt_cache_key;

  if (Object.keys(openaiOptions).length > 0) {
    req.providerOptions = { openai: openaiOptions };
  }

  return req;
}
