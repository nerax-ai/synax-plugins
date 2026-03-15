import type { AiSdkPackageName } from './types';
import { generateText, streamText, jsonSchema } from 'ai';

import type { LanguageModelV3 } from '@ai-sdk/provider';

export type AiSdkInstance = any;

export interface AiSdkCore {
  generateText: typeof generateText;
  streamText: typeof streamText;
  jsonSchema: typeof jsonSchema;
}

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
  return {
    generateText,
    streamText,
    jsonSchema,
  };
}

export async function createAiSdkInstance(
  packageName: string,
  options: { apiKey?: string; baseURL?: string; headers?: Record<string, string>; fetch?: typeof globalThis.fetch },
): Promise<AiSdkInstance> {
  // Convert package name to @ai-sdk/xxx
  const npmPackage = packageName.startsWith('@') ? packageName : `@ai-sdk/${packageName}`;
  
  // Derive factory name (e.g., openai -> createOpenAI, google -> createGoogleGenerativeAI)
  let factoryName = `create${packageName.split('-').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('')}`;
  if (packageName === 'google') factoryName = 'createGoogleGenerativeAI';
  if (packageName === 'google-vertex') factoryName = 'createVertex';

  const mod = await tryImport(npmPackage);

  const factory = mod[factoryName] as ((opts: unknown) => AiSdkInstance) | undefined;
  if (!factory) {
    // Try to find any function starting with 'create' if the guessed name fails
    const fallbackFactoryName = Object.keys(mod).find(k => k.startsWith('create') && typeof mod[k] === 'function');
    if (fallbackFactoryName) {
      return (mod[fallbackFactoryName] as any)(options);
    }
    throw new Error(`Factory '${factoryName}' not found in '${npmPackage}'. Available exports: ${Object.keys(mod).join(', ')}`);
  }

  return factory(options);
}
