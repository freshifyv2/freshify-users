/**
 * listModuleAdmins — operator-only list of module-admin grants for the
 * users module at the portal scope.
 *
 * Sprint 4 — Module Registry Settings (Phase B).
 *
 * Returns rows whose tenantId is either the canonical "singleton" or the
 * Sprint 1 legacy `null` shape so a pre-Phase-B bootstrap row is still
 * visible while we backfill.
 */
import type { Db } from "mongodb";
import type { Logger } from "pino";

import { collections } from "../mongo";
import type { IdentityContext } from "../vendor/authz";
import {
  toModuleAdminView,
  type ModuleAdminView,
} from "../types/moduleAdmin";

const MODULE_KEY = "users";
const PORTAL_TENANT_ID = "singleton";

export async function listModuleAdmins(
  _input: Record<string, never>,
  ctx: { db: Db; identity: IdentityContext; logger: Logger },
): Promise<{ admins: ModuleAdminView[] }> {
  if (!ctx.identity.operator) {
    const err = new Error("operator_required") as Error & { status?: number };
    err.status = 403;
    throw err;
  }

  const docs = await collections
    .moduleAdmins(ctx.db)
    .find({
      moduleKey: MODULE_KEY,
      tenantScope: "portal",
      tenantId: { $in: [PORTAL_TENANT_ID, null] },
    })
    .sort({ grantedAt: 1 })
    .toArray();

  return { admins: docs.map(toModuleAdminView) };
}
