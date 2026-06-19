/**
 * register — start an email + password sign-up flow (the auth spec).
 *
 * Anonymous endpoint. Creates (or returns) a user with a bcrypt password hash
 * + an unverified email. Mints a verification token (TTL 24h) and fires off
 * an email via freshify-comms (best-effort — token is still usable from a
 * dev-peek endpoint or from the operator audit row if mail fails).
 *
 * Idempotent enough to be safe to retry:
 *   - If the email already exists AND has emailVerifiedAt set, we return
 *     `already_verified` and DO NOT touch the password. Caller should funnel
 *     into login.
 *   - If the email exists but is NOT verified, we treat it as a re-send:
 *     update the password hash (the user is mid-flow, they just retried with
 *     a new password) and re-mint a fresh verification token. Older tokens
 *     for the same userId are tombstoned.
 *   - If the email does not exist, we create a fresh user row with status
 *     "invited" (no company memberships yet) and mint a verification token.
 *
 * Does NOT return a session token. The user must verify their email first;
 * verifyEmail issues the session.
 */
import type { Db } from "mongodb";
import type { Logger } from "pino";
import { RegisterInput, RegisterOutput } from "../schemas";
import { collections, type UserDoc } from "../mongo";
import { newId } from "../identity";
import type { PasswordAuthAdapter } from "../auth";
import type { Publisher } from "../events/publisher";
import { systemIdentity } from "../events/publisher";
import { sendVerificationEmail } from "./sendVerificationEmail";

// 24h verification window per the auth spec
const VERIFICATION_TTL_SEC = 24 * 60 * 60;

export async function register(
  rawInput: unknown,
  ctx: {
    db: Db;
    logger: Logger;
    passwordAdapter: PasswordAuthAdapter;
    publisher: Publisher;
  },
): Promise<RegisterOutput> {
  const input = RegisterInput.parse(rawInput);
  const email = input.email.toLowerCase().trim();

  // Password policy first — fail before we touch Mongo so the error is cheap.
  const policyErr = ctx.passwordAdapter.checkPasswordPolicy(input.password);
  if (policyErr) {
    const err = new Error(`password_policy:${policyErr}`);
    (err as Error & { status?: number }).status = 400;
    throw err;
  }

  const usersCol = collections.users(ctx.db);
  const verifyCol = collections.emailVerifications(ctx.db);
  const now = new Date();

  const existing = await usersCol.findOne({ email });

  if (existing?.emailVerifiedAt) {
    // Already verified — funnel the caller to login. We deliberately do NOT
    // confirm or deny whether the password matches; that's login's job.
    ctx.logger.info({ email }, "register.already_verified");
    return RegisterOutput.parse({
      userId: existing.userId,
      status: "already_verified",
      expiresAt: null,
    });
  }

  const { hash } = await ctx.passwordAdapter.hashPassword(
    input.password,
    ctx.logger,
  );

  let user: UserDoc;
  let isNewUser = false;

  if (existing) {
    // Re-send: refresh password hash, leave the user row otherwise alone.
    user = existing;
    await usersCol.updateOne(
      { userId: user.userId },
      {
        $set: {
          passwordHash: hash,
          displayName: input.displayName ?? user.displayName,
          updatedAt: now,
        },
      },
    );
    user.passwordHash = hash;
    if (input.displayName) user.displayName = input.displayName;
    // Tombstone older outstanding tokens for this user — only the freshest
    // verification link is honoured.
    await verifyCol.deleteMany({ userId: user.userId });
  } else {
    isNewUser = true;
    user = {
      userId: newId("usr"),
      email,
      displayName: input.displayName ?? null,
      phoneE164: null,
      createdAt: now,
      updatedAt: now,
      status: "invited",
      passwordHash: hash,
      emailVerifiedAt: null,
      userType: "user",
    };
    await usersCol.insertOne(user);
  }

  const token = newId("evf").replace(/^evf_/, ""); // 16-byte base64url, no prefix
  const expiresAt = new Date(now.getTime() + VERIFICATION_TTL_SEC * 1000);
  await verifyCol.insertOne({
    token,
    userId: user.userId,
    email: user.email,
    createdAt: now,
    expiresAt,
  });

  // Fire-and-forget email send. If comms is down, the token still exists in
  // Mongo and an operator can resend.
  void sendVerificationEmail(
    { token, email: user.email, displayName: user.displayName ?? null },
    { db: ctx.db, logger: ctx.logger },
  ).catch((err) => {
    ctx.logger.warn({ err, userId: user.userId }, "register.send_email_failed");
  });

  if (isNewUser) {
    await ctx.publisher.emit({
      name: "users.created",
      payload: {
        userId: user.userId,
        email: user.email,
        displayName: user.displayName,
        via: "password" as const,
        createdAt: now.toISOString(),
      },
      identity: systemIdentity(),
    });
  }

  return RegisterOutput.parse({
    userId: user.userId,
    status: isNewUser ? "verification_sent" : "verification_resent",
    expiresAt: expiresAt.toISOString(),
  });
}
