/**
 * Tenant scope for non-React modules.
 *
 * `storage.ts` and `audioStore.ts` build their keys at module load, long
 * before any component mounts, so they cannot read the config through React
 * context. Bootstrap sets the id here once the config resolves; both modules
 * read it lazily when they touch storage.
 */

let tenantId = "default";

export function setTenantScope(id: string) {
  if (id) tenantId = id;
}

export function getTenantScope(): string {
  return tenantId;
}

/** `<tenant>.<key>` — keeps two tenants sharing an origin from colliding. */
export function scoped(key: string): string {
  return `${tenantId}.${key}`;
}
