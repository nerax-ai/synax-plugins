import type { Provider, PluginStorage, Logger } from '@synax-ai/sdk';
import { OpenAIResponsesProvider } from './provider';
import type { OpenAIResponsesProviderConfig } from './types';

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
  enum?: Array<{ value: string; label: string; description?: string }>;
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
      description: 'Custom base URL for the OpenAI API (default: https://api.openai.com/v1)',
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
  ctx.register('provider', 'openai-responses', ({ instanceId, options, logger }) =>
    new OpenAIResponsesProvider(instanceId, options as unknown as OpenAIResponsesProviderConfig, logger),
    { schema }
  );
}

export { OpenAIResponsesProvider };
export type { OpenAIResponsesProviderConfig };
