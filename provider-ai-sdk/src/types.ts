export type AiSdkPackageName = 'openai' | 'anthropic' | 'google' | 'groq' | 'mistral' | 'xai' | 'cohere' | 'deepseek';

export const AI_SDK_PACKAGES: Record<AiSdkPackageName, string> = {
  openai: '@ai-sdk/openai',
  anthropic: '@ai-sdk/anthropic',
  google: '@ai-sdk/google',
  groq: '@ai-sdk/groq',
  mistral: '@ai-sdk/mistral',
  xai: '@ai-sdk/xai',
  cohere: '@ai-sdk/cohere',
  deepseek: '@ai-sdk/deepseek',
};

export const AI_SDK_FACTORY_NAMES: Record<AiSdkPackageName, string> = {
  openai: 'createOpenAI',
  anthropic: 'createAnthropic',
  google: 'createGoogleGenerativeAI',
  groq: 'createGroq',
  mistral: 'createMistral',
  xai: 'createXai',
  cohere: 'createCohere',
  deepseek: 'createDeepSeek',
};

export interface AiSdkProviderConfig {
  package: AiSdkPackageName;
  apiKey?: string;
  baseURL?: string;
  /** HTTP/HTTPS proxy URL, e.g. http://127.0.0.1:7890 */
  proxy?: string;
  headers?: Record<string, string>;
  models?: string[];
}
