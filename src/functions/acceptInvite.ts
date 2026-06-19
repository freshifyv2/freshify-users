/**
 * acceptInvite — redeem an invite token.
 *
 * Anonymous endpoint (no session required). The token IS the auth.
 * If the user doesn't exist yet, create them and emit users.created.
 * Always attach the membership and issue a session token.
 */
import type { Db } from "mongodb";
import type { Logger } from "pino";
import { AcceptInviteInput, AcceptInviteOutput } from "../schemas";
import { collections, type UserDoc } from "../mongo";
import { issueSessionToken, newId } from "../identity";
import type { Publisher } from "../events/publisher";
import { systemIdentity } from "../events/publisher";

export async function acceptInvite(
  rawInput: unknown,
  ctx: { db: Db; logger: Logger; publisher: Publisher },
): Promise<AcceptInviteOutput> {
  const input = AcceptInviteInput.parse(rawInput);

  const invitesCol = collections.invites(ctx.db);
  const invite = await invitesCol.findOne({ token: input.token });
  if (!invite) {
    const err = new Error("invite_not_found");
    (err as Error & { status?: number }).status = 404;
    throw err;
  }
  if (invite.status !== "pending") {
    const err = new Error(`invite_${invite.status}`);
    (err as Error & { status?: number }).status = 410;
    throw err;
  }
  if (invite.expiresAt < new Date()) {
    const err = new Error("invite_expired");
    (err as Error & { status?: number }).status = 410;
    throw err;
  }

  const usersCol = collections.users(ctx.db);
  const now = new Date();
  const existing = await usersCol.findOne({ email: invite.email });
  let user: UserDoc;

  if (!existing) {
    user = {
      userId: newId("usr"),
      email: invite.email,
      displayName: input.displayName ?? null,
      phoneE164: null,
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
        via: "invite" as const,
        createdAt: now.toISOString(),
      },
      identity: systemIdentity(),
    });
  } else {
    user = existing;
    if (input.displayName && !user.displayName) {
      await usersCol.updateOne(
        { userId: user.userId },
        { $set: { displayName: input.displayName, updatedAt: now } },
      );
      user.displayName = input.displayName;
    }
  }

  // Attach the membership (idempotent — unique index protects us).
  await collections.memberships(ctx.db).updateOne(
    { userId: user.userId, companyId: invite.companyId },
    {
      $setOnInsert: {
        userId: user.userId,
        companyId: invite.companyId,
        role: invite.role,
        createdAt: now,
      },
    },
    { upsert: true },
  );

  await invitesCol.updateOne(
    { inviteId: invite.inviteId },
    { $set: { status: "accepted" } },
  );

  // Issue session with the company context already set.
  const session = issueSessionToken({
    userId: user.userId,
    email: user.email,
    displayName: user.displayName ?? "",
    companyId: invite.companyId,
    companyName: null,
    workspaceId: null,
    workspaceName: null,
    roles: [{ layer: "company", role: invite.role, scope: invite.companyId }],
  });

  await collections.sessions(ctx.db).insertOne({
    sessionId: newId("ses"),
    userId: user.userId,
    tokenHash: session.tokenHash,
    issuedAt: now,
    expiresAt: session.expiresAt,
    ip: null,
    userAgent: null,
  });

  ctx.logger.info(
    { userId: user.userId, companyId: invite.companyId },
    "invite accepted",
  );

  return AcceptInviteOutput.parse({
    userId: user.userId,
    companyId: invite.companyId,
    sessionToken: session.token,
  });
}
