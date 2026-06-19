/**
 * ModuleSettings — Phase B per-tenant configuration for the users module.
 *
 * Sprint 4 — Module Registry Settings (Phase B, BE-backed).
 *
 * The Module Registry Settings spec defines four canonical sections that
 * every module gets a dashboard for:
 *
 *   1. Module Admins        ← stored in the `module_admins` collection
 *   2. Available Roles      ← stored here as `availableRoleKeys`
 *   3. Default Role         ← stored here as `defaultRoleKey`
 *   4. Module Registry      ← reads of canonical module metadata are
 *                              derived at request time from getModuleInfo;
 *                              this doc only stores display preferences for
 *                              the registry view (none in v1).
 *
 * Each (moduleKey, tenantScope, tenantId) tuple gets exactly one settings
 * doc. For the public build the users module ships with tenantScope
 * "portal" (singleton at the portal level); per-company and per-workspace
 * overrides are reserved for future iterations and intentionally not
 * exposed in the v1 endpoints.
 */
import { z } from "zod";

import {
  UserModuleRoleKeys,
  type UserModuleRoleKey,
} from "./userModuleRoles";

export const TENANT_SCOPES = ["portal", "company", "workspace"] as const;
export type TenantScope = (typeof TENANT_SCOPES)[number];

export const TenantScopeSchema = z.enum(TENANT_SCOPES);

/**
 * Defaults applied when a settings doc does not yet exist for a tenant.
 * The available-roles set mirrors the module.v1 role catalog (the
 * framework-default Module catalog from roleCatalogs.ts); the default
 * role mirrors the catalog's `invite_default` slot ("member").
 */
export const DEFAULT_AVAILABLE_ROLE_KEYS: readonly UserModuleRoleKey[] =
  UserModuleRoleKeys;
export const DEFAULT_ROLE_KEY: UserModuleRoleKey = "member";

export interface ModuleSettingsDoc {
  moduleKey: string; // always "users" in this repo
  tenantScope: TenantScope;
  tenantId: string; // "singleton" when tenantScope === "portal"
  availableRoleKeys: UserModuleRoleKey[];
  defaultRoleKey: UserModuleRoleKey;
  updatedAt: Date;
  updatedBy: string | null;
  version: number;
}

export interface ModuleSettingsView {
  moduleKey: string;
  tenantScope: TenantScope;
  tenantId: string;
  availableRoleKeys: UserModuleRoleKey[];
  defaultRoleKey: UserModuleRoleKey;
  updatedAt: string;
  updatedBy: string | null;
  version: number;
}

export function toModuleSettingsView(
  doc: ModuleSettingsDoc,
): ModuleSettingsView {
  return {
    moduleKey: doc.moduleKey,
    tenantScope: doc.tenantScope,
    tenantId: doc.tenantId,
    availableRoleKeys: doc.availableRoleKeys,
    defaultRoleKey: doc.defaultRoleKey,
    updatedAt: doc.updatedAt.toISOString(),
    updatedBy: doc.updatedBy,
    version: doc.version,
  };
}

export const UpdateModuleSettingsInputSchema = z
  .object({
    availableRoleKeys: z.array(z.enum(UserModuleRoleKeys)).min(1).optional(),
    defaultRoleKey: z.enum(UserModuleRoleKeys).optional(),
  })
  .strict();

export type UpdateModuleSettingsInput = z.infer<
  typeof UpdateModuleSettingsInputSchema
>;
