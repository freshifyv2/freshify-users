/**
 * updateModuleSettings — operator-only partial update of the users
 * module's Phase B registry settings.
 *
 * Sprint 4 — Module Registry Settings (Phase B, BE-backed).
 *
 * Upserts the (users, portal, singleton) settings doc with an optimistic
 * version bump and writes a portal_audit_log entry. Validates that
 * `defaultRoleKey` (post-update) is a member of `availableRoleKeys`
 * (post-update); rejects with 400 otherwise.
 */
import type { Db } from "mongodb";
import type { Logger } from "pino";

import { collections } from "../mongo";
import type { IdentityContext } from "../vendor/authz";
import {
  DEFAULT_AVAILABLE_ROLE_KEYS,
  DEFAULT_ROLE_KEY,
  UpdateModuleSettingsInputSchema,
  toModuleSettingsView,
  type ModuleSettingsView,
  type UpdateModuleSettingsInput,
} from "../types/moduleSettings";
import type { UserModuleRoleKey } from "../types/userModuleRoles";

const MODULE_KEY = "users";
const PORTAL_TENANT_ID = "singleton";

export async function updateModuleSettings(
  rawInput: unknown,
  ctx: { db: Db; identity: IdentityContext; logger: Logger },
): Promise<ModuleSettingsView> {
  if (!ctx.identity.operator) {
    const err = new Error("operator_required") as Error & { status?: number };
    err.status = 403;
    throw err;
  }

  const parsed = UpdateModuleSettingsInputSchema.safeParse(rawInput ?? {});
  if (!parsed.success) {
    const err = new Error("invalid_input") as Error & {
      status?: number;
      details?: Record<string, unknown>;
    };
    err.status = 400;
    err.details = { issues: parsed.error.issues };
    throw err;
  }
  const input: UpdateModuleSettingsInput = parsed.data;

  const col = collections.moduleSettings(ctx.db);
  const existing = await col.findOne({
    moduleKey: MODULE_KEY,
    tenantScope: "portal",
    tenantId: PORTAL_TENANT_ID,
  });

  const currentAvailable: UserModuleRoleKey[] = existing
    ? existing.availableRoleKeys
    : [...DEFAULT_AVAILABLE_ROLE_KEYS];
  const currentDefault: UserModuleRoleKey = existing
    ? existing.defaultRoleKey
    : DEFAULT_ROLE_KEY;

  const nextAvailable: UserModuleRoleKey[] = input.availableRoleKeys
    ? Array.from(new Set(input.availableRoleKeys))
    : currentAvailable;
  const nextDefault: UserModuleRoleKey =
    input.defaultRoleKey ?? currentDefault;

  if (!nextAvailable.includes(nextDefault)) {
    const err = new Error("default_role_not_available") as Error & {
      status?: number;
      details?: Record<string, unknown>;
    };
    err.status = 400;
    err.details = {
      defaultRoleKey: nextDefault,
      availableRoleKeys: nextAvailable,
    };
    throw err;
  }

  const now = new Date();
  const nextVersion = (existing?.version ?? 0) + 1;
  const actor = ctx.identity.user.userId;

  await col.updateOne(
    {
      moduleKey: MODULE_KEY,
      tenantScope: "portal",
      tenantId: PORTAL_TENANT_ID,
    },
    {
      $set: {
        availableRoleKeys: nextAvailable,
        defaultRoleKey: nextDefault,
        updatedAt: now,
        updatedBy: actor,
        version: nextVersion,
      },
      $setOnInsert: {
        moduleKey: MODULE_KEY,
        tenantScope: "portal",
        tenantId: PORTAL_TENANT_ID,
      },
    },
    { upsert: true },
  );

  // Portal-wide module governance event lands in the portal audit log.
  await collections.portalAuditLog(ctx.db).insertOne({
    at: now,
    actorUserId: actor,
    event: "ModuleSettingsUpdated",
    payload: {
      moduleKey: MODULE_KEY,
      tenantScope: "portal",
      tenantId: PORTAL_TENANT_ID,
      availableRoleKeys: nextAvailable,
      defaultRoleKey: nextDefault,
      version: nextVersion,
    },
  });

  ctx.logger.info(
    {
      actor,
      moduleKey: MODULE_KEY,
      version: nextVersion,
    },
    "module_settings updated",
  );

  return toModuleSettingsView({
    moduleKey: MODULE_KEY,
    tenantScope: "portal",
    tenantId: PORTAL_TENANT_ID,
    availableRoleKeys: nextAvailable,
    defaultRoleKey: nextDefault,
    updatedAt: now,
    updatedBy: actor,
    version: nextVersion,
  });
}
