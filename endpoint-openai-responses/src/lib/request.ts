import type { LanguageRequest, LanguageMessage } from '@synax-ai/sdk';

function decodeInput(input: any): LanguageMessage[] {
  if (typeof input === 'string') return [{ role: 'user', content: input }];
  if (!Array.isArray(input)) return [];

  // First pass: collect all tool call names
  const toolCallNames = new Map<string, string>();
  for (const item of input) {
    if (item.type === 'function_call' && item.call_id && item.name) {
      toolCallNames.set(item.call_id, item.name);
    }
  }

  return input.map((item: any): LanguageMessage | null => {
    const { type, role, content, call_id, name, arguments: args, output } = item;

    if (type === 'function_call') {
      return { role: 'assistant', content: [{ type: 'tool-call', toolCallId: call_id, toolName: name, input: args }] };
    }
    if (type === 'function_call_output') {
      let result;
      if (typeof output === 'string') {
        try {
          const parsed = JSON.parse(output);
          result = { type: 'json' as const, value: parsed };
        } catch {
          result = { type: 'text' as const, value: output };
        }
      } else {
        result = output ?? { type: 'text' as const, value: '' };
      }
      const toolName = name || toolCallNames.get(call_id) || '';
      return { role: 'tool', content: [{ type: 'tool-result', toolCallId: call_id, toolName, result }] };
    }

    if (type === 'message' || role) {
      const normalizedRole = role === 'developer' ? 'system' : role;

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

  const hasDeveloperRole = body.input?.some((item: any) => item.role === 'developer');

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
  if (hasDeveloperRole) openaiOptions.systemMessageMode = 'developer';

  if (Object.keys(openaiOptions).length > 0) {
    req.providerOptions = { openai: openaiOptions };
  }

  return req;
}
