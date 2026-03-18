import { ProxyAgent, fetch as undiciFetch } from 'undici';
import type { Logger } from '@synax-ai/sdk';

function formatBody(body: string): string {
  if (!body) return body;
  try {
    if (body.startsWith('{') || body.startsWith('[')) {
      return JSON.stringify(JSON.parse(body), null, 2);
    }
  } catch {}

  if (body.includes('event:') || body.includes('data:')) {
    return body.split('\n').map(line => {
      if (line.startsWith('event: ') || line.startsWith('data: ')) {
        return line;
      }
      if (line.includes('{') || line.includes('[')) {
        try {
          const prefix = line.startsWith('event: ') ? 'event: ' : 'data: ';
          const content = prefix === 'event: ' ? line.slice(7) : line.slice(6);
          const parsed = JSON.parse(content);
          return prefix + JSON.stringify(parsed, null, 2).split('\n').join('\n  ');
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
