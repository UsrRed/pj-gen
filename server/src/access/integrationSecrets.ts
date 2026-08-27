import type { IntegrationKey, MemoryProvider } from '@pjgen/shared';

/**
 * Env var name each optional integration's API key is expected under in the GLOBAL
 * secrets file (`<dataDir>/.env`, written via `access/envFile.ts`). Operator-supplied
 * only — pj-gen never creates an account or a key on the operator's behalf.
 */
export const INTEGRATION_SECRET_VARS: Record<IntegrationKey, string> = {
  context7: 'CONTEXT7_API_KEY',
  exa: 'EXA_API_KEY',
};

export const MEMORY_PROVIDER_SECRET_VARS: Record<Exclude<MemoryProvider, 'none'>, string> = {
  mem0: 'MEM0_API_KEY',
  supermemory: 'SUPERMEMORY_API_KEY',
};

export const ALL_INTEGRATION_SECRET_VARS: string[] = [
  ...Object.values(INTEGRATION_SECRET_VARS),
  ...Object.values(MEMORY_PROVIDER_SECRET_VARS),
];
