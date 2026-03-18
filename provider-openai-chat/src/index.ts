import type { Provider, PluginStorage, Logger } from '@synax-ai/sdk';
import { OpenAIChatProvider } from './provider';
import type { OpenAIProviderConfig } from './types';

type FactoryCtx = { instanceId: string; options: Record<string, unknown>; logger: Logger; storage: PluginStorage };

// Inline schema definition since @synax-ai/sdk doesn't export Schema yet
interface SchemaField {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  label?: string;
  description?: string;
  placeholder?: string;
  required?: boolean;
  secret?: boolean;
  defaultValue?: unknown;
}

interface Schema {
  fields: SchemaField[];
}

const schema: Schema = {
  fields: [
    {
      name: 'apiKey',
      type: 'string',
      label: 'API Key',
      description: 'OpenAI API key for authentication',
      placeholder: 'sk-...',
      secret: true,
      required: true,
    },
    {
      name: 'baseURL',
      type: 'string',
      label: 'Base URL',
      description: 'Custom base URL for the OpenAI API',
      placeholder: 'https://api.openai.com/v1',
    },
    {
      name: 'proxy',
      type: 'string',
      label: 'Proxy URL',
      description: 'HTTP/HTTPS proxy URL',
      placeholder: 'http://proxy.example.com:8080',
    },
    {
      name: 'headers',
      type: 'object',
      label: 'Custom Headers',
      description: 'Additional headers to include in API requests',
    },
  ],
};

export function setup(ctx: { register(type: 'provider', id: string, factory: (ctx: FactoryCtx) => Provider | Promise<Provider>, options?: { schema?: unknown }): void }) {
  ctx.register('provider', 'openai-chat', ({ instanceId, options, logger }) =>
    new OpenAIChatProvider(instanceId, options as unknown as OpenAIProviderConfig, logger),
    { schema }
  );
}

export { OpenAIChatProvider };
export type { OpenAIProviderConfig };
