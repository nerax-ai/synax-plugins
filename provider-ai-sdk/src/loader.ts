import type { AiSdkPackageName } from './types';
import { AI_SDK_PACKAGES, AI_SDK_FACTORY_NAMES } from './types';

export type AiSdkInstance = (modelId: string) => unknown;

export interface AiSdkCore {
  generateText: Function;
  streamText: Function;
  jsonSchema: Function;
}

let coreCache: AiSdkCore | undefined;

const pluginDir = import.meta.dir.replace(/[\\/]src$/, '');

async function bunInstall(pkg: string): Promise<void> {
  const result = await Bun.$`bun add ${pkg} --cwd ${pluginDir}`.quiet();
  if (result.exitCode !== 0) throw new Error(`Failed to install '${pkg}': ${result.stderr.toString()}`);
}

const dynamicImport = new Function('pkg', 'return import(pkg)') as (pkg: string) => Promise<Record<string, unknown>>;

function isInstalledLocally(pkg: string): boolean {
  return require('fs').existsSync(`${pluginDir}/node_modules/${pkg}`);
}

async function tryImport(pkg: string): Promise<Record<string, unknown>> {
  if (!isInstalledLocally(pkg)) {
    await bunInstall(pkg);
  }
  const localPath = `${pluginDir}/node_modules/${pkg}`;
  return await dynamicImport(localPath);
}

export async function loadAiCore(): Promise<AiSdkCore> {
  if (coreCache) return coreCache;
  const mod = await tryImport('ai');
  coreCache = {
    generateText: mod.generateText as Function,
    streamText: mod.streamText as Function,
    jsonSchema: mod.jsonSchema as Function,
  };
  return coreCache;
}

export async function createAiSdkInstance(
  packageName: AiSdkPackageName,
  options: { apiKey?: string; baseURL?: string; headers?: Record<string, string>; fetch?: typeof globalThis.fetch },
): Promise<AiSdkInstance> {
  const npmPackage = AI_SDK_PACKAGES[packageName];
  const factoryName = AI_SDK_FACTORY_NAMES[packageName];

  const mod = await tryImport(npmPackage);

  const factory = mod[factoryName] as ((opts: unknown) => AiSdkInstance) | undefined;
  if (!factory) throw new Error(`Factory '${factoryName}' not found in '${npmPackage}'`);

  return factory(options);
}
