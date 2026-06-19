/**
 * inviteUser — invite a user to a company by email.
 *
 * Caller must be authenticated AND have an admin role on the target company.
 * Creates a pending_invites row with a single-use token (32 bytes, base64url),
 * 7-day TTL, and emits users.invited.
 *
 * The actual email delivery is the framework's responsibility — we emit the
 * event with the token; the comms module subscribes and renders the email.
 */
import { randomBytes } from "node:crypto";
import type { Db } from "mongodb";
import type { Logger } from "pino";
import { InviteUserInput, InviteUserOutput } from "../schemas";
import { collections } from "../mongo";
import { newId } from "../identity";
import type { IdentityContext } from "../vendor/authz";
import type { Publisher } from "../events/publisher";

const INVITE_TTL_SEC = 60 * 60 * 24 * 7; // 7 days

export async function inviteUser(
  rawInput: unknown,
  ctx: {
    db: Db;
    logger: Logger;
    identity: IdentityContext;
    publisher: Publisher;
  },
): Promise<InviteUserOutput> {
  const input = InviteUserInput.parse(rawInput);

  if (!ctx.identity.company) {
    const err = new Error("company_context_required");
    (err as Error & { status?: number }).status = 400;
    throw err;
  }
  // Admin check
  const isAdmin = ctx.identity.roles.some(
    (r) => r.layer === "company" && r.role === "admin",
  );
  if (!isAdmin) {
    const err = new Error("insufficient_role");
    (err as Error & { status?: number }).status = 403;
    throw err;
  }

  const email = input.email.toLowerCase();
  const companyId = ctx.identity.company.companyId;
  const now = new Date();

  // Don't re-invite an already-active member
  const existingUser = await collections.users(ctx.db).findOne({ email });
  if (existingUser) {
    const existingMembership = await collections
      .memberships(ctx.db)
      .findOne({ userId: existingUser.userId, companyId });
    if (existingMembership) {
      const err = new Error("user_already_member");
      (err as Error & { status?: number }).status = 409;
      throw err;
    }
  }

  const inviteId = newId("inv");
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + INVITE_TTL_SEC * 1000);

  await collections.invites(ctx.db).insertOne({
    inviteId,
    token,
    email,
    companyId,
    role: input.role,
    invitedBy: ctx.identity.user.userId,
    createdAt: now,
    expiresAt,
    status: "pending",
  });

  await ctx.publisher.emit({
    name: "users.invited",
    payload: {
      inviteId,
      email,
      companyId,
      role: input.role,
      invitedBy: ctx.identity.user.userId,
      expiresAt: expiresAt.toISOString(),
    },
    identity: ctx.identity,
  });

  ctx.logger.info({ inviteId, email, companyId, role: input.role }, "user invited");

  return InviteUserOutput.parse({
    inviteId,
    email,
    expiresAt: expiresAt.toISOString(),
  });
}
