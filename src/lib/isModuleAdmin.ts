/**
 * isModuleAdmin — request-scoped Module Admin lookup.
 *
 * Sprint 5 — operator bypass drop.
 *
 * Before Sprint 5: list endpoints short-circuited on `ctx.identity.operator`
 * and returned cross-tenant data. That implicit operator-everywhere read is
 * gone. Operators who need cross-tenant visibility now hold an explicit
 * Module Admin grant in the `module_admins` collection (Sprint 4 Phase B
 * data model), and that grant is checked through this helper.
 *
 * Cached at request scope via a Map attached to the IdentityContext, so a
 * single list call hits Mongo at most once per (userId, moduleKey) pair
 * regardless of how many rows the list iterates. The compound index
 * `{ moduleKey, tenantScope, tenantId, userId }` (unique) created in
 * Sprint 4 makes the lookup a single keyed equality query.
 *
 * Per Sprint 4 locked decision #3 (and Sprint 5 #4), this helper is
 * duplicated literally across freshify-companies, freshify-users, and
 * freshify-workspaces. The public-build OSS reference favors visible
 * duplication over premature shared-package abstraction.
 */
import type { Db } from "mongodb";
import { collections } from "../mongo";
import type { IdentityContext } from "../vendor/authz";

const MODULE_KEY = "users";
const PORTAL_TENANT_ID = "singleton";

/** Mutable per-request cache attached to the IdentityContext at runtime. */
type CacheKey = `${string}:${string}`;
type CachedIdentity = IdentityContext & {
  __moduleAdminCache?: Map<CacheKey, boolean>;
};

export async function isModuleAdmin(
  db: Db,
  identity: IdentityContext,
  moduleKey: string = MODULE_KEY,
): Promise<boolean> {
  const userId = identity.user?.userId;
  if (!userId) return false;

  const cached = identity as CachedIdentity;
  if (!cached.__moduleAdminCache) {
    cached.__moduleAdminCache = new Map();
  }
  const key: CacheKey = `${userId}:${moduleKey}`;
  const hit = cached.__moduleAdminCache.get(key);
  if (hit !== undefined) return hit;

  // Read both the canonical `tenantId = "singleton"` and the Sprint 1
  // legacy `tenantId = null` rows. Same tolerant-read pattern as
  // listModuleAdmins / addModuleAdmin.
  const grant = await collections.moduleAdmins(db).findOne({
    moduleKey,
    tenantScope: "portal",
    tenantId: { $in: [PORTAL_TENANT_ID, null] },
    userId,
  });

  const result = grant !== null;
  cached.__moduleAdminCache.set(key, result);
  return result;
}
