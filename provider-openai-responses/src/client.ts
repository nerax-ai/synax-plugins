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
      if ((line.startsWith('data: ') || line.startsWith('event: ')) && (line.includes('{') || line.includes('['))) {
        try {
          const prefix = line.startsWith('data: ') ? 'data: ' : 'event: ';
          const content = line.startsWith('data: ') ? line.slice(6) : line.slice(7);
          if (content.includes('{')) {
            const parsed = JSON.parse(content);
            return prefix + JSON.stringify(parsed, null, 2).split('\n').join('\n  ');
          }
          return line;
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

    // Try to parse as JSON directly
    let data: T;
    try {
      data = JSON.parse(responseText) as T;
    } catch {
      // If the upstream returns SSE despite stream:false, reconstruct from events
      const reconstructed = reconstructFromSSE(responseText);
      if (reconstructed) {
        data = reconstructed as T;
      } else {
        throw new Error(`Failed to parse JSON response: ${responseText.substring(0, 200)}`);
      }
    }

    // Check for error field in response body (skip when error is null/undefined)
    if (data && typeof data === 'object' && 'error' in data && (data as any).error) {
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
): AsyncGenerator<{ event: string; data: unknown }> {
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
  let currentEvent = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      logger.debug(`[HTTP] [${id}] Stream line:\n${formatBody(trimmed)}`);

      if (trimmed.startsWith('event: ')) {
        currentEvent = trimmed.slice(7);
      } else if (trimmed.startsWith('data: ')) {
        const dataStr = trimmed.slice(6);
        try {
          const data = JSON.parse(dataStr);
          yield { event: currentEvent, data };
          currentEvent = '';
        } catch {
          // Skip invalid JSON
        }
      }
    }
  }
}

/**
 * Reconstruct an OpenAI Responses response object from SSE text.
 * Used when the upstream returns SSE despite stream:false.
 */
function reconstructFromSSE(sseText: string): unknown | null {
  const outputItems: any[] = [];
  const textBuffers = new Map<string, string>();
  const toolBuffers = new Map<string, string>();
  let completedResponse: any = null;

  for (const line of sseText.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const text = line.slice(6).trim();
    if (!text) continue;
    let event: any;
    try { event = JSON.parse(text); } catch { continue; }

    const type = event.type;

    if (type === 'response.output_item.added' && event.item) {
      const item = event.item;
      if (item.type === 'message') {
        outputItems.push({ ...item, content: [{ type: 'output_text', text: '' }] });
      } else if (item.type === 'function_call') {
        outputItems.push({ ...item });
        toolBuffers.set(item.id, '');
      } else {
        outputItems.push({ ...item });
      }
    }

    if (type === 'response.output_text.delta') {
      const buf = textBuffers.get(event.item_id) ?? '';
      textBuffers.set(event.item_id, buf + event.delta);
    }

    if (type === 'response.function_call_arguments.delta') {
      const buf = toolBuffers.get(event.item_id) ?? '';
      toolBuffers.set(event.item_id, buf + event.delta);
    }

    if (type === 'response.output_item.done' && event.item) {
      const item = event.item;
      const idx = outputItems.findIndex((o: any) => o.id === item.id);
      if (idx !== -1) {
        if (item.type === 'message') {
          outputItems[idx] = { ...item, content: [{ type: 'output_text', text: textBuffers.get(item.id) ?? '' }] };
        } else if (item.type === 'function_call') {
          outputItems[idx] = { ...item, arguments: toolBuffers.get(item.id) ?? item.arguments ?? '' };
        } else {
          outputItems[idx] = item;
        }
      }
    }

    if (type === 'response.completed' && event.response) {
      completedResponse = event.response;
    }
  }

  if (completedResponse) {
    return { ...completedResponse, output: outputItems };
  }
  return null;
}
