/**
 * sendInviteEmail — fire an invite email via freshify-comms (Deploy 5.8).
 *
 * Reads provider config from portal_settings.email (with env fallbacks) and
 * POSTs the rendered portal_invite_v1 template to the comms service. On
 * success stamps emailSentAt + emailMessageId on the invite row; on failure
 * stamps emailSendError. Either way emits a portal audit event.
 *
 * Best-effort: callers run this fire-and-forget after returning the invite
 * row. A send failure must never roll back the mint or resend — operators
 * can retry the email separately.
 */
import type { Db } from "mongodb";
import type { Logger } from "pino";
import { collections, type InviteDocV3 } from "../mongo";
import { getPortalSettings } from "./getPortalSettings";

interface SendInviteEmailInput {
  inviteId: string;
  // When set, used as the audit event suffix so retry vs initial sends
  // show up distinctly in the audit feed. Defaults to "initial".
  trigger?: "initial" | "resend" | "retry";
}

interface SendInviteEmailResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

const COMMS_DEFAULT_URL = "https://freshify-comms-sbzaekoo4q-uc.a.run.app";

function buildInviteLink(token: string): string {
  const portalUrl = (
    process.env.PORTAL_PUBLIC_URL ||
    "https://freshify-portal-shell-sbzaekoo4q-uc.a.run.app"
  ).replace(/\/+$/, "");
  return `${portalUrl}/invite/${encodeURIComponent(token)}`;
}

function scopeLabelFor(invite: InviteDocV3, appName: string): string {
  if (invite.workspaceId) {
    return `workspace ${invite.workspaceId}`;
  }
  if (invite.companyId) {
    return `customer ${invite.companyId}`;
  }
  return appName;
}

export async function sendInviteEmail(
  input: SendInviteEmailInput,
  ctx: { db: Db; logger: Logger },
): Promise<SendInviteEmailResult> {
  const inviteId = input.inviteId;
  const trigger = input.trigger ?? "initial";

  const invites = collections.invitesV3(ctx.db);
  const invite = await invites.findOne({ inviteId });
  if (!invite) {
    ctx.logger.warn({ inviteId }, "sendInviteEmail: invite_not_found");
    return { ok: false, error: "invite_not_found" };
  }

  // Read settings — getPortalSettings requires identity context for the
  // operator gate, so we read directly here (this helper runs in the
  // request lifecycle as a side-effect, not as an operator action).
  const settingsDoc = await collections
    .portalSettings(ctx.db)
    .findOne({ settingsId: "singleton" });
  const settings = settingsDoc ?? null;
  const emailCfg = settings?.email ?? {};
  const branding = settings?.branding ?? {};

  if (emailCfg.provider === "none") {
    ctx.logger.info({ inviteId }, "email_provider_disabled_skipping");
    return { ok: false, error: "provider_disabled" };
  }

  const commsUrl = (emailCfg.commsUrl || process.env.COMMS_URL || COMMS_DEFAULT_URL).replace(
    /\/+$/,
    "",
  );
  const secret = process.env.COMMS_SHARED_SECRET;
  if (!secret) {
    const error = "comms_secret_not_configured";
    ctx.logger.warn({ inviteId }, error);
    await invites.updateOne({ inviteId }, { $set: { emailSendError: error } });
    try {
      await collections.portalAuditLog(ctx.db).insertOne({
        at: new Date(),
        actorUserId: invite.invitedBy,
        event: "portal.invite_email_failed",
        payload: {
          inviteId,
          email: invite.email,
          trigger,
          error,
        },
      });
    } catch (err) {
      ctx.logger.warn({ err }, "portal_audit_log insert failed");
    }
    return { ok: false, error };
  }

  const inviteLink = buildInviteLink(invite.token);
  const appName = branding.appName ?? "Sovereign Portal";
  const senderName = emailCfg.senderName ?? appName;
  const senderAddress = emailCfg.senderAddress ?? "noreply@freshify.io";
  const replyTo = emailCfg.replyTo ?? undefined;
  const accentColor = branding.accentColor ?? "#0F0F0F";

  const payload = {
    template: "portal_invite_v1",
    to: { email: invite.email },
    from: { email: senderAddress, name: senderName },
    replyTo,
    idempotencyKey: `invite:${inviteId}:${trigger}:${invite.token.slice(0, 8)}`,
    data: {
      inviteLink,
      appName,
      role: invite.role,
      scopeLabel: scopeLabelFor(invite, appName),
      expiresAt: invite.expiresAt.toISOString(),
      accentColor,
      inviterName: appName,
    },
  };

  let messageId: string | undefined;
  let provider: string | undefined;
  let sendError: string | undefined;

  try {
    const res = await fetch(`${commsUrl}/v1/email/send`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-comms-secret": secret,
      },
      body: JSON.stringify(payload),
    });
    const bodyText = await res.text();
    if (!res.ok) {
      sendError = `comms_${res.status}:${bodyText.slice(0, 200)}`;
    } else {
      try {
        const parsed = JSON.parse(bodyText) as {
          messageId?: string;
          provider?: string;
        };
        messageId = parsed.messageId;
        provider = parsed.provider;
      } catch {
        sendError = "comms_unparseable_response";
      }
    }
  } catch (err) {
    sendError = err instanceof Error ? err.message : String(err);
  }

  const now = new Date();
  if (sendError) {
    await invites.updateOne(
      { inviteId },
      { $set: { emailSendError: sendError, emailSentAt: null } },
    );
    ctx.logger.warn({ inviteId, sendError, trigger }, "invite_email_send_failed");
    try {
      await collections.portalAuditLog(ctx.db).insertOne({
        at: now,
        actorUserId: invite.invitedBy,
        event: "portal.invite_email_failed",
        payload: {
          inviteId,
          email: invite.email,
          trigger,
          error: sendError,
        },
      });
    } catch (err) {
      ctx.logger.warn({ err }, "portal_audit_log insert failed");
    }
    return { ok: false, error: sendError };
  }

  await invites.updateOne(
    { inviteId },
    {
      $set: {
        emailSentAt: now,
        emailSendError: null,
        emailMessageId: messageId ?? null,
        emailProvider: provider ?? null,
      },
    },
  );
  ctx.logger.info(
    { inviteId, messageId, provider, trigger },
    "invite_email_sent",
  );

  try {
    await collections.portalAuditLog(ctx.db).insertOne({
      at: now,
      actorUserId: invite.invitedBy,
      event: "portal.invite_email_sent",
      payload: {
        inviteId,
        email: invite.email,
        trigger,
        provider: provider ?? null,
        messageId: messageId ?? null,
      },
    });
  } catch (err) {
    ctx.logger.warn({ err }, "portal_audit_log insert failed");
  }

  return { ok: true, messageId };
}
