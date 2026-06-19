/**
 * resendInviteV3 — operator resends a portal invite (Deploy 5.5).
 *
 * Operator-only. Regenerates the invite token and pushes expiresAt out by
 * portal_settings.invites.expiryHours (default 168h / 7 days) from "now".
 * Original createdAt and invitedBy stay pinned so audit history is preserved.
 *
 * Resend is allowed when the invite is "pending" or "expired" (expired
 * invites can be re-activated this way without minting a fresh row).
 * Accepted and revoked invites return 409 — operators must mint a new
 * invite instead.
 *
 * Emits portal.invite_resent to portal_audit_log. The new token is not
 * logged.
 */
import { randomBytes } from "node:crypto";
import type { Db } from "mongodb";
import type { Logger } from "pino";
import { collections, type InviteDocV3 } from "../mongo";
import type { IdentityContext } from "../vendor/authz";
import { getPortalSettings } from "./getPortalSettings";
import { sendInviteEmail } from "./sendInviteEmail";

interface ResendInviteInput {
  inviteId: string;
}

export interface ResendInviteOutput {
  inviteId: string;
  token: string;
  email: string;
  expiresAt: string;
  resentCount: number;
  status: "pending";
}

export async function resendInviteV3(
  rawInput: unknown,
  ctx: { db: Db; logger: Logger; identity: IdentityContext },
): Promise<ResendInviteOutput> {
  if (!ctx.identity.operator) {
    const err = new Error("operator_only");
    (err as Error & { status?: number }).status = 403;
    throw err;
  }

  const input = (rawInput ?? {}) as ResendInviteInput;
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
    const err = new Error("invite_revoked");
    (err as Error & { status?: number }).status = 409;
    throw err;
  }

  const settings = await getPortalSettings(ctx);
  const expiryHours = settings.invites?.expiryHours ?? 168;

  const now = new Date();
  const newToken = randomBytes(32).toString("base64url");
  const newExpiresAt = new Date(now.getTime() + expiryHours * 3600 * 1000);
  const newResentCount = (existing.resentCount ?? 0) + 1;

  // Reset status to "pending" in case it had drifted to "expired" client-side
  // (the schema permits expired; resend reactivates it with fresh time/token).
  const update: Partial<InviteDocV3> = {
    token: newToken,
    expiresAt: newExpiresAt,
    status: "pending",
    resentAt: now,
    resentBy: ctx.identity.user.userId,
    resentCount: newResentCount,
    // Clear the email-send error if there was one — operator is taking a
    // fresh swing. emailSentAt stays as-is (history of the last successful
    // send, if any).
    emailSendError: null,
  };

  await invites.updateOne({ inviteId }, { $set: update });

  ctx.logger.info(
    { inviteId, email: existing.email, resentCount: newResentCount },
    "invite_v3 resent",
  );

  try {
    await collections.portalAuditLog(ctx.db).insertOne({
      at: now,
      actorUserId: ctx.identity.user.userId,
      event: "portal.invite_resent",
      payload: {
        inviteId,
        email: existing.email,
        companyId: existing.companyId,
        workspaceId: existing.workspaceId,
        role: existing.role,
        expiresAt: newExpiresAt.toISOString(),
        resentCount: newResentCount,
        // Token deliberately not logged.
      },
    });
  } catch (err) {
    ctx.logger.warn({ err }, "portal_audit_log insert failed");
  }

  // Deploy 5.8 — fire the invite email via freshify-comms (resend trigger).
  // Best-effort; failures don't roll back the token rotation.
  void sendInviteEmail(
    { inviteId, trigger: "resend" },
    { db: ctx.db, logger: ctx.logger },
  ).catch((err) => {
    ctx.logger.warn({ err, inviteId }, "sendInviteEmail threw");
  });

  return {
    inviteId,
    token: newToken,
    email: existing.email,
    expiresAt: newExpiresAt.toISOString(),
    resentCount: newResentCount,
    status: "pending",
  };
}
