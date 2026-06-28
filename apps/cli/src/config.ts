import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { DeploymentSpecSchema, ROLES } from '@kdo/core';

/**
 * A `kdo` config file declares one or more deployments. It reuses the *same*
 * Zod schema as the API and UI, so a spec that's valid here is valid
 * everywhere — one source of truth for what a deployment is.
 */
export const ConfigSchema = z.object({
  apiBaseUrl: z.string().url().optional(),
  /** Auth (optional in the file; usually supplied via flags/env). */
  apiKey: z.string().optional(),
  role: z.enum(ROLES).optional(),
  deployments: z.array(DeploymentSpecSchema).min(1, 'config must declare at least one deployment'),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(path: string): Config {
  const raw = readFileSync(path, 'utf8');
  const data: unknown = parseYaml(raw);
  return ConfigSchema.parse(data);
}
