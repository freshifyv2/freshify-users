/**
 * getModuleInfo — canonical Module Registry endpoint for the users module.
 *
 * Sprint 4 — Module Registry Settings (Phase B).
 *
 * Serves the 9 canonical Module Registry fields (per the Module Registry &
 * Settings retrofit spec) so the FE can render the Registry section of the
 * Module Settings page without hardcoding any of these values. Also returns
 * the closed list of available role keys + their human-readable labels so
 * the FE's Available Roles / Default Role controls do not need to ship a
 * private copy of the catalog.
 *
 * Note: the role keys returned here are the MODULE-level role catalog
 * (`owner | manager | member | viewer`), not the user-company membership
 * role pair (`admin | member`). Module Registry Settings defines available
 * roles as module-scoped role definitions; membership roles are a separate
 * concern owned by the Companies/Workspaces composition.
 *
 * Authenticated callers only (no operator gate — the Registry is
 * informational metadata about the module surface).
 */
import type { Db } from "mongodb";
import type { Logger } from "pino";

import type { IdentityContext } from "../vendor/authz";
import {
  UserModuleRoleKeys,
  type UserModuleRoleKey,
} from "../types/userModuleRoles";

const MODULE_KEY = "users";

/**
 * Role labels for the FE. Kept beside the key-set so a new value can't
 * arrive without a label. Matches the users.module.v1 role catalog.
 */
const ROLE_LABELS: Record<UserModuleRoleKey, string> = {
  owner: "Owner",
  manager: "Manager",
  member: "Member",
  viewer: "Viewer",
};

export interface ModuleInfo {
  /** Module ID (slug). Canonical identifier across the platform. */
  moduleId: string;
  /** Backend service name in the deploy registry. */
  backendService: string;
  /** Frontend service name in the deploy registry. */
  frontendService: string;
  /** MongoDB collections owned by this module. */
  collections: string[];
  /** Public route prefix served by the frontend service. */
  routePrefix: string;
  /** Whether this module owns the platform's auth surface. */
  authOwnership: { owns: boolean; note: string };
  /** Who owns this module's settings (self vs. another module). */
  settingsOwnership: { owner: string; note: string };
  /** URL to the module-level settings page. */
  settingsUrl: string;
  /** Standard Module Interface (SMI) version this module conforms to. */
  smiVersion: string;
  /** Closed list of role keys defined by this module's role catalog. */
  availableRoleKeys: UserModuleRoleKey[];
  /** Human-readable labels keyed by role key. */
  roleLabels: Record<UserModuleRoleKey, string>;
}

export async function getModuleInfo(
  _input: Record<string, never>,
  _ctx: { db: Db; identity: IdentityContext; logger: Logger },
): Promise<ModuleInfo> {
  return {
    moduleId: MODULE_KEY,
    backendService: "freshify-users",
    frontendService: "freshify-users-fe",
    collections: [
      "users",
      "user_company_memberships",
      "auth_sessions",
      "pending_invites",
      "pending_otps",
      "role_catalogs",
      "portal_settings",
      "invites",
      "pending_email_verifications",
      "pending_password_resets",
      "user_type_extensions",
      "module_admins",
      "module_settings",
      "portal_audit_log",
    ],
    routePrefix: "/dashboard/users",
    authOwnership: {
      owns: true,
      note: "Users module owns the platform auth surface (Twilio OTP reference).",
    },
    settingsOwnership: {
      owner: "self",
      note: "Users owns its own module-level settings.",
    },
    settingsUrl: "/dashboard/users/settings",
    smiVersion: "v1",
    availableRoleKeys: [...UserModuleRoleKeys],
    roleLabels: ROLE_LABELS,
  };
}
