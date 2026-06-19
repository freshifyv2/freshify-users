/**
 * addModuleAdmin — operator-only grant of module-admin for the users
 * module at the portal scope.
 *
 * Sprint 4 — Module Registry Settings (Phase B).
 *
 * Idempotent: re-granting an existing admin is a no-op that still returns
 * the canonical view. The grant is recorded with source="manual" so it
 * can be distinguished from bootstrap-promoted admins later. Idempotency
 * matches against both the canonical `tenantId = "singleton"` and the
 * Sprint 1 legacy `tenantId = null` so we never double-grant the same
 * user.
 */
import type { Db } from "mongodb";
import type { Logger } from "pino";

import { collections } from "../mongo";
import type { IdentityContext } from "../vendor/authz";
import {
  AddModuleAdminInputSchema,
  toModuleAdminView,
  type ModuleAdminView,
} from "../types/moduleAdmin";

const MODULE_KEY = "users";
const PORTAL_TENANT_ID = "singleton";

export async function addModuleAdmin(
  rawInput: unknown,
  ctx: { db: Db; identity: IdentityContext; logger: Logger },
): Promise<{ admin: ModuleAdminView }> {
  if (!ctx.identity.operator) {
    const err = new Error("operator_required") as Error & { status?: number };
    err.status = 403;
    throw err;
  }

  const parsed = AddModuleAdminInputSchema.safeParse(rawInput ?? {});
  if (!parsed.success) {
    const err = new Error("invalid_input") as Error & {
      status?: number;
      details?: Record<string, unknown>;
    };
    err.status = 400;
    err.details = { issues: parsed.error.issues };
    throw err;
  }

  const { userId } = parsed.data;
  const actor = ctx.identity.user.userId;
  const now = new Date();
  const col = collections.moduleAdmins(ctx.db);

  const existing = await col.findOne({
    moduleKey: MODULE_KEY,
    tenantScope: "portal",
    tenantId: { $in: [PORTAL_TENANT_ID, null] },
    userId,
  });

  if (existing) {
    return { admin: toModuleAdminView(existing) };
  }

  const doc = {
    moduleKey: MODULE_KEY,
    tenantScope: "portal" as const,
    tenantId: PORTAL_TENANT_ID,
    userId,
    grantedAt: now,
    grantedBy: actor,
    source: "manual" as const,
  };
  await col.insertOne(doc);

  try {
    await collections.portalAuditLog(ctx.db).insertOne({
      at: now,
      actorUserId: actor,
      event: "ModuleAdminGranted",
      payload: {
        moduleKey: MODULE_KEY,
        tenantScope: "portal",
        tenantId: PORTAL_TENANT_ID,
        userId,
        source: "manual",
      },
    });
  } catch (err) {
    ctx.logger.warn(
      { err, moduleKey: MODULE_KEY, userId },
      "portal_audit_log insert (ModuleAdminGranted) failed",
    );
  }

  ctx.logger.info(
    { actor, userId, moduleKey: MODULE_KEY },
    "module_admin granted",
  );

  return { admin: toModuleAdminView(doc) };
}
