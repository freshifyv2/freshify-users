/**
 * verifyEmail — consume a verification token, flip emailVerifiedAt, issue a
 * session (the auth spec).
 *
 * Anonymous endpoint. The token IS the auth — possession of an unused,
 * unexpired token proves control of the email inbox.
 *
 * On success:
 *   - users.emailVerifiedAt = now
 *   - users.status moves from "invited" → "active" (only if it was "invited";
 *     we don't clobber "disabled")
 *   - the verification row is deleted (single use)
 *   - any other verification rows for the same userId are tombstoned
 *   - a JWT session is issued with no company context (FE calls
 *     /v1/session/select afterwards, same as the OTP path)
 *   - emits users.authenticated via "invite" — same convention as
 *     acceptInvite, this is the first authentication
 *
 * Error cases:
 *   - token not found → 404 token_not_found
 *   - token expired   → 410 token_expired
 *   - user disabled   → 403 user_disabled
 */
import type { Db } from "mongodb";
import type { Logger } from "pino";
import { VerifyEmailInput, VerifyEmailOutput } from "../schemas";
import { collections, type UserDoc } from "../mongo";
import { issueSessionToken, newId } from "../identity";
import { getOperatorAssignment } from "../operators";
import type { Publisher } from "../events/publisher";
import { systemIdentity } from "../events/publisher";

export async function verifyEmail(
  rawInput: unknown,
  ctx: { db: Db; logger: Logger; publisher: Publisher },
): Promise<VerifyEmailOutput> {
  const input = VerifyEmailInput.parse(rawInput);

  const verifyCol = collections.emailVerifications(ctx.db);
  const usersCol = collections.users(ctx.db);

  const row = await verifyCol.findOne({ token: input.token });
  if (!row) {
    const err = new Error("token_not_found");
    (err as Error & { status?: number }).status = 404;
    throw err;
  }
  const now = new Date();
  if (row.expiresAt.getTime() < now.getTime()) {
    // TTL index will sweep this; do it eagerly so the slot is free.
    await verifyCol.deleteOne({ token: row.token });
    const err = new Error("token_expired");
    (err as Error & { status?: number }).status = 410;
    throw err;
  }

  const user = await usersCol.findOne({ userId: row.userId });
  if (!user) {
    await verifyCol.deleteOne({ token: row.token });
    const err = new Error("user_not_found");
    (err as Error & { status?: number }).status = 404;
    throw err;
  }
  if (user.status === "disabled") {
    const err = new Error("user_disabled");
    (err as Error & { status?: number }).status = 403;
    throw err;
  }

  // Update + activate the user atomically with the token consume.
  const update: Partial<UserDoc> = {
    emailVerifiedAt: now,
    updatedAt: now,
  };
  if (user.status === "invited") update.status = "active";
  await usersCol.updateOne({ userId: user.userId }, { $set: update });

  // Tombstone every verification row tied to this user, including the one we
  // just used. Single-use, fully cleaned up.
  await verifyCol.deleteMany({ userId: user.userId });

  // Issue a session — no company context yet, FE handles the selector flow.
  const operatorAssignment = await getOperatorAssignment(ctx.db, user.userId);
  const operatorClaim = operatorAssignment
    ? { operatorId: user.userId, reason: operatorAssignment.reason }
    : null;

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
      via: "invite" as const,
      authenticatedAt: now.toISOString(),
    },
    identity: systemIdentity(),
  });

  return VerifyEmailOutput.parse({
    userId: user.userId,
    email: user.email,
    sessionToken: session.token,
    expiresAt: session.expiresAt.toISOString(),
  });
}
