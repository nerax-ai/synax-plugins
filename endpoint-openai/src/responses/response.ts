import type { LanguageResponse, LanguageToolCallContent } from '@synax-ai/sdk';

function encodeFinishReason(r: string | null): string {
  if (r === 'tool-calls') return 'tool_calls';
  if (r === 'length') return 'max_output_tokens';
  return 'stop';
}

export function encodeResponse(res: LanguageResponse, inputTokens: number): any {
  const choice = res.choices[0];
  const content = choice?.message?.content;
  const output: any[] = [];

  const textParts: string[] = [];
  const toolCalls: any[] = [];
  let reasoningContent = '';

  if (Array.isArray(content)) {
    for (const p of content) {
      if (p.type === 'text') textParts.push(p.text);
      else if (p.type === 'reasoning') {
        const reasoning = (p as any).reasoning;
        if (Array.isArray(reasoning)) {
          reasoningContent = reasoning.map((r: any) => r.text ?? '').join('');
        } else if (typeof reasoning === 'string') {
          reasoningContent = reasoning;
        }
      }
      else if (p.type === 'tool-call') {
        const tc = p as LanguageToolCallContent;
        toolCalls.push({ type: 'function_call', id: `fc_${tc.toolCallId}`, call_id: tc.toolCallId, name: tc.toolName, arguments: typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input) });
      }
    }
  }

  if (reasoningContent) {
    output.push({ type: 'reasoning', id: `rs_${res.id}`, encrypted_content: reasoningContent, status: 'completed' });
  }

  if (textParts.length) {
    output.push({ type: 'message', id: `msg_${res.id}`, role: 'assistant', content: [{ type: 'output_text', text: textParts.join('') }], status: 'completed' });
  }
  output.push(...toolCalls);

  return {
    id: res.id,
    object: 'response',
    created_at: res.created,
    model: res.model,
    output,
    status: 'completed',
    stop_reason: encodeFinishReason(choice?.finishReason ?? null),
    usage: {
      input_tokens: inputTokens,
      output_tokens: res.usage?.outputTokens.total ?? 0,
      total_tokens: inputTokens + (res.usage?.outputTokens.total ?? 0),
    },
  };
}
