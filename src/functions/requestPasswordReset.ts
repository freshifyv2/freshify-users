/**
 * requestPasswordReset — start a password reset flow (the auth spec).
 *
 * Anonymous endpoint. Always returns 200 with the same shape, regardless of
 * whether the email matches a real account — account enumeration mitigation.
 * Internally:
 *   - if the email matches an active user with a passwordHash, mint a fresh
 *     reset token (TTL 1h) and fire the email
 *   - older outstanding reset tokens for the same userId are tombstoned
 *   - if the email matches a user but they're disabled / unverified, we
 *     silently skip the email send — no point letting a disabled user reset
 *     their way back in
 *   - if the email doesn't match, we do nothing
 */
import type { Db } from "mongodb";
import type { Logger } from "pino";
import {
  RequestPasswordResetInput,
  RequestPasswordResetOutput,
} from "../schemas";
import { collections } from "../mongo";
import { newId } from "../identity";
import { sendPasswordResetEmail } from "./sendPasswordResetEmail";

// 1h reset window per the auth spec — short, because reset tokens
// are a hijack vector if mailboxes are compromised.
const RESET_TTL_SEC = 60 * 60;

export async function requestPasswordReset(
  rawInput: unknown,
  ctx: { db: Db; logger: Logger },
): Promise<RequestPasswordResetOutput> {
  const input = RequestPasswordResetInput.parse(rawInput);
  const email = input.email.toLowerCase().trim();

  const usersCol = collections.users(ctx.db);
  const resetCol = collections.passwordResets(ctx.db);

  const user = await usersCol.findOne({ email });
  const now = new Date();

  // Eligible only when active + verified + has a password to reset.
  const eligible = Boolean(
    user &&
      user.status === "active" &&
      user.emailVerifiedAt &&
      user.passwordHash,
  );

  if (eligible && user) {
    await resetCol.deleteMany({ userId: user.userId });
    const token = newId("rst").replace(/^rst_/, "");
    const expiresAt = new Date(now.getTime() + RESET_TTL_SEC * 1000);
    await resetCol.insertOne({
      token,
      userId: user.userId,
      email: user.email,
      createdAt: now,
      expiresAt,
      usedAt: null,
    });
    void sendPasswordResetEmail(
      { token, email: user.email, displayName: user.displayName ?? null },
      { db: ctx.db, logger: ctx.logger },
    ).catch((err) => {
      ctx.logger.warn(
        { err, userId: user.userId },
        "requestPasswordReset.send_email_failed",
      );
    });
  } else {
    ctx.logger.info({ email }, "requestPasswordReset.silent_skip");
  }

  // Always the same shape — no enumeration signal.
  return RequestPasswordResetOutput.parse({
    status: "ok",
  });
}
