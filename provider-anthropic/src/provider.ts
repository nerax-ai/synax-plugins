import type { Provider, LanguageCapability, LanguageRequest, LanguageResponse, LanguageStreamPart, Logger } from '@synax-ai/sdk';
import type { AnthropicProviderConfig, AnthropicMessagesResponse } from './types';
import { createHttpClient, streamRequest, type HttpClientConfig } from './client';
import { encodeRequest } from './request';
import { decodeResponse } from './response';
import { StreamDecoder } from './streaming';

const DEFAULT_BASE_URL = 'https://api.anthropic.com';

export class AnthropicProvider implements Provider {
  readonly id: string;
  readonly name: string;
  private readonly config: AnthropicProviderConfig;
  private readonly logger: Logger;

  constructor(id: string, config: AnthropicProviderConfig, logger: Logger) {
    this.id = id;
    this.name = id;
    this.config = config;
    this.logger = logger;
  }

  get language(): LanguageCapability {
    const self = this;
    return {
      async generate(request: LanguageRequest): Promise<LanguageResponse> {
        const baseURL = self.config.baseURL ?? DEFAULT_BASE_URL;
        const client = createHttpClient(self.id, self.logger, {
          baseURL,
          headers: {
            'x-api-key': self.config.apiKey,
            'anthropic-version': '2023-06-01',
            ...self.config.headers,
          },
          proxy: self.config.proxy,
        });

        const encoded = encodeRequest(request);
        encoded.stream = false;

        const response = await client<AnthropicMessagesResponse>('/v1/messages', encoded, request.abortSignal);
        return decodeResponse(response);
      },

      async *stream(request: LanguageRequest): AsyncGenerator<LanguageStreamPart> {
        const baseURL = self.config.baseURL ?? DEFAULT_BASE_URL;
        const config: HttpClientConfig = {
          baseURL,
          headers: {
            'x-api-key': self.config.apiKey,
            'anthropic-version': '2023-06-01',
            ...self.config.headers,
          },
          proxy: self.config.proxy,
        };

        const encoded = encodeRequest(request);
        encoded.stream = true;

        const decoder = new StreamDecoder();
        for await (const { event, data } of streamRequest(self.id, self.logger, config, '/v1/messages', encoded, request.abortSignal)) {
          yield* decoder.handle(data as any);
        }
      },

      async models() {
        return [];
      },
    };
  }
}
