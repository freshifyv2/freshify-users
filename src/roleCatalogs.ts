/**
 * Default Role Catalogs — SMI v0.2 §6
 *
 * Single source of truth for the framework-shipped role catalogs. Customers
 * can fork these per install (write a new version with their own roles), but
 * the *shape* is locked at v0.2:
 *
 *   - Capability set is a closed enum (see RoleCapability in mongo.ts).
 *   - Every catalog must contain exactly one role with
 *     isAutoAssigned: "owner_on_create" (the Owner tier).
 *   - rank determines ordering; convention is 100 = Owner, descending from
 *     there. Higher rank = more privileged.
 *
 * Locked decisions:
 *
 *   Company catalog: Owner(100)/Admin(80)/Manager(60)/Member(30)/Viewer(10)
 *   Workspace catalog: Owner(100)/Manager(70)/Member(30)/Viewer(10) — no Admin tier
 *   Module catalog (default, overridable per ModuleDescriptor.roles.defaults):
 *     Owner(100)/Manager(70)/Member(30)/Viewer(10)
 *
 * These are the "version 1" catalogs. Future tweaks ship as version 2.
 */
import type { RoleCatalogDoc, RoleCapability, RoleEntry } from "./mongo";

const ALL_CAPS: RoleCapability[] = [
  "read",
  "write",
  "manage_users",
  "manage_settings",
  "manage_roles",
  "transfer_ownership",
  "delete",
];

// ─── Company catalog v1 ───────────────────────────────────────────────────

const COMPANY_ROLES_V1: RoleEntry[] = [
  {
    key: "owner",
    name: "Owner",
    rank: 100,
    capabilities: ALL_CAPS,
    isAutoAssigned: "owner_on_create",
  },
  {
    key: "admin",
    name: "Admin",
    rank: 80,
    capabilities: [
      "read",
      "write",
      "manage_users",
      "manage_settings",
      "manage_roles",
      "delete",
    ],
    isAutoAssigned: null,
  },
  {
    key: "manager",
    name: "Manager",
    rank: 60,
    capabilities: ["read", "write", "manage_users", "manage_settings"],
    isAutoAssigned: null,
  },
  {
    key: "member",
    name: "Member",
    rank: 30,
    capabilities: ["read", "write"],
    isAutoAssigned: "invite_default",
  },
  {
    key: "viewer",
    name: "Viewer",
    rank: 10,
    capabilities: ["read"],
    isAutoAssigned: null,
  },
];

// ─── Workspace catalog v1 (no Admin tier per SMI v0.2 §6.2) ───────────────

const WORKSPACE_ROLES_V1: RoleEntry[] = [
  {
    key: "owner",
    name: "Owner",
    rank: 100,
    capabilities: ALL_CAPS,
    isAutoAssigned: "owner_on_create",
  },
  {
    key: "manager",
    name: "Manager",
    rank: 70,
    capabilities: [
      "read",
      "write",
      "manage_users",
      "manage_settings",
      "manage_roles",
    ],
    isAutoAssigned: null,
  },
  {
    key: "member",
    name: "Member",
    rank: 30,
    capabilities: ["read", "write"],
    isAutoAssigned: "invite_default",
  },
  {
    key: "viewer",
    name: "Viewer",
    rank: 10,
    capabilities: ["read"],
    isAutoAssigned: null,
  },
];

// ─── Module catalog v1 default (per-module overridable) ───────────────────

const MODULE_ROLES_V1: RoleEntry[] = [
  {
    key: "owner",
    name: "Owner",
    rank: 100,
    capabilities: ALL_CAPS,
    isAutoAssigned: "owner_on_create",
  },
  {
    key: "manager",
    name: "Manager",
    rank: 70,
    capabilities: [
      "read",
      "write",
      "manage_users",
      "manage_settings",
      "manage_roles",
    ],
    isAutoAssigned: null,
  },
  {
    key: "member",
    name: "Member",
    rank: 30,
    capabilities: ["read", "write"],
    isAutoAssigned: "invite_default",
  },
  {
    key: "viewer",
    name: "Viewer",
    rank: 10,
    capabilities: ["read"],
    isAutoAssigned: null,
  },
];

/**
 * The three framework-default catalogs that get upserted on every migration
 * run. Idempotent: upsert keyed by catalogId.
 */
export function defaultCatalogs(now: Date): RoleCatalogDoc[] {
  return [
    {
      catalogId: "company.v1",
      scope: "company",
      moduleKey: null,
      version: 1,
      roles: COMPANY_ROLES_V1,
      createdAt: now,
      updatedAt: now,
    },
    {
      catalogId: "workspace.v1",
      scope: "workspace",
      moduleKey: null,
      version: 1,
      roles: WORKSPACE_ROLES_V1,
      createdAt: now,
      updatedAt: now,
    },
    {
      catalogId: "module.v1",
      scope: "module",
      moduleKey: null,
      version: 1,
      roles: MODULE_ROLES_V1,
      createdAt: now,
      updatedAt: now,
    },
  ];
}

// ─── Legacy role normalization ────────────────────────────────────────────
//
// Mapping table from any value that may currently sit on a company_admins or
// workspace_members row to the SMI v0.2 catalog role key. The Owner-everywhere
// migration uses these to normalize existing data.

export function normalizeCompanyRole(legacy: string): string {
  switch (legacy) {
    case "super_admin":
    case "owner":
      return "owner";
    case "admin":
      return "admin";
    case "manager":
      return "manager";
    case "member":
      return "member";
    case "viewer":
      return "viewer";
    case "operator":
      // Operator is a JWT claim, not a Layer 2 role. If a row was seeded
      // with role=operator (some legacy code did this), treat it as admin
      // for now — the operator JWT independently grants cross-tenant view.
      return "admin";
    default:
      return "member";
  }
}

export function normalizeWorkspaceRole(legacy: string): string {
  switch (legacy) {
    case "super_admin":
    case "admin":
    case "owner":
      return "owner";
    case "manager":
      return "manager";
    case "member":
      return "member";
    case "viewer":
      return "viewer";
    case "operator":
      return "manager"; // see note in normalizeCompanyRole
    default:
      return "member";
  }
}
