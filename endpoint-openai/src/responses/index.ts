import type { Endpoint, EndpointContext } from '@synax-ai/sdk';
import { decodeRequest } from './request';
import { encodeResponse } from './response';
import { StreamEncoder, sseEvent } from './streaming';

export function createResponsesEndpoint(options: Record<string, unknown>): Endpoint {
  const basePath = (options.basePath as string) ?? '/';
  return {
    basePath,
    registerRoutes(app: any, ctx: EndpointContext) {
      const log = ctx.logger;

      app.post('/v1/responses', async (c: any) => {
        const body = await c.req.json();
        log.debug(`[API] [responses] Request:\n${JSON.stringify(body, null, 2)}`);
        const req = decodeRequest(body);

        if (body.stream) {
          const signal: AbortSignal = c.req.raw.signal;
          const stream = ctx.language.stream({ ...req, abortSignal: signal });
          const id = `resp_${Math.random().toString(36).slice(2)}`;
          const encoder = new StreamEncoder();

          return new Response(
            new ReadableStream({
              async start(controller) {
                const enc = new TextEncoder();
                controller.enqueue(enc.encode(sseEvent('response.created', { response: { id, object: 'response', created_at: Math.floor(Date.now() / 1000), model: req.model, status: 'in_progress' } })));
                try {
                  for await (const part of stream) {
                    if (signal.aborted) break;
                    log.debug(`[API] [responses] Stream part:\n${JSON.stringify(part, null, 2)}`);
                    if (part.type === 'response-metadata') continue;
                    const line = encoder.encode(part, req.model, id);
                    if (line) {
                      log.debug(`[API] [responses] SSE: ${line.trim()}`);
                      controller.enqueue(enc.encode(line));
                    }
                  }
                  log.debug(`[API] [responses] Stream completed`);
                  controller.close();
                } catch (e: any) {
                  if (e?.name === 'AbortError') {
                    controller.close();
                    return;
                  }
                  const status = e?.statusCode ?? e?.status ?? 500;
                  log.error(`[API] [responses] stream error ${status}: ${e?.message ?? e}`);
                  controller.close();
                }
              },
            }),
            { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' } },
          );
        }

        const res = await ctx.language.generate(req);
        const encoded = encodeResponse(res, res.usage?.inputTokens.total ?? 0);
        log.debug(`[API] [responses] Response:\n${JSON.stringify(encoded, null, 2)}`);
        return c.json(encoded);
      });
    },
  };
}
