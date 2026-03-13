import type { LanguageRequest, LanguageMessage } from '@synax-ai/sdk';

function decodeInput(input: any): LanguageMessage[] {
  if (typeof input === 'string') return [{ role: 'user', content: input }];
  if (!Array.isArray(input)) return [];

  return input.map((item: any): LanguageMessage => {
    const { type, role, content, call_id, name, arguments: args, output } = item;
    const normalizedRole = role === 'developer' ? 'system' : role;

    if (type === 'message' || role) {
      if (typeof content === 'string') {
        return { role: normalizedRole, content };
      }
      if (Array.isArray(content)) {
        const parts = content.map((p: any) => {
          if (p.type === 'input_text' || p.type === 'output_text') {
            return { type: 'text', text: p.text };
          }
          return p;
        });
        return { role: normalizedRole, content: parts };
      }
      return { role: normalizedRole, content: '' };
    }
    if (type === 'function_call') return { role: 'assistant', content: [{ type: 'tool-call', toolCallId: call_id, toolName: name, input: args }] };
    if (type === 'function_call_output') return { role: 'tool', content: [{ type: 'tool-result', toolCallId: call_id, toolName: '', result: output ?? '' }] };
    return { role: 'user', content: '' };
  });
}

export function decodeRequest(body: any): LanguageRequest {
  const tools = body.tools?.map((tool: any) => {
    if (tool.parameters && !tool.inputSchema) {
      return { ...tool, inputSchema: tool.parameters };
    }
    return tool;
  });

  return {
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
}
