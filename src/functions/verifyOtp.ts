/**
 * verifyOtp — complete an OTP sign-in flow.
 *
 * If the code is valid:
 *   - find or create the user (identifier becomes their primary contact)
 *   - record an auth_sessions row
 *   - issue a JWT session token
 *   - emit users.created on first sign-in, users.authenticated on every sign-in
 *
 * Returns the session token and an `isNewUser` flag the client uses to
 * route into onboarding vs. dashboard.
 */
import { createHash } from "node:crypto";
import type { Db } from "mongodb";
import type { Logger } from "pino";
import { VerifyOtpInput, VerifyOtpOutput } from "../schemas";
import { collections, type UserDoc } from "../mongo";
import { issueSessionToken, newId } from "../identity";
import { getOperatorAssignment } from "../operators";
import { ensureOperatorPortalAdmin } from "./ensureOperatorPortalAdmin";
import type { AuthAdapter } from "../auth";
import type { Publisher } from "../events/publisher";
import { systemIdentity } from "../events/publisher";

const MAX_ATTEMPTS = 5;

export async function verifyOtp(
  rawInput: unknown,
  ctx: {
    db: Db;
    logger: Logger;
    adapter: AuthAdapter;
    publisher: Publisher;
  },
): Promise<VerifyOtpOutput> {
  const input = VerifyOtpInput.parse(rawInput);

  // Throttle by attempt count, regardless of which challenge row matches.
  // (Twilio Verify also throttles on its side; this is defense-in-depth.)
  const otpCol = collections.otps(ctx.db);
  const recent = await otpCol.findOne(
    { identifier: input.identifier, channel: input.channel },
    { sort: { createdAt: -1 } },
  );
  if (recent && recent.attempts >= MAX_ATTEMPTS) {
    const err = new Error("too_many_attempts");
    (err as Error & { status?: number }).status = 429;
    throw err;
  }
  if (recent) {
    await otpCol.updateOne(
      { challengeId: recent.challengeId },
      { $inc: { attempts: 1 } },
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Dev bypass code — double-gated like /v1/dev/peek-otp.
  //   Gate 1: DEV_OTP_BYPASS=1 env var must be set
  //   Gate 2: NO Twilio env var may be present (auto-closes the moment real
  //           SMS is wired)
  // When both gates open, the fixed code `424242` is accepted for ANY
  // identifier. This is the demo-build signal that Twilio is intentionally
  // disabled and operators share the code verbally with prospects.
  // ─────────────────────────────────────────────────────────────────────────
  const bypassEnabled =
    process.env.DEV_OTP_BYPASS === "1" &&
    !process.env.TWILIO_ACCOUNT_SID &&
    !process.env.TWILIO_AUTH_TOKEN &&
    !process.env.TWILIO_VERIFY_SERVICE_SID;
  const bypassCode = process.env.DEV_OTP_BYPASS_CODE || "424242";
  const usedBypass = bypassEnabled && input.code === bypassCode;

  let ok = false;
  if (usedBypass) {
    ctx.logger.warn(
      { identifier: input.identifier, channel: input.channel },
      "dev_otp_bypass_used",
    );
    ok = true;
  } else {
    ok = await ctx.adapter.verifyChallenge(
      {
        identifier: input.identifier,
        channel: input.channel,
        code: input.code,
      },
      ctx.logger,
    );
  }
  if (!ok) {
    const err = new Error("invalid_code");
    (err as Error & { status?: number }).status = 401;
    throw err;
  }

  // Find-or-create user. The identifier maps to email or phoneE164 depending
  // on the channel. We always require a canonical email for the user record;
  // phone-only users get a synthetic email of the form `phone+<E164>@users.freshify.io`.
  //
  // Lookup strategy:
  //   - email channel: find by email (lowercased identifier)
  //   - sms channel:   find by phoneE164 first (canonical), then fall back to
  //                    the legacy synthetic email. This makes operator/user
  //                    renames safe — once a user's email is changed to a real
  //                    address, we still find them on next phone login via
  //                    phoneE164 instead of creating a ghost duplicate.
  const usersCol = collections.users(ctx.db);
  const email =
    input.channel === "email"
      ? input.identifier.toLowerCase()
      : `phone+${input.identifier.replace(/[^0-9+]/g, "")}@users.freshify.io`;
  const phoneE164 = input.channel === "sms" ? input.identifier : null;

  const now = new Date();
  let existing: UserDoc | null = null;
  if (input.channel === "sms" && phoneE164) {
    existing = await usersCol.findOne({ phoneE164 });
    if (!existing) {
      existing = await usersCol.findOne({ email });
    }
  } else {
    existing = await usersCol.findOne({ email });
  }
  let user: UserDoc;
  let isNewUser = false;

  if (!existing) {
    isNewUser = true;
    user = {
      userId: newId("usr"),
      email,
      displayName: input.displayName ?? null,
      phoneE164,
      createdAt: now,
      updatedAt: now,
      status: "active",
    };
    await usersCol.insertOne(user);

    await ctx.publisher.emit({
      name: "users.created",
      payload: {
        userId: user.userId,
        email: user.email,
        displayName: user.displayName,
        via: "otp" as const,
        createdAt: now.toISOString(),
      },
      identity: systemIdentity(),
    });
  } else {
    user = existing;
    if (input.displayName && !user.displayName) {
      // First-time display name capture on existing phone-only user
      await usersCol.updateOne(
        { userId: user.userId },
        { $set: { displayName: input.displayName, updatedAt: now } },
      );
      user.displayName = input.displayName;
    }
  }

  // Check for operator assignment — propagates operator identity into JWT.
  const operatorAssignment = await getOperatorAssignment(ctx.db, user.userId);
  const operatorClaim = operatorAssignment
    ? { operatorId: user.userId, reason: operatorAssignment.reason }
    : null;
  if (operatorClaim) {
    await ensureOperatorPortalAdmin(ctx.db, ctx.logger, user.userId);
  }

  // Issue session with no company context. The FE is expected to call
  // GET /v1/companies, present an account switcher (or auto-pick the only
  // membership), then call POST /v1/session/select to swap the JWT for one
  // with companyId/workspaceId populated.
  const session = issueSessionToken({
    userId: user.userId,
    email: user.email,
    displayName: user.displayName ?? "",
    companyId: null,
    companyName: null,
    workspaceId: null,
    workspaceName: null,
    roles: [],
    operator: operatorClaim,
  });
  const sessionId = newId("ses");
  await collections.sessions(ctx.db).insertOne({
    sessionId,
    userId: user.userId,
    tokenHash: session.tokenHash,
    issuedAt: now,
    expiresAt: session.expiresAt,
    ip: null,
    userAgent: null,
  });

  await ctx.publisher.emit({
    name: "users.authenticated",
    payload: {
      userId: user.userId,
      email: user.email,
      sessionId,
      via: "otp" as const,
      authenticatedAt: now.toISOString(),
    },
    identity: systemIdentity(),
  });

  // Tombstone the OTP rows for this identifier so they can't be replayed.
  await otpCol.deleteMany({ identifier: input.identifier, channel: input.channel });

  void createHash; // imported above to keep the option open for token rotation logging
  return VerifyOtpOutput.parse({
    userId: user.userId,
    isNewUser,
    sessionToken: session.token,
    expiresAt: session.expiresAt.toISOString(),
  });
}
