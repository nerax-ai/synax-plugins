import type { Endpoint, EndpointContext } from '@synax-ai/sdk';
import { decodeRequest } from './request';
import { encodeResponse } from './response';
import { StreamEncoder } from './streaming';

// Inline Schema definition since @synax-ai/sdk doesn't export Schema in installed version
interface SchemaField {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  label?: string;
  description?: string;
  placeholder?: string;
  required?: boolean;
  secret?: boolean;
  defaultValue?: unknown;
  enum?: Array<{ value: string; label: string; description?: string }>;
}

interface Schema {
  fields: SchemaField[];
}

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
            const encoder = new StreamEncoder();

            return new Response(
              new ReadableStream({
                async start(controller) {
                  const enc = new TextEncoder();
                  let closed = false;
                  let messageStarted = false;

                  try {
                    for await (const part of stream) {
                      if (signal.aborted) {
                        closed = true;
                        break;
                      }

                      // Skip stream-start events
                      if (part.type === 'stream-start') continue;

                      // Skip content-part events (inline content not used in Anthropic streaming)
                      if ((part as any).type === 'content-part') continue;

                      // Use response-metadata to emit message_start
                      if (part.type === 'response-metadata') {
                        const line = encoder.encode(part);
                        if (line) {
                          messageStarted = true;
                          ctx.logger.debug(`[API] [anthropic] SSE: ${line.trim()}`);
                          controller.enqueue(enc.encode(line));
                        }
                        continue;
                      }

                      // If we haven't started yet, generate a synthetic message_start
                      if (!messageStarted) {
                        const syntheticStart = encoder.start(
                          `msg_${crypto.randomUUID().replace(/-/g, '')}`,
                          req.model
                        );
                        ctx.logger.debug(`[API] [anthropic] SSE: ${syntheticStart.trim()}`);
                        controller.enqueue(enc.encode(syntheticStart));
                        messageStarted = true;
                      }

                      const line = encoder.encode(part);
                      if (line) {
                        ctx.logger.debug(`[API] [anthropic] SSE: ${line.trim()}`);
                        controller.enqueue(enc.encode(line));
                      }
                    }

                    if (!closed) {
                      // Emit message_stop
                      if (messageStarted) {
                        const endEvent = encoder.end();
                        controller.enqueue(enc.encode(endEvent));
                      }
                      controller.close();
                      closed = true;
                    }
                  } catch (e: any) {
                    if (!closed) {
                      // Emit an error event to the client before closing
                      if (messageStarted) {
                        try {
                          const errorEvent = `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: e?.message ?? 'Stream error' } })}\n\n`;
                          controller.enqueue(enc.encode(errorEvent));
                        } catch {}
                      }
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
          // Return errors in Anthropic error JSON format
          return c.json({
            type: 'error',
            error: {
              type: 'api_error',
              message: e?.message ?? 'Internal Server Error',
            },
          }, 500);
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
      defaultValue: '/',
      placeholder: '/v1',
    },
  ],
};

export function setup(ctx: { register(type: 'endpoint', id: string, factory: (options: Record<string, unknown>) => Endpoint, options?: { schema?: Schema }): void }) {
  ctx.register('endpoint', 'anthropic', createAnthropicEndpoint, { schema });
}
