/**
 * bootstrapModuleAdmin — Sprint 1 5.18f.
 *
 * the Users module spec: when the first user of a tenant joins
 * (either by accepting an invite that creates the first membership for
 * that company, or by self-registering and creating their first company),
 * they are auto-promoted to Module Admin across every installed module.
 *
 * This file owns the rule for the Users module. Sibling modules
 * (Companies, Workspaces) implement the same shape against their own
 * `module_admins` collection. Sovereign by design — no shared table.
 *
 * The check is keyed on the count of existing `module_admins` rows for
 * (moduleKey, tenantScope, tenantId). If zero, this is the first user of
 * the tenant; insert. If ≥ 1, somebody already holds Module Admin in this
 * tenant — leave the existing grants alone. The unique index
 * (moduleKey, tenantScope, tenantId, userId) makes the insert idempotent
 * if two simultaneous bootstraps race; the second insert will throw 11000
 * which we treat as "already present".
 *
 * Best-effort: failures are logged and swallowed. A missing Module Admin
 * grant is recoverable via the URM grant flow; a failed accept/create is
 * not.
 */
import type { Db } from "mongodb";
import type { Logger } from "pino";
import { collections } from "../mongo";

export type ModuleKey = "users" | "companies" | "workspaces";
export type TenantScope = "company" | "workspace" | "portal";

export interface BootstrapModuleAdminInput {
  db: Db;
  logger: Logger;
  moduleKey: ModuleKey;
  tenantScope: TenantScope;
  tenantId: string | null; // null only for portal-scope
  userId: string;
}

export interface BootstrapModuleAdminResult {
  action: "granted" | "already_present" | "skipped" | "failed";
  reason?: string;
}

export async function bootstrapModuleAdmin(
  input: BootstrapModuleAdminInput,
): Promise<BootstrapModuleAdminResult> {
  const { db, logger, moduleKey, tenantScope, tenantId, userId } = input;

  if (tenantScope !== "portal" && !tenantId) {
    return { action: "skipped", reason: "tenant_id_missing" };
  }

  const col = collections.moduleAdmins(db);

  try {
    // Look for any existing module admin in this tenant scope.
    const existing = await col.findOne({
      moduleKey,
      tenantScope,
      tenantId,
    });

    if (existing) {
      return { action: "already_present" };
    }

    await col.insertOne({
      moduleKey,
      tenantScope,
      tenantId,
      userId,
      grantedAt: new Date(),
      grantedBy: null,
      source: "bootstrap",
    });

    logger.info(
      { moduleKey, tenantScope, tenantId, userId },
      "module_admin bootstrap granted",
    );

    return { action: "granted" };
  } catch (err) {
    // Race against another bootstrap call: unique index violation means a
    // sibling request beat us. Treat as already_present, not a failure.
    if ((err as { code?: number }).code === 11000) {
      return { action: "already_present" };
    }
    logger.warn(
      { err, moduleKey, tenantScope, tenantId, userId },
      "module_admin bootstrap failed",
    );
    return {
      action: "failed",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
