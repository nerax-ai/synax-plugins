import type { Provider, PluginStorage, Logger } from '@synax-ai/sdk';
import { AiSdkProvider } from './provider';
import type { AiSdkProviderConfig } from './types';

type FactoryCtx = { instanceId: string; options: Record<string, unknown>; logger: Logger; storage: PluginStorage };

export function setup(ctx: { register(type: 'provider', id: string, factory: (ctx: FactoryCtx) => Provider | Promise<Provider>): void }) {
  ctx.register('provider', 'ai-sdk', ({ instanceId, options, logger }) =>
    new AiSdkProvider(instanceId, options as unknown as AiSdkProviderConfig, logger),
  );
}

export { AiSdkProvider };
export type { AiSdkProviderConfig };
