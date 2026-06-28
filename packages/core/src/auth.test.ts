import { describe, expect, it } from 'vitest';
import { ROLES, isRole, roleHasPermission } from './auth';

describe('auth roles', () => {
  it('grants read to every role', () => {
    for (const role of ROLES) {
      expect(roleHasPermission(role, 'deployments:read')).toBe(true);
    }
  });

  it('only lets devops-engineer and platform-team create deployments', () => {
    expect(roleHasPermission('engineering-manager', 'deployments:create')).toBe(false);
    expect(roleHasPermission('devops-engineer', 'deployments:create')).toBe(true);
    expect(roleHasPermission('platform-team', 'deployments:create')).toBe(true);
  });

  it('isRole narrows known roles and rejects others', () => {
    expect(isRole('platform-team')).toBe(true);
    expect(isRole('intern')).toBe(false);
    expect(isRole(42)).toBe(false);
  });
});
