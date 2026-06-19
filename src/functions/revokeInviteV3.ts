/**
 * revokeInviteV3 — operator revokes a pending portal invite (Deploy 5.3).
 *
 * Operator-only. Marks an invite as status="revoked" so it can no longer
 * be accepted via /v1/portal-invites/:token/accept, even before its
 * natural expiresAt. Idempotent: revoking an already-revoked invite is a
 * 200 no-op; revoking an accepted invite is a 409.
 *
 * Emits portal.invite_revoked to portal_audit_log.
 */
import type { Db } from "mongodb";
import type { Logger } from "pino";
import { collections } from "../mongo";
import type { IdentityContext } from "../vendor/authz";

interface RevokeInviteInput {
  inviteId: string;
}

export interface RevokeInviteOutput {
  inviteId: string;
  status: "revoked" | "already_revoked";
}

export async function revokeInviteV3(
  rawInput: unknown,
  ctx: { db: Db; logger: Logger; identity: IdentityContext },
): Promise<RevokeInviteOutput> {
  if (!ctx.identity.operator) {
    const err = new Error("operator_only");
    (err as Error & { status?: number }).status = 403;
    throw err;
  }

  const input = (rawInput ?? {}) as RevokeInviteInput;
  const inviteId = (input.inviteId ?? "").trim();
  if (!inviteId) {
    const err = new Error("inviteId required");
    (err as Error & { status?: number }).status = 400;
    throw err;
  }

  const invites = collections.invitesV3(ctx.db);
  const existing = await invites.findOne({ inviteId });
  if (!existing) {
    const err = new Error("invite_not_found");
    (err as Error & { status?: number }).status = 404;
    throw err;
  }

  if (existing.status === "accepted") {
    const err = new Error("invite_already_accepted");
    (err as Error & { status?: number }).status = 409;
    throw err;
  }

  if (existing.status === "revoked") {
    // Idempotent — already revoked, no audit emission needed.
    return { inviteId, status: "already_revoked" };
  }

  const now = new Date();
  await invites.updateOne(
    { inviteId },
    { $set: { status: "revoked", revokedAt: now, revokedBy: ctx.identity.user.userId } },
  );

  ctx.logger.info({ inviteId, email: existing.email }, "invite_v3 revoked");

  try {
    await collections.portalAuditLog(ctx.db).insertOne({
      at: now,
      actorUserId: ctx.identity.user.userId,
      event: "portal.invite_revoked",
      payload: {
        inviteId,
        email: existing.email,
        companyId: existing.companyId,
        workspaceId: existing.workspaceId,
      },
    });
  } catch (err) {
    ctx.logger.warn({ err }, "portal_audit_log insert failed");
  }

  return { inviteId, status: "revoked" };
}
