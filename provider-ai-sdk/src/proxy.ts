import { ProxyAgent, fetch as undiciFetch } from 'undici';

export function createProxyFetch(proxyUrl: string): (url: string | URL | Request, init?: RequestInit) => Promise<Response> {
  const dispatcher = new ProxyAgent(proxyUrl);
  return (url, init) =>
    undiciFetch(url as string, { ...(init as object), dispatcher }) as unknown as Promise<Response>;
}
