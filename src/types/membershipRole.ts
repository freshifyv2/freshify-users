/**
 * membershipRole — closed enum of user-company membership role keys.
 *
 * Sprint 4 — centralizes the membership role enum that was previously
 * declared inline in mongo.ts (`MembershipDoc.role`, `InviteDoc.role`)
 * and at multiple Zod call sites in schemas/index.ts. Both layers now
 * import from here so the enum is single-sourced.
 *
 * Today the user-company membership has two tiers — admin and member.
 * This is intentionally narrower than the SMI company.v1 role catalog
 * (which adds owner/manager/viewer); membership rows persisted by the
 * Users service only ever take one of these two values. The wider catalog
 * lives in companies-be where it belongs.
 */
import { z } from "zod";

export const MEMBERSHIP_ROLES = ["admin", "member"] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

export const MembershipRoleSchema = z.enum(MEMBERSHIP_ROLES);

export const MEMBERSHIP_ROLE_LABELS: Record<MembershipRole, string> = {
  admin: "Admin",
  member: "Member",
};

export function isMembershipRole(v: unknown): v is MembershipRole {
  return (
    typeof v === "string" && (MEMBERSHIP_ROLES as readonly string[]).includes(v)
  );
}
