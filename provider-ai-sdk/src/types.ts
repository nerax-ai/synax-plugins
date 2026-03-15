export type AiSdkPackageName = string;

export interface AiSdkProviderConfig {
  package: AiSdkPackageName;
  apiKey?: string;
  baseURL?: string;
  /** HTTP/HTTPS proxy URL, e.g. http://127.0.0.1:7890 */
  proxy?: string;
  headers?: Record<string, string>;
  models?: string[];
}

