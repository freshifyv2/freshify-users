/**
 * login — email + password sign-in (the auth spec).
 *
 * Anonymous endpoint. Looks the user up by lowercased email, runs the
 * candidate password through the configured PasswordAuthAdapter, and on
 * success issues a JWT session (no company context — FE swaps for one with
 * /v1/session/select).
 *
 * Failure semantics are deliberately vague to avoid account enumeration:
 *   - no such email  → 401 invalid_credentials
 *   - bad password   → 401 invalid_credentials
 *   - unverified     → 403 email_not_verified  (this is the ONE case we
 *                       surface explicitly so the FE can offer a "resend
 *                       verification" link — the auth spec)
 *   - disabled       → 403 user_disabled
 *
 * Does NOT increment a lockout counter in this slice — that's a follow-up.
 * Rate limiting is the responsibility of the edge/proxy layer.
 */
import type { Db } from "mongodb";
import type { Logger } from "pino";
import { LoginInput, LoginOutput } from "../schemas";
import { collections } from "../mongo";
import { issueSessionToken, newId } from "../identity";
import { getOperatorAssignment } from "../operators";
import type { PasswordAuthAdapter } from "../auth";
import type { Publisher } from "../events/publisher";
import { systemIdentity } from "../events/publisher";

export async function login(
  rawInput: unknown,
  ctx: {
    db: Db;
    logger: Logger;
    passwordAdapter: PasswordAuthAdapter;
    publisher: Publisher;
  },
): Promise<LoginOutput> {
  const input = LoginInput.parse(rawInput);
  const email = input.email.toLowerCase().trim();

  const usersCol = collections.users(ctx.db);
  const user = await usersCol.findOne({ email });

  // Account enumeration mitigation: we still do a hash compare on a sentinel
  // hash when the user is missing, so the wall-clock cost is comparable.
  const sentinelHash =
    "$2a$12$abcdefghijklmnopqrstuuG/QFhx5w1HhdJ/2lW7Wpcvxy3v3GpgxC";

  if (!user || !user.passwordHash) {
    await ctx.passwordAdapter.verifyPassword(
      { hash: sentinelHash, candidate: input.password },
      ctx.logger,
    );
    const err = new Error("invalid_credentials");
    (err as Error & { status?: number }).status = 401;
    throw err;
  }

  const ok = await ctx.passwordAdapter.verifyPassword(
    { hash: user.passwordHash, candidate: input.password },
    ctx.logger,
  );
  if (!ok) {
    const err = new Error("invalid_credentials");
    (err as Error & { status?: number }).status = 401;
    throw err;
  }

  if (user.status === "disabled") {
    const err = new Error("user_disabled");
    (err as Error & { status?: number }).status = 403;
    throw err;
  }

  if (!user.emailVerifiedAt) {
    const err = new Error("email_not_verified");
    (err as Error & { status?: number }).status = 403;
    throw err;
  }

  const now = new Date();
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
      via: "otp" as const, // reuse the "otp" slot for credential-based auth; new enum value will follow once the event schema is bumped
      authenticatedAt: now.toISOString(),
    },
    identity: systemIdentity(),
  });

  return LoginOutput.parse({
    userId: user.userId,
    sessionToken: session.token,
    expiresAt: session.expiresAt.toISOString(),
  });
}
