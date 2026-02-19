import type { Provider, PluginStorage, Logger } from '@synax-ai/sdk';
import { AiSdkProvider } from './provider';
import type { AiSdkProviderConfig } from './types';

type FactoryCtx = { instanceId: string; options: Record<string, unknown>; logger: Logger; storage: PluginStorage };

export default {
  manifest: { id: 'provider-ai-sdk', name: 'AI SDK Provider', version: '0.0.1' },
  setup(ctx: { register(type: 'provider', id: string, factory: (ctx: FactoryCtx) => Provider | Promise<Provider>): void }) {
    ctx.register('provider', 'provider-ai-sdk', ({ instanceId, options }) =>
      new AiSdkProvider(instanceId, options as unknown as AiSdkProviderConfig),
    );
  },
};

export { AiSdkProvider };
export type { AiSdkProviderConfig };
