import { ProxyAgent, fetch as undiciFetch } from 'undici';
import type { Logger } from '@synax-ai/sdk';

function formatBody(body: string): string {
  if (!body) return body;
  try {
    if (body.startsWith('{') || body.startsWith('[')) {
      return JSON.stringify(JSON.parse(body), null, 2);
    }
  } catch {}

  if (body.includes('data: {') || body.includes('data: [')) {
    return body.split('\n').map(line => {
      if (line.startsWith('data: ') && (line.includes('{') || line.includes('['))) {
        try {
          const parsed = JSON.parse(line.slice(6));
          return 'data: ' + JSON.stringify(parsed, null, 2).split('\n').join('\n  ');
        } catch {
          return line;
        }
      }
      return line;
    }).join('\n');
  }

  return body;
}

export interface HttpClientConfig {
  baseURL: string;
  headers: Record<string, string>;
  proxy?: string;
}

export function createHttpClient(id: string, logger: Logger, config: HttpClientConfig) {
  const dispatcher = config.proxy ? new ProxyAgent(config.proxy) : undefined;

  return async <T = unknown>(path: string, body: unknown, signal?: AbortSignal): Promise<T> => {
    const url = `${config.baseURL}${path}`;
    const reqBody = JSON.stringify(body);

    logger.debug(`[HTTP] [${id}] Request:\nURL: ${url}\nBody:\n${formatBody(reqBody)}`);

    const response = await undiciFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...config.headers,
      },
      body: reqBody,
      dispatcher,
      signal: signal as any,
    });

    const responseText = await response.text();

    if (!response.ok) {
      let errorMessage = responseText;
      try {
        const errorJson = JSON.parse(responseText);
        errorMessage = errorJson.error?.message || errorJson.message || responseText;
      } catch {}
      throw new Error(`HTTP ${response.status}: ${errorMessage}`);
    }

    // Handle SSE format response (some APIs return streaming format even for non-streaming requests)
    if (responseText.startsWith('data: ') || responseText.startsWith('event:')) {
      logger.debug(`[HTTP] [${id}] SSE format response detected, parsing chunks...`);

      // Parse SSE chunks and merge into a single response
      const lines = responseText.split('\n');
      let mergedContent = '';
      let toolCalls: Array<{ id: string; type: string; function: { name: string; arguments: string } }> = [];
      let toolCallMap = new Map<number, { id: string; type: string; function: { name: string; arguments: string } }>();
      let finishReason: string | null = null;
      let responseId: string | null = null;
      let model: string | null = null;
      let created: number | null = null;
      let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') continue;
        if (trimmed.startsWith('data: ')) {
          try {
            const jsonStr = trimmed.slice(6);
            const chunk = JSON.parse(jsonStr);
            if (chunk.id && !responseId) responseId = chunk.id;
            if (chunk.model && !model) model = chunk.model;
            if (chunk.created && !created) created = chunk.created;
            if (chunk.usage) usage = chunk.usage;

            const choice = chunk.choices?.[0];
            if (choice) {
              if (choice.finish_reason) finishReason = choice.finish_reason;
              const delta = choice.delta;
              if (delta?.content) {
                mergedContent += delta.content;
                logger.debug(`[HTTP] [${id}] SSE chunk content: "${delta.content.substring(0, 50)}"`);
              }
              if (delta?.tool_calls) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index ?? 0;
                  if (tc.id) {
                    toolCallMap.set(idx, {
                      id: tc.id,
                      type: 'function',
                      function: { name: tc.function?.name || '', arguments: '' }
                    });
                  }
                  if (tc.function?.arguments && toolCallMap.has(idx)) {
                    toolCallMap.get(idx)!.function.arguments += tc.function.arguments;
                  }
                }
              }
            }
          } catch (e) {
            logger.debug(`[HTTP] [${id}] Failed to parse SSE line: ${trimmed.substring(0, 100)}`);
          }
        }
      }

      logger.debug(`[HTTP] [${id}] SSE merged content length: ${mergedContent.length}`);
      toolCalls = Array.from(toolCallMap.values());

      // Construct a response object that matches the expected format
      const mergedResponse = {
        id: responseId || `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: created || Math.floor(Date.now() / 1000),
        model: model || 'unknown',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: mergedContent || null,
            tool_calls: toolCalls.length > 0 ? toolCalls : undefined
          },
          finish_reason: finishReason
        }],
        usage
      };

      logger.debug(`[HTTP] [${id}] Response (SSE merged):\n${formatBody(JSON.stringify(mergedResponse))}`);
      return mergedResponse as T;
    }

    // Try to parse as JSON and check for error in body (some APIs return 200 with error)
    let data: T;
    try {
      data = JSON.parse(responseText) as T;
    } catch (e) {
      throw new Error(`Failed to parse JSON response: ${responseText.substring(0, 200)}`);
    }

    // Check for error field in response body
    if (data && typeof data === 'object' && 'error' in data) {
      const errorObj = (data as any).error;
      const errorMessage = errorObj?.message || errorObj?.type || JSON.stringify(errorObj);
      throw new Error(`API Error: ${errorMessage}`);
    }

    logger.debug(`[HTTP] [${id}] Response:\n${formatBody(JSON.stringify(data))}`);
    return data;
  };
}

export async function* streamRequest(
  id: string,
  logger: Logger,
  config: HttpClientConfig,
  path: string,
  body: unknown,
  signal?: AbortSignal
): AsyncGenerator<string> {
  const url = `${config.baseURL}${path}`;
  const reqBody = JSON.stringify(body);

  logger.debug(`[HTTP] [${id}] Stream Request:\nURL: ${url}\nBody:\n${formatBody(reqBody)}`);

  const dispatcher = config.proxy ? new ProxyAgent(config.proxy) : undefined;

  const response = await undiciFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...config.headers,
    },
    body: reqBody,
    dispatcher,
    signal: signal as any,
  });

  if (!response.ok) {
    const errorText = await response.text();
    let errorMessage = errorText;
    try {
      const errorJson = JSON.parse(errorText);
      errorMessage = errorJson.error?.message || errorJson.message || errorText;
    } catch {}
    throw new Error(`HTTP ${response.status}: ${errorMessage}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && trimmed !== 'data: [DONE]') {
        logger.debug(`[HTTP] [${id}] Stream chunk:\n${formatBody(trimmed)}`);
        if (trimmed.startsWith('data: ')) {
          yield trimmed.slice(6);
        }
      }
    }
  }
}
