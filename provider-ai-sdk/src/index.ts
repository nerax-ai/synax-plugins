import type { Provider, PluginStorage, Logger, Schema } from '@synax-ai/sdk';
import { AiSdkProvider } from './provider';
import type { AiSdkProviderConfig } from './types';

type FactoryCtx = { instanceId: string; options: Record<string, unknown>; logger: Logger; storage: PluginStorage };

const schema: Schema = {
  fields: [
    {
      name: 'package',
      type: 'string',
      label: 'AI SDK Package',
      description: 'Select the AI SDK package to use',
      required: true,
      enum: [
        { value: 'openai', label: 'OpenAI', description: 'Official OpenAI SDK' },
        { value: 'anthropic', label: 'Anthropic', description: 'Official Anthropic SDK' },
        { value: 'google', label: 'Google', description: 'Google Generative AI SDK' },
        { value: 'open-responses', label: 'Open Responses', description: 'OpenAI Responses API' },
        { value: 'openai-compatible', label: 'OpenAI Compatible', description: 'Generic OpenAI-compatible API' },
      ],
    },
    {
      name: 'apiKey',
      type: 'string',
      label: 'API Key',
      description: 'API key for authentication',
      placeholder: 'sk-...',
      secret: true,
    },
    {
      name: 'baseURL',
      type: 'string',
      label: 'Base URL',
      description: 'Custom base URL for the API endpoint',
      placeholder: 'https://api.example.com/v1',
    },
    {
      name: 'proxy',
      type: 'string',
      label: 'Proxy URL',
      description: 'HTTP/HTTPS proxy URL',
      placeholder: 'http://proxy.example.com:8080',
    },
  ],
};

export function setup(ctx: { register(type: 'provider', id: string, factory: (ctx: FactoryCtx) => Provider | Promise<Provider>, options?: { schema?: unknown }): void }) {
  ctx.register('provider', 'ai-sdk', ({ instanceId, options, logger }) =>
    new AiSdkProvider(instanceId, options as unknown as AiSdkProviderConfig, logger),
    { schema }
  );
}

export { AiSdkProvider };
export type { AiSdkProviderConfig };
