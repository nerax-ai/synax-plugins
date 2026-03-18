import type { LanguageResponse, LanguageToolCallContent, LanguageTextContent } from '@synax-ai/sdk';

export function encodeResponse(res: LanguageResponse): any {
  const choice = res.choices[0];
  const content = choice?.message?.content;

  // Extract text content from array or use string directly
  let textContent: string | null = null;
  if (typeof content === 'string') {
    textContent = content;
  } else if (Array.isArray(content)) {
    const textParts = content.filter((p): p is LanguageTextContent => p.type === 'text');
    if (textParts.length > 0) {
      textContent = textParts.map(p => p.text).join('');
    }
  }

  const toolCalls = Array.isArray(content)
    ? content.filter((p): p is LanguageToolCallContent => p.type === 'tool-call').map((p) => ({
        id: p.toolCallId,
        type: 'function',
        function: { name: p.toolName, arguments: typeof p.input === 'string' ? p.input : JSON.stringify(p.input) },
      }))
    : undefined;

  return {
    id: res.id,
    object: 'chat.completion',
    created: res.created,
    model: res.model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: textContent,
        tool_calls: toolCalls?.length ? toolCalls : undefined,
      },
      finish_reason: choice?.finishReason ?? 'stop',
    }],
    usage: res.usage ? {
      prompt_tokens: res.usage.inputTokens.total,
      completion_tokens: res.usage.outputTokens.total,
      total_tokens: (res.usage.inputTokens.total ?? 0) + (res.usage.outputTokens.total ?? 0),
    } : undefined,
  };
}
