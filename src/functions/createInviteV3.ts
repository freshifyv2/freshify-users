/**
 * createInviteV3 — operator creates a portal invite (Deploy 3).
 *
 * Operator-only. Persists an invite row with a token + expiresAt derived
 * from portal_settings.invites.expiryHours (default 168h / 7 days).
 *
 * emailSentAt is left null — Deploy 4 will wire freshify-comms to send the
 * portal_invite_v1 template and stamp emailSentAt on success.
 *
 * This is the new (v3) invite endpoint. The legacy `inviteUser` function
 * remains in place for the company-membership flow and writes to the
 * `pending_invites` collection. createInviteV3 writes to the new `invites`
 * collection.
 */
import { randomBytes } from "node:crypto";
import type { Db } from "mongodb";
import type { Logger } from "pino";
import { collections, type InviteDocV3 } from "../mongo";
import { newId } from "../identity";
import type { IdentityContext } from "../vendor/authz";
import { getPortalSettings } from "./getPortalSettings";
import { sendInviteEmail } from "./sendInviteEmail";

interface CreateInviteInput {
  email: string;
  companyId?: string | null;
  workspaceId?: string | null;
  role?: string;
}

export async function createInviteV3(
  rawInput: unknown,
  ctx: { db: Db; logger: Logger; identity: IdentityContext },
): Promise<InviteDocV3> {
  if (!ctx.identity.operator) {
    const err = new Error("operator_only");
    (err as Error & { status?: number }).status = 403;
    throw err;
  }

  const input = (rawInput ?? {}) as CreateInviteInput;
  const email = (input.email ?? "").trim().toLowerCase();
  if (!email || !email.includes("@")) {
    const err = new Error("valid_email_required");
    (err as Error & { status?: number }).status = 400;
    throw err;
  }

  const settings = await getPortalSettings(ctx);
  const expiryHours = settings.invites?.expiryHours ?? 168;
  const defaultRole = settings.invites?.defaultCompanyRole ?? "member";

  const now = new Date();
  const expiresAt = new Date(now.getTime() + expiryHours * 3600 * 1000);

  const invite: InviteDocV3 = {
    inviteId: newId("inv"),
    token: randomBytes(32).toString("base64url"),
    email,
    companyId: input.companyId ?? null,
    workspaceId: input.workspaceId ?? null,
    role: input.role ?? defaultRole,
    invitedBy: ctx.identity.user.userId,
    createdAt: now,
    expiresAt,
    status: "pending",
    acceptedBy: null,
    acceptedAt: null,
    emailSentAt: null,
    emailSendError: null,
  };

  await collections.invitesV3(ctx.db).insertOne(invite);

  ctx.logger.info(
    { inviteId: invite.inviteId, email, companyId: invite.companyId, role: invite.role },
    "invite_v3 created",
  );

  // Deploy 5 — portal audit. Best-effort. Email is logged; the token is not.
  try {
    await collections.portalAuditLog(ctx.db).insertOne({
      at: now,
      actorUserId: ctx.identity.user.userId,
      event: "portal.invite_created",
      payload: {
        inviteId: invite.inviteId,
        email,
        companyId: invite.companyId,
        workspaceId: invite.workspaceId,
        role: invite.role,
        expiresAt: expiresAt.toISOString(),
      },
    });
  } catch (err) {
    ctx.logger.warn({ err }, "portal_audit_log insert failed");
  }

  // Deploy 5.8 — fire the invite email via freshify-comms. Best-effort:
  // failures stamp emailSendError on the invite row and emit a
  // portal.invite_email_failed audit event, but never roll back the mint.
  void sendInviteEmail(
    { inviteId: invite.inviteId, trigger: "initial" },
    { db: ctx.db, logger: ctx.logger },
  ).catch((err) => {
    ctx.logger.warn({ err, inviteId: invite.inviteId }, "sendInviteEmail threw");
  });

  return invite;
}
