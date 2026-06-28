/**
 * Authn/authz domain — roles and the permissions they grant.
 *
 * This is intentionally a *simple, demo-only* model (one shared API key, a
 * fixed role catalogue, in-memory sessions on the API side). It is enough to
 * demonstrate platform-style RBAC — "who may trigger a deploy vs. who only
 * observes" — without standing up a real identity provider, which the
 * assignment explicitly does not require.
 */

export const ROLES = ['engineering-manager', 'devops-engineer', 'platform-team'] as const;
export type Role = (typeof ROLES)[number];

export type Permission = 'deployments:read' | 'deployments:create';

export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  'engineering-manager': ['deployments:read'],
  'devops-engineer': ['deployments:read', 'deployments:create'],
  'platform-team': ['deployments:read', 'deployments:create'],
};

export interface RoleInfo {
  readonly label: string;
  readonly description: string;
}

export const ROLE_INFO: Readonly<Record<Role, RoleInfo>> = {
  'engineering-manager': {
    label: 'Engineering Manager',
    description: 'Read-only — observe deployments and status across teams.',
  },
  'devops-engineer': {
    label: 'DevOps Engineer',
    description: 'Trigger deployments and watch rollouts.',
  },
  'platform-team': {
    label: 'Platform Team',
    description: 'Full access — owns the platform and its deployment workflows.',
  },
};

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
