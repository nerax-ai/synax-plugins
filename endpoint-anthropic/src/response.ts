import type { LanguageResponse, LanguageToolCallContent } from '@synax-ai/sdk';

function encodeFinishReason(reason: string | null): string {
  if (reason === 'stop') return 'end_turn';
  if (reason === 'length') return 'max_tokens';
  if (reason === 'tool-calls') return 'tool_use';
  return 'end_turn';
}

export function encodeResponse(res: LanguageResponse): any {
  const choice = res.choices[0];
  const content = choice?.message?.content;
  const blocks: any[] = [];

  if (Array.isArray(content)) {
    for (const p of content) {
      if (p.type === 'text') blocks.push({ type: 'text', text: p.text });
      else if (p.type === 'reasoning') {
        const reasoning = (p as any).reasoning;
        let thinkingText = '';
        if (Array.isArray(reasoning)) {
          thinkingText = reasoning.map((r: any) => r.text ?? '').join('');
        } else if (typeof reasoning === 'string') {
          thinkingText = reasoning;
        }
        blocks.push({ type: 'thinking', thinking: thinkingText });
      }
      else if (p.type === 'tool-call') {
        const tc = p as LanguageToolCallContent;
        blocks.push({
          type: 'tool_use',
          id: tc.toolCallId,
          name: tc.toolName,
          input: typeof tc.input === 'string' ? JSON.parse(tc.input) : tc.input
        });
      }
    }
  }

  return {
    id: res.id,
    type: 'message',
    role: 'assistant',
    model: res.model,
    content: blocks,
    stop_reason: encodeFinishReason(choice?.finishReason ?? null),
    usage: res.usage ? {
      input_tokens: res.usage.inputTokens.total ?? 0,
      output_tokens: res.usage.outputTokens.total ?? 0,
    } : undefined,
  };
}
