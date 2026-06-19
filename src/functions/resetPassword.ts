/**
 * resetPassword — consume a reset token, rehash, invalidate other sessions
 * (the auth spec).
 *
 * Anonymous endpoint (token IS the auth). On success:
 *   - users.passwordHash = new bcrypt hash
 *   - the reset row is deleted (single use)
 *   - all other reset tokens for the same user are tombstoned
 *   - all outstanding session rows for the user are deleted, EXCEPT the new
 *     one we issue here. This invalidates any in-flight sessions on other
 *     devices, per the auth spec
 *
 * Returns a JWT session so the user lands signed in (typical UX after reset).
 */
import type { Db } from "mongodb";
import type { Logger } from "pino";
import { ResetPasswordInput, ResetPasswordOutput } from "../schemas";
import { collections } from "../mongo";
import { issueSessionToken, newId } from "../identity";
import { getOperatorAssignment } from "../operators";
import { ensureOperatorPortalAdmin } from "./ensureOperatorPortalAdmin";
import type { PasswordAuthAdapter } from "../auth";
import type { Publisher } from "../events/publisher";
import { systemIdentity } from "../events/publisher";

export async function resetPassword(
  rawInput: unknown,
  ctx: {
    db: Db;
    logger: Logger;
    passwordAdapter: PasswordAuthAdapter;
    publisher: Publisher;
  },
): Promise<ResetPasswordOutput> {
  const input = ResetPasswordInput.parse(rawInput);

  const policyErr = ctx.passwordAdapter.checkPasswordPolicy(input.password);
  if (policyErr) {
    const err = new Error(`password_policy:${policyErr}`);
    (err as Error & { status?: number }).status = 400;
    throw err;
  }

  const resetCol = collections.passwordResets(ctx.db);
  const usersCol = collections.users(ctx.db);
  const sessionsCol = collections.sessions(ctx.db);

  const row = await resetCol.findOne({ token: input.token });
  if (!row) {
    const err = new Error("token_not_found");
    (err as Error & { status?: number }).status = 404;
    throw err;
  }
  const now = new Date();
  if (row.expiresAt.getTime() < now.getTime()) {
    await resetCol.deleteOne({ token: row.token });
    const err = new Error("token_expired");
    (err as Error & { status?: number }).status = 410;
    throw err;
  }
  if (row.usedAt) {
    const err = new Error("token_already_used");
    (err as Error & { status?: number }).status = 410;
    throw err;
  }

  const user = await usersCol.findOne({ userId: row.userId });
  if (!user) {
    await resetCol.deleteOne({ token: row.token });
    const err = new Error("user_not_found");
    (err as Error & { status?: number }).status = 404;
    throw err;
  }
  if (user.status === "disabled") {
    const err = new Error("user_disabled");
    (err as Error & { status?: number }).status = 403;
    throw err;
  }

  const { hash } = await ctx.passwordAdapter.hashPassword(
    input.password,
    ctx.logger,
  );

  await usersCol.updateOne(
    { userId: user.userId },
    { $set: { passwordHash: hash, updatedAt: now } },
  );

  // Consume + tombstone every reset row tied to this user.
  await resetCol.deleteMany({ userId: user.userId });

  // Invalidate every existing session for this user — they all rotate.
  await sessionsCol.deleteMany({ userId: user.userId });

  // Issue a fresh session so the user lands signed in.
  const operatorAssignment = await getOperatorAssignment(ctx.db, user.userId);
  const operatorClaim = operatorAssignment
    ? { operatorId: user.userId, reason: operatorAssignment.reason }
    : null;
  if (operatorClaim) {
    await ensureOperatorPortalAdmin(ctx.db, ctx.logger, user.userId);
  }

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
  await sessionsCol.insertOne({
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

  return ResetPasswordOutput.parse({
    userId: user.userId,
    sessionToken: session.token,
    expiresAt: session.expiresAt.toISOString(),
  });
}
