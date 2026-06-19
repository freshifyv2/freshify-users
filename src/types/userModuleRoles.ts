/**
 * userModuleRoles — closed enum of role keys for the users module's
 * Module Registry Settings (Phase B).
 *
 * Sprint 4 — mirrors the framework-default Module catalog v1 declared in
 * src/roleCatalogs.ts: owner / manager / member / viewer. Used by the
 * Phase B moduleSettings validation so the "Available Roles" / "Default
 * Role" controls can validate locally without calling out to the catalog
 * persistence layer.
 *
 * The runtime catalog (rank, capabilities, labels) still lives in
 * roleCatalogs.ts — this module only owns the key-set.
 */
export const UserModuleRoleKeys = [
  "owner",
  "manager",
  "member",
  "viewer",
] as const;

export type UserModuleRoleKey = (typeof UserModuleRoleKeys)[number];

export function isUserModuleRoleKey(
  value: unknown,
): value is UserModuleRoleKey {
  return (
    typeof value === "string" &&
    (UserModuleRoleKeys as readonly string[]).includes(value)
  );
}
