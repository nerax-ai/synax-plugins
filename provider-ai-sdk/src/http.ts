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

export function createFetch(id: string, logger: Logger, proxyUrl?: string): typeof globalThis.fetch {
  const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;

  return (async (url: string | URL | Request, init?: RequestInit) => {
    let reqBodyStr = '<binary>';
    if (init?.body && typeof init.body === 'string') {
      try {
        reqBodyStr = JSON.stringify(JSON.parse(init.body), null, 2);
      } catch (e) {
        reqBodyStr = init.body;
      }
    }

    logger.debug(`[HTTP] [${id}] Request:\nURL: ${url.toString()}\nMethod: ${init?.method ?? 'GET'}\nBody:\n${formatBody(reqBodyStr)}`);

    const response = await undiciFetch(url as any, { ...(init as object), dispatcher });

    if (!response.headers.get('content-type')?.includes('text/event-stream')) {
      const cloned = response.clone();
      try {
        const text = await cloned.text();
        let resBodyStr = text;
        logger.debug(`[HTTP] [${id}] Response:\nStatus: ${response.status}\nBody:\n${formatBody(resBodyStr)}`);
      } catch (e) {
        logger.debug(`[${id}] Response: <failed to parse body>`);
      }
    } else {
      // For SSE streams, wrap the response to log events
      const originalBody = response.body as any;
      const reader = originalBody.getReader();
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      
      const loggedStream = new ReadableStream({
        async pull(controller) {
          const { done, value } = await reader.read();
          if (done) {
            logger.debug(`[${id}] Stream done`);
            controller.close();
            return;
          }
          const chunk = decoder.decode(value, { stream: true });
          logger.debug(`[HTTP] [${id}] Stream chunk:\n${formatBody(chunk.trim())}`);
          controller.enqueue(encoder.encode(chunk));
        },
      });
      
      return new Response(loggedStream, {
        status: response.status,
        headers: response.headers as HeadersInit,
      }) as unknown as Response;
    }

    return response as unknown as Response;
  }) as any;
}
