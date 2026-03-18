import type { Provider, LanguageCapability, LanguageRequest, LanguageResponse, LanguageStreamPart, Logger } from '@synax-ai/sdk';
import type { OpenAIProviderConfig } from './types';
import { createHttpClient, streamRequest } from './client';
import { encodeRequest } from './request';
import { decodeResponse } from './response';
import { StreamDecoder } from './streaming';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

export class OpenAIChatProvider implements Provider {
  readonly id: string;
  readonly name: string;
  private readonly config: OpenAIProviderConfig;
  private readonly logger: Logger;

  constructor(id: string, config: OpenAIProviderConfig, logger: Logger) {
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
            'Authorization': `Bearer ${self.config.apiKey}`,
            ...self.config.headers,
          },
          proxy: self.config.proxy,
        });

        const encoded = encodeRequest(request);
        encoded.stream = false;

        const response = await client<any>('/chat/completions', encoded, request.abortSignal);
        return decodeResponse(response);
      },

      async *stream(request: LanguageRequest): AsyncGenerator<LanguageStreamPart> {
        const baseURL = self.config.baseURL ?? DEFAULT_BASE_URL;
        const clientConfig = {
          baseURL,
          headers: {
            'Authorization': `Bearer ${self.config.apiKey}`,
            ...self.config.headers,
          },
          proxy: self.config.proxy,
        };

        const encoded = encodeRequest(request);
        encoded.stream = true;

        const decoder = new StreamDecoder();
        for await (const data of streamRequest(self.id, self.logger, clientConfig, '/chat/completions', encoded, request.abortSignal)) {
          yield* decoder.decode(data);
        }
      },

      async models() {
        return [];
      },
    };
  }
}
