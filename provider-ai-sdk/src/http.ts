import { ProxyAgent, fetch as undiciFetch } from 'undici';
import type { Logger } from '@synax-ai/sdk';

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

    logger.debug(`[${id}] Request:\nURL: ${url.toString()}\nMethod: ${init?.method ?? 'GET'}\nBody:\n${reqBodyStr}`);

    const response = await undiciFetch(url as any, { ...(init as object), dispatcher });

    if (!response.headers.get('content-type')?.includes('text/event-stream')) {
      const cloned = response.clone();
      try {
        const text = await cloned.text();
        let resBodyStr = text;
        try {
          if (text.startsWith('{')) resBodyStr = JSON.stringify(JSON.parse(text), null, 2);
        } catch (e) {}
        logger.debug(`[${id}] Response:\nStatus: ${response.status}\nBody:\n${resBodyStr}`);
      } catch (e) {
        logger.debug(`[${id}] Response: <failed to parse body>`);
      }
    } else {
      logger.debug(`[${id}] Response:\nStatus: ${response.status}\nBody: <stream>`);
    }

    return response as unknown as Response;
  }) as any;
}
