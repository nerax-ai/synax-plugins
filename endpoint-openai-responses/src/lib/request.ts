import type { LanguageRequest, LanguageMessage } from '@synax-ai/sdk';

function decodeInput(input: any): LanguageMessage[] {
  if (typeof input === 'string') return [{ role: 'user', content: input }];
  if (!Array.isArray(input)) return [];

  return input.map((item: any): LanguageMessage => {
    const { type, role, content, call_id, name, arguments: args, output } = item;

    if (type === 'message' || role) {
      const msg: any = { role, type: 'message' };
      if (typeof content === 'string') {
        msg.content = content;
      } else if (Array.isArray(content)) {
        msg.content = content;
      }
      return msg;
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
