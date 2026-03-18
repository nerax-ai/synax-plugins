import type { Endpoint, EndpointContext } from '@synax-ai/sdk';
import { createChatCompletionsEndpoint } from './chat';
import { createResponsesEndpoint } from './responses';

function createOpenAIEndpoint(options: Record<string, unknown>): Endpoint {
  const basePath = (options.basePath as string) ?? '/';
  const chatEndpoint = createChatCompletionsEndpoint(options);
  const responsesEndpoint = createResponsesEndpoint(options);

  return {
    basePath,
    registerRoutes(app: any, ctx: EndpointContext) {
      // /v1/chat/completions
      chatEndpoint.registerRoutes(app, ctx);
      // /v1/responses
      responsesEndpoint.registerRoutes(app, ctx);

      // /v1/models
      app.get('/v1/models', (c: any) => {
        const models = ctx.models();
        return c.json({
          object: 'list',
          data: models.map((m: any) => ({
            id: m.id,
            object: 'model',
            created: Math.floor(Date.now() / 1000),
            owned_by: m.ownedBy ?? 'synax'
          })),
        });
      });
    },
  };
}

const schema = {
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

export function setup(ctx: {
  register(type: 'endpoint', id: string, factory: (options: Record<string, unknown>) => Endpoint, options?: { schema?: unknown }): void
}) {
  ctx.register('endpoint', 'openai', createOpenAIEndpoint, { schema });
}
