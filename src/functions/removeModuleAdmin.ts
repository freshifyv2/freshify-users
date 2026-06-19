/**
 * removeModuleAdmin — operator-only revocation of module-admin for the
 * users module at the portal scope.
 *
 * Sprint 4 — Module Registry Settings (Phase B).
 *
 * Idempotent: removing a non-existent grant returns `{ removed: false }`
 * rather than 404 so the FE can issue the call from a stale list without
 * surfacing a spurious error. Matches against both the canonical
 * `tenantId = "singleton"` and the Sprint 1 legacy `tenantId = null`
 * shape.
 */
import type { Db } from "mongodb";
import type { Logger } from "pino";

import { collections } from "../mongo";
import type { IdentityContext } from "../vendor/authz";

const MODULE_KEY = "users";
const PORTAL_TENANT_ID = "singleton";

export async function removeModuleAdmin(
  input: { userId: string },
  ctx: { db: Db; identity: IdentityContext; logger: Logger },
): Promise<{ removed: boolean }> {
  if (!ctx.identity.operator) {
    const err = new Error("operator_required") as Error & { status?: number };
    err.status = 403;
    throw err;
  }

  const userId = (input?.userId ?? "").trim();
  if (!userId) {
    const err = new Error("invalid_input") as Error & { status?: number };
    err.status = 400;
    throw err;
  }

  const actor = ctx.identity.user.userId;
  const now = new Date();
  const col = collections.moduleAdmins(ctx.db);

  const result = await col.deleteOne({
    moduleKey: MODULE_KEY,
    tenantScope: "portal",
    tenantId: { $in: [PORTAL_TENANT_ID, null] },
    userId,
  });

  if (result.deletedCount === 0) {
    return { removed: false };
  }

  try {
    await collections.portalAuditLog(ctx.db).insertOne({
      at: now,
      actorUserId: actor,
      event: "ModuleAdminRevoked",
      payload: {
        moduleKey: MODULE_KEY,
        tenantScope: "portal",
        tenantId: PORTAL_TENANT_ID,
        userId,
      },
    });
  } catch (err) {
    ctx.logger.warn(
      { err, moduleKey: MODULE_KEY, userId },
      "portal_audit_log insert (ModuleAdminRevoked) failed",
    );
  }

  ctx.logger.info(
    { actor, userId, moduleKey: MODULE_KEY },
    "module_admin revoked",
  );

  return { removed: true };
}
