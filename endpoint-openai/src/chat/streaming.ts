import type { LanguageStreamPart } from '@synax-ai/sdk';

export function encodeStreamPart(part: LanguageStreamPart, model: string, id: string): string | null {
  const chunk = (delta: any, finish_reason: string | null = null) =>
    `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`;

  // Note: OpenAI Chat Completions API doesn't support reasoning in streaming
  // So we skip reasoning events here (only Responses API supports it)

  if (part.type === 'text-delta') return chunk({ content: part.delta });
  if (part.type === 'tool-input-start') return chunk({ tool_calls: [{ index: 0, id: part.id, type: 'function', function: { name: part.toolName, arguments: '' } }] });
  if (part.type === 'tool-input-delta') return chunk({ tool_calls: [{ index: 0, function: { arguments: part.delta } }] });
  if (part.type === 'tool-input-end') return null;
  if (part.type === 'finish') return chunk({}, part.finishReason ?? 'stop');
  return null;
}
