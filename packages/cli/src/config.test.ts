import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

function writeTmp(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'kdo-cli-'));
  const file = join(dir, 'deployments.yaml');
  writeFileSync(file, contents);
  return file;
}

describe('loadConfig', () => {
  it('parses a valid config and applies schema defaults', () => {
    const file = writeTmp(`
deployments:
  - name: web
    namespace: demo
    image: nginx:1.27
    replicas: 2
`);
    const config = loadConfig(file);
    expect(config.deployments).toHaveLength(1);
    // strategy/failureMode defaults come from the shared schema.
    expect(config.deployments[0]?.strategy).toEqual({ kind: 'RollingUpdate' });
    expect(config.deployments[0]?.failureMode).toBe('none');
  });

  it('rejects a canary missing its required params', () => {
    const file = writeTmp(`
deployments:
  - name: web
    image: nginx:1.27
    replicas: 2
    strategy:
      kind: Canary
`);
    expect(() => loadConfig(file)).toThrow();
  });

  it('rejects an empty deployment list', () => {
    expect(() => loadConfig(writeTmp('deployments: []'))).toThrow();
  });
});
