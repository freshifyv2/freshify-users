/**
 * userStatus — closed enum of user account status keys.
 *
 * Sprint 4 — centralizes the user status enum that was previously declared
 * inline in mongo.ts (`UserDoc.status`) and schemas/index.ts
 * (`GetUserOutput.status`, `ListUsersOutput.users[].status`). Both sites
 * now import from here so the enum is single-sourced and adding a new
 * value is a one-line change.
 *
 * Wire validation is strict — any persisted value not in this set will
 * fail Zod parsing at the API boundary, which is the correct loud failure
 * rather than a silent coercion.
 */
import { z } from "zod";

export const USER_STATUSES = ["active", "invited", "disabled"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const UserStatusSchema = z.enum(USER_STATUSES);

export const USER_STATUS_LABELS: Record<UserStatus, string> = {
  active: "Active",
  invited: "Invited",
  disabled: "Disabled",
};

export function isUserStatus(v: unknown): v is UserStatus {
  return typeof v === "string" && (USER_STATUSES as readonly string[]).includes(v);
}
