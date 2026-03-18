import type { Endpoint, EndpointContext } from '@synax-ai/sdk';
import { decodeRequest } from './request';
import { encodeResponse } from './response';
import { encodeStreamPart } from './streaming';

export function createChatCompletionsEndpoint(options: Record<string, unknown>): Endpoint {
  const basePath = (options.basePath as string) ?? '/';
  return {
    basePath,
    registerRoutes(app: any, ctx: EndpointContext) {
      app.post('/v1/chat/completions', async (c: any) => {
        const body = await c.req.json();
        ctx.logger.debug(`[API] [chat/completions] Request:\n${JSON.stringify(body, null, 2)}`);
        const req = decodeRequest(body);

        if (body.stream) {
          const signal: AbortSignal = c.req.raw.signal;
          const stream = ctx.language.stream({ ...req, abortSignal: signal });
          const id = `chatcmpl-${Math.random().toString(36).slice(2)}`;
          const model = req.model;

          return new Response(
            new ReadableStream({
              async start(controller) {
                const enc = new TextEncoder();
                try {
                  for await (const part of stream) {
                    if (signal.aborted) break;
                    const line = encodeStreamPart(part, model, id);
                    if (line) {
                      ctx.logger.debug(`[API] [chat/completions] SSE: ${line.trim()}`);
                      controller.enqueue(enc.encode(line));
                    }
                  }
                  controller.enqueue(enc.encode('data: [DONE]\n\n'));
                  controller.close();
                } catch (e: any) {
                  if (e?.name === 'AbortError') {
                    controller.close();
                    return;
                  }
                  const status = e?.statusCode ?? e?.status ?? 500;
                  ctx.logger.error(`[API] [chat/completions] stream error ${status}: ${e?.message ?? e}`);
                  controller.close();
                }
              },
            }),
            { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' } },
          );
        }

        const res = await ctx.language.generate(req);
        const encoded = encodeResponse(res);
        ctx.logger.debug(`[API] [chat/completions] Response:\n${JSON.stringify(encoded, null, 2)}`);
        return c.json(encoded);
      });
    },
  };
}
