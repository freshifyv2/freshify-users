/**
 * ModuleAdmin — per-tenant, per-module admin grant.
 *
 * Sprint 4 — Module Registry Settings (Phase B).
 *
 * Mirrors the shape established by `freshify-companies` and
 * `freshify-workspaces` — kept duplicated rather than imported across
 * module boundaries so each sovereign module owns its own collection
 * independently.
 *
 *   - `moduleKey`     — "users" | "companies" | "workspaces" (this module
 *                       also holds module-admin grants for the other two
 *                       sovereign modules via the Sprint 1 bootstrap).
 *   - `tenantScope`   — "portal" | "company" | "workspace". The public v1
 *                       endpoints only operate on the "portal" singleton;
 *                       the wider shape is reserved.
 *   - `tenantId`      — "singleton" when tenantScope === "portal", or
 *                       null for Sprint 1 legacy bootstrap rows.
 *   - `source`        — "bootstrap" when granted automatically as the
 *                       first user of a tenant, "manual" otherwise.
 */
import { z } from "zod";

import { TENANT_SCOPES, type TenantScope } from "./moduleSettings";

export const MODULE_ADMIN_SOURCES = ["bootstrap", "manual"] as const;
export type ModuleAdminSource = (typeof MODULE_ADMIN_SOURCES)[number];

export interface ModuleAdminDoc {
  moduleKey: string;
  tenantScope: TenantScope;
  tenantId: string | null;
  userId: string;
  grantedAt: Date;
  grantedBy: string | null;
  source: ModuleAdminSource;
}

export interface ModuleAdminView {
  moduleKey: string;
  tenantScope: TenantScope;
  tenantId: string;
  userId: string;
  grantedAt: string;
  grantedBy: string | null;
  source: ModuleAdminSource;
}

export function toModuleAdminView(doc: ModuleAdminDoc): ModuleAdminView {
  return {
    moduleKey: doc.moduleKey,
    tenantScope: doc.tenantScope,
    tenantId: doc.tenantId ?? "singleton",
    userId: doc.userId,
    grantedAt: doc.grantedAt.toISOString(),
    grantedBy: doc.grantedBy,
    source: doc.source,
  };
}

export const AddModuleAdminInputSchema = z
  .object({
    userId: z.string().min(1),
  })
  .strict();

export type AddModuleAdminInput = z.infer<typeof AddModuleAdminInputSchema>;

export { TENANT_SCOPES };
export type { TenantScope };
