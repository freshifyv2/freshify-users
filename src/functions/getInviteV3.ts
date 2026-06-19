/**
 * getInviteV3 — public lookup by token. Used by the signup page to render
 * "You've been invited to <company>" before the user creates an account.
 *
 * Returns only the safe surface: email, companyId/workspaceId, role, status,
 * expiresAt. The token itself is implicit (caller already has it).
 */
import type { Db } from "mongodb";
import { collections } from "../mongo";

export async function getInviteV3(
  token: string,
  ctx: { db: Db },
): Promise<{
  inviteId: string;
  email: string;
  companyId: string | null;
  workspaceId: string | null;
  role: string;
  status: string;
  expiresAt: string;
}> {
  if (!token) {
    const err = new Error("token_required");
    (err as Error & { status?: number }).status = 400;
    throw err;
  }
  const invite = await collections.invitesV3(ctx.db).findOne({ token });
  if (!invite) {
    const err = new Error("invite_not_found");
    (err as Error & { status?: number }).status = 404;
    throw err;
  }
  // Auto-expire (read-side): if expired but still marked pending, surface
  // status=expired without mutating; the migration / accept flow handles
  // the actual state transition.
  const effectiveStatus =
    invite.status === "pending" && invite.expiresAt < new Date()
      ? "expired"
      : invite.status;

  return {
    inviteId: invite.inviteId,
    email: invite.email,
    companyId: invite.companyId,
    workspaceId: invite.workspaceId,
    role: invite.role,
    status: effectiveStatus,
    expiresAt: invite.expiresAt.toISOString(),
  };
}
