/**
 * sendPasswordResetEmail — fire the password_reset email via freshify-comms.
 *
 * Same shape as sendVerificationEmail. The matching template lives in
 * freshify-comms — slice 5.18f adds it.
 */
import type { Db } from "mongodb";
import type { Logger } from "pino";
import { collections } from "../mongo";

interface SendPasswordResetEmailInput {
  token: string;
  email: string;
  displayName: string | null;
}

interface SendPasswordResetEmailResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

const COMMS_DEFAULT_URL = "https://freshify-comms-sbzaekoo4q-uc.a.run.app";

function buildResetLink(token: string): string {
  const portalUrl = (
    process.env.PORTAL_PUBLIC_URL ||
    "https://freshify-portal-shell-sbzaekoo4q-uc.a.run.app"
  ).replace(/\/+$/, "");
  return `${portalUrl}/reset-password/${encodeURIComponent(token)}`;
}

export async function sendPasswordResetEmail(
  input: SendPasswordResetEmailInput,
  ctx: { db: Db; logger: Logger },
): Promise<SendPasswordResetEmailResult> {
  const settingsDoc = await collections
    .portalSettings(ctx.db)
    .findOne({ settingsId: "singleton" });
  const settings = settingsDoc ?? null;
  const emailCfg = settings?.email ?? {};
  const branding = settings?.branding ?? {};

  if (emailCfg.provider === "none") {
    ctx.logger.info({ email: input.email }, "email_provider_disabled_skipping_password_reset");
    return { ok: false, error: "provider_disabled" };
  }

  const commsUrl = (
    emailCfg.commsUrl ||
    process.env.COMMS_URL ||
    COMMS_DEFAULT_URL
  ).replace(/\/+$/, "");
  const secret = process.env.COMMS_SHARED_SECRET;
  if (!secret) {
    const error = "comms_secret_not_configured";
    ctx.logger.warn({ email: input.email }, error);
    return { ok: false, error };
  }

  const resetLink = buildResetLink(input.token);
  const appName = branding.appName ?? "Sovereign Portal";
  const senderName = emailCfg.senderName ?? appName;
  const senderAddress = emailCfg.senderAddress ?? "noreply@freshify.io";
  const replyTo = emailCfg.replyTo ?? undefined;
  const accentColor = branding.accentColor ?? "#0F0F0F";

  const payload = {
    template: "password_reset_v1",
    to: { email: input.email },
    from: { email: senderAddress, name: senderName },
    replyTo,
    idempotencyKey: `reset:${input.token.slice(0, 16)}`,
    data: {
      resetLink,
      appName,
      displayName: input.displayName,
      accentColor,
    },
  };

  let messageId: string | undefined;
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
        const parsed = JSON.parse(bodyText) as { messageId?: string };
        messageId = parsed.messageId;
      } catch {
        sendError = "comms_unparseable_response";
      }
    }
  } catch (err) {
    sendError = err instanceof Error ? err.message : String(err);
  }

  const now = new Date();
  try {
    await collections.portalAuditLog(ctx.db).insertOne({
      at: now,
      actorUserId: null,
      event: sendError ? "portal.password_reset_email_failed" : "portal.password_reset_email_sent",
      payload: {
        email: input.email,
        ...(messageId ? { messageId } : {}),
        ...(sendError ? { error: sendError } : {}),
      },
    });
  } catch (err) {
    ctx.logger.warn({ err }, "portal_audit_log insert failed (password_reset)");
  }

  if (sendError) {
    ctx.logger.warn({ email: input.email, sendError }, "password_reset_email_send_failed");
    return { ok: false, error: sendError };
  }
  ctx.logger.info({ email: input.email, messageId }, "password_reset_email_sent");
  return { ok: true, messageId };
}
