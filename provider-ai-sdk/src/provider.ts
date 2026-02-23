import type { Provider, LanguageCapability, LanguageRequest, LanguageResponse, LanguageStreamPart, Logger } from '@synax-ai/sdk';
import type { AiSdkProviderConfig } from './types';
import { createAiSdkInstance, loadAiCore, type AiSdkInstance, type AiSdkCore } from './loader';
import { createFetch } from './http';
import { generate, stream } from './adapter';

export class AiSdkProvider implements Provider {
  readonly id: string;
  private instance?: AiSdkInstance;
  private core?: AiSdkCore;
  private initPromise?: Promise<void>;

  constructor(
    id: string,
    private readonly config: AiSdkProviderConfig,
    private readonly logger: Logger,
  ) {
    this.id = id;
  }

  get name(): string { return this.id; }

  private init(): Promise<void> {
    return (this.initPromise ??= (async () => {
      const fetchFn = createFetch(this.id, this.logger, this.config.proxy);

      [this.core, this.instance] = await Promise.all([
        loadAiCore(),
        createAiSdkInstance(this.config.package, {
          apiKey: this.config.apiKey,
          baseURL: this.config.baseURL,
          headers: this.config.headers,
          fetch: fetchFn,
        }),
      ]);
    })());
  }

  get language(): LanguageCapability {
    const self = this;
    return {
      async generate(request: LanguageRequest): Promise<LanguageResponse> {
        await self.init();
        return generate(self.core!, self.instance!(request.model), request);
      },
      async *stream(request: LanguageRequest): AsyncGenerator<LanguageStreamPart> {
        await self.init();
        yield* stream(self.core!, self.instance!(request.model), request);
      },
      async models() { return []; },
    };
  }
}
