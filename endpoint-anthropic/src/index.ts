import type { Endpoint, EndpointContext, Schema } from '@synax-ai/sdk';
import { decodeRequest } from './request';
import { encodeResponse } from './response';
import { StreamEncoder } from './streaming';

function createAnthropicEndpoint(options: Record<string, unknown>): Endpoint {
  const basePath = (options.basePath as string) ?? '/';
  return {
    basePath,
    registerRoutes(app: any, ctx: EndpointContext) {
      app.post('/v1/messages', async (c: any) => {
        try {
          const body = await c.req.json();
          ctx.logger.debug(`[API] [anthropic] Request:\n${JSON.stringify(body, null, 2)}`);
          const req = decodeRequest(body);

          if (body.stream) {
            const signal: AbortSignal = c.req.raw.signal;
            const stream = ctx.language.stream({ ...req, abortSignal: signal });
            const id = `msg_${Math.random().toString(36).slice(2)}`;
            const encoder = new StreamEncoder();

            return new Response(
              new ReadableStream({
                async start(controller) {
                  const enc = new TextEncoder();
                  const event = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
                  controller.enqueue(enc.encode(event('message_start', { message: { id, type: 'message', role: 'assistant', content: [], model: req.model, stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } })));
                  let closed = false;
                  try {
                    for await (const part of stream) {
                      if (signal.aborted) {
                        closed = true;
                        break;
                      }
                      if (part.type === 'response-metadata') continue;
                      const line = encoder.encode(part);
                      if (line) {
                        ctx.logger.debug(`[API] [anthropic] SSE: ${line.trim()}`);
                        controller.enqueue(enc.encode(line));
                      }
                    }
                    if (!closed) {
                      controller.close();
                      closed = true;
                    }
                  } catch (e: any) {
                    if (!closed) {
                      try { controller.close(); } catch {}
                      closed = true;
                    }
                  }
                },
              }),
              { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' } },
            );
          }

          const res = await ctx.language.generate(req);
          const encoded = encodeResponse(res);
          ctx.logger.debug(`[API] [anthropic] Response:\n${JSON.stringify(encoded, null, 2)}`);
          return c.json(encoded);
        } catch (e: any) {
          return c.text(e?.message ?? 'Internal Server Error', 500);
        }
      });

      app.get('/v1/models', (c: any) => {
        const models = ctx.models();
        return c.json({
          data: models.map((m) => ({ id: m.id, display_name: m.id, created_at: new Date(0).toISOString() })),
        });
      });
    },
  };
}

// --- plugin ---

const schema: Schema = {
  fields: [
    {
      name: 'basePath',
      type: 'string',
      label: 'Base Path',
      description: 'Base path for the API endpoint',
      default: '/',
      placeholder: '/v1',
    },
  ],
};

export function setup(ctx: { register(type: 'endpoint', id: string, factory: (options: Record<string, unknown>) => Endpoint, options?: { schema?: Schema }): void }) {
  ctx.register('endpoint', 'anthropic', createAnthropicEndpoint, { schema });
}
