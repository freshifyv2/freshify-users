/**
 * getModuleSettings — operator-only read of the users module's Phase B
 * registry settings (Available Roles, Default Role).
 *
 * Sprint 4 — Module Registry Settings (Phase B, BE-backed).
 *
 * If no settings doc exists yet for the (users, portal, singleton)
 * tenant, this returns a synthesized default view rather than 404 — the FE
 * settings page always renders something. Defaults come from the module
 * types module so the catalog stays single-sourced.
 */
import type { Db } from "mongodb";
import type { Logger } from "pino";

import { collections } from "../mongo";
import type { IdentityContext } from "../vendor/authz";
import {
  DEFAULT_AVAILABLE_ROLE_KEYS,
  DEFAULT_ROLE_KEY,
  toModuleSettingsView,
  type ModuleSettingsView,
} from "../types/moduleSettings";

export const MODULE_KEY = "users";
const PORTAL_TENANT_ID = "singleton";

export async function getModuleSettings(
  _input: Record<string, never>,
  ctx: { db: Db; identity: IdentityContext; logger: Logger },
): Promise<ModuleSettingsView> {
  if (!ctx.identity.operator) {
    const err = new Error("operator_required") as Error & { status?: number };
    err.status = 403;
    throw err;
  }

  const col = collections.moduleSettings(ctx.db);
  const doc = await col.findOne({
    moduleKey: MODULE_KEY,
    tenantScope: "portal",
    tenantId: PORTAL_TENANT_ID,
  });

  if (doc) return toModuleSettingsView(doc);

  const now = new Date();
  return {
    moduleKey: MODULE_KEY,
    tenantScope: "portal",
    tenantId: PORTAL_TENANT_ID,
    availableRoleKeys: [...DEFAULT_AVAILABLE_ROLE_KEYS],
    defaultRoleKey: DEFAULT_ROLE_KEY,
    updatedAt: now.toISOString(),
    updatedBy: null,
    version: 0,
  };
}
