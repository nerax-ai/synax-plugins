import type { Provider, PluginStorage, Logger } from '@synax-ai/sdk';
import { AiSdkProvider } from './provider';
import type { AiSdkProviderConfig } from './types';

type FactoryCtx = { instanceId: string; options: Record<string, unknown>; logger: Logger; storage: PluginStorage };

const schema = {
  fields: [
    { name: 'package', type: 'string', description: 'AI SDK package (openai, anthropic, google, groq, mistral, xai, cohere, deepseek)', required: true },
    { name: 'apiKey', type: 'string', description: 'API Key', required: false },
    { name: 'baseURL', type: 'string', description: 'Base URL', required: false },
    { name: 'proxy', type: 'string', description: 'HTTP/HTTPS proxy URL', required: false }
  ]
};

export function setup(ctx: { register(type: 'provider', id: string, factory: (ctx: FactoryCtx) => Provider | Promise<Provider>, options?: { schema?: unknown }): void }) {
  ctx.register('provider', 'ai-sdk', ({ instanceId, options, logger }) =>
    new AiSdkProvider(instanceId, options as unknown as AiSdkProviderConfig, logger),
    { schema }
  );
}

export { AiSdkProvider };
export type { AiSdkProviderConfig };
