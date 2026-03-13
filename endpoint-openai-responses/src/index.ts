import type {
  Endpoint,
  EndpointContext,
} from '@synax-ai/sdk';
import { decodeRequest } from './lib/request';
import { encodeResponse } from './lib/response';
import { StreamEncoder } from './lib/streaming';

function sse(event: string, data: object): string {
  return `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`;
}

function createOpenAIResponsesEndpoint(options: Record<string, unknown>): Endpoint {
  const basePath = (options.basePath as string) ?? '/';
  return {
    basePath,
    registerRoutes(app: any, ctx: EndpointContext) {
      const log = ctx.logger;

      app.post('/v1/responses', async (c: any) => {
        const body = await c.req.json();
        log.debug(`[openai-responses] Request:\n${JSON.stringify(body, null, 2)}`);
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
                controller.enqueue(enc.encode(sse('response.created', { response: { id, object: 'response', created_at: Math.floor(Date.now() / 1000), model: req.model, status: 'in_progress' } })));
                try {
                  for await (const part of stream) {
                    if (signal.aborted) break;
                    log.debug(`[openai-responses] Stream part: ${JSON.stringify(part)}`);
                    if (part.type === 'response-metadata') continue;
                    const line = encoder.encode(part, req.model, id);
                    if (line) {
                      log.debug(`[openai-responses] SSE: ${line.trim()}`);
                      controller.enqueue(enc.encode(line));
                    }
                  }
                  log.debug(`[openai-responses] Stream completed`);
                  controller.close();
                } catch (e: any) {
                  const status = e?.statusCode ?? e?.status ?? 500;
                  log.error(`[openai-responses] stream error ${status}: ${e?.message ?? e}`);
                  controller.close();
                }
              },
            }),
            { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' } },
          );
        }

        const res = await ctx.language.generate(req);
        const encoded = encodeResponse(res, res.usage?.inputTokens.total ?? 0);
        log.debug(`[openai-responses] Response:\n${JSON.stringify(encoded, null, 2)}`);
        return c.json(encoded);
      });

      app.get('/v1/models', (c: any) => {
        const models = ctx.models();
        return c.json({
          object: 'list',
          data: models.map((m) => ({ id: m.id, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: m.ownedBy ?? 'synax' })),
        });
      });
    },
  };
}

export function setup(ctx: { register(type: 'endpoint', id: string, factory: (options: Record<string, unknown>) => Endpoint): void }) {
  ctx.register('endpoint', 'openai-responses', createOpenAIResponsesEndpoint);
}
