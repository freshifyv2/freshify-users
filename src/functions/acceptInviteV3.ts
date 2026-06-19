/**
 * acceptInviteV3 — redeem a portal v3 invite token for a logged-in user.
 *
 * Requires an authenticated session. The session user's email must match
 * the invite email (lowercased). On success:
 *   - flips invite status -> accepted
 *   - records acceptedBy + acceptedAt
 *   - writes the membership row (Deploy 5.11):
 *       * companyId set, workspaceId null  → company_admins
 *       * workspaceId set                  → workspace_members
 *       * both null                        → portal-level operator invite,
 *                                            no membership row written
 *   - emits portal_audit_log rows for `portal.invite_accepted` and, when a
 *     membership row is granted, `portal.membership_granted`.
 *
 * Membership writes are idempotent: if a matching (userId,companyId) or
 * (userId,workspaceId) row already exists we leave it alone, audit a
 * `portal.membership_already_present` event, and continue. We do NOT
 * downgrade an existing higher-privilege role.
 */
import type { Db } from "mongodb";
import type { Logger } from "pino";
import { collections, type InviteDocV3 } from "../mongo";
import type { IdentityContext } from "../vendor/authz";
import { bootstrapModuleAdmin } from "./bootstrapModuleAdmin";

export interface AcceptInviteContext {
  db: Db;
  logger: Logger;
  identity: IdentityContext;
  /** Optional sibling DB used for company_admins writes. */
  companiesDb?: Db;
  /** Optional sibling DB used for workspace_members writes. */
  workspacesDb?: Db;
}

export interface AcceptInviteResult {
  ok: true;
  invite: InviteDocV3;
  membership: {
    target: "company" | "workspace" | "portal";
    action: "granted" | "already_present" | "skipped" | "failed";
    role: string | null;
    companyId: string | null;
    workspaceId: string | null;
  };
}

export async function acceptInviteV3(
  token: string,
  ctx: AcceptInviteContext,
): Promise<AcceptInviteResult> {
  if (!token) {
    const err = new Error("token_required");
    (err as Error & { status?: number }).status = 400;
    throw err;
  }
  const invitesCol = collections.invitesV3(ctx.db);
  const invite = await invitesCol.findOne({ token });
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
    await invitesCol.updateOne(
      { inviteId: invite.inviteId, status: "pending" },
      { $set: { status: "expired" } },
    );
    const err = new Error("invite_expired");
    (err as Error & { status?: number }).status = 410;
    throw err;
  }

  const usersCol = collections.users(ctx.db);
  const user = await usersCol.findOne({ userId: ctx.identity.user.userId });
  if (!user) {
    const err = new Error("user_not_found");
    (err as Error & { status?: number }).status = 404;
    throw err;
  }
  if (user.email.toLowerCase() !== invite.email.toLowerCase()) {
    const err = new Error("invite_email_mismatch");
    (err as Error & { status?: number }).status = 403;
    throw err;
  }

  const now = new Date();
  await invitesCol.updateOne(
    { inviteId: invite.inviteId, status: "pending" },
    {
      $set: {
        status: "accepted",
        acceptedBy: user.userId,
        acceptedAt: now,
      },
    },
  );

  const updated: InviteDocV3 = {
    ...invite,
    status: "accepted",
    acceptedBy: user.userId,
    acceptedAt: now,
  };

  ctx.logger.info(
    { inviteId: invite.inviteId, userId: user.userId },
    "invite_v3 accepted",
  );

  // ─── Deploy 5.1 audit — invite_accepted (always, best-effort) ───────────
  const auditCol = collections.portalAuditLog(ctx.db);
  try {
    await auditCol.insertOne({
      at: now,
      actorUserId: user.userId,
      event: "portal.invite_accepted",
      payload: {
        inviteId: invite.inviteId,
        email: invite.email,
        companyId: invite.companyId,
        workspaceId: invite.workspaceId,
        role: invite.role,
      },
    });
  } catch (err) {
    ctx.logger.warn({ err }, "portal_audit_log insert (invite_accepted) failed");
  }

  // ─── Deploy 5.11 — membership write-through ─────────────────────────────
  const membership: AcceptInviteResult["membership"] = {
    target: "portal",
    action: "skipped",
    role: invite.role ?? null,
    companyId: invite.companyId,
    workspaceId: invite.workspaceId,
  };

  // Helper: emit a membership audit row, swallow failures.
  const auditMembership = async (
    event:
      | "portal.membership_granted"
      | "portal.membership_already_present"
      | "portal.membership_write_failed",
    target: "company" | "workspace",
    role: string,
    extra?: Record<string, unknown>,
  ) => {
    try {
      await auditCol.insertOne({
        at: new Date(),
        actorUserId: user.userId,
        event,
        payload: {
          inviteId: invite.inviteId,
          userId: user.userId,
          target,
          role,
          companyId: invite.companyId,
          workspaceId: invite.workspaceId,
          ...(extra ?? {}),
        },
      });
    } catch (err) {
      ctx.logger.warn({ err, event }, "portal_audit_log insert (membership) failed");
    }
  };

  // Workspace-scoped invite — write workspace_members row.
  if (invite.workspaceId && ctx.workspacesDb) {
    membership.target = "workspace";
    const wmCol = ctx.workspacesDb.collection("workspace_members");
    try {
      const existing = await wmCol.findOne({
        userId: user.userId,
        workspaceId: invite.workspaceId,
      });
      if (existing) {
        membership.action = "already_present";
        await auditMembership(
          "portal.membership_already_present",
          "workspace",
          invite.role,
        );
      } else {
        await wmCol.insertOne({
          userId: user.userId,
          workspaceId: invite.workspaceId,
          companyId: invite.companyId,
          role: invite.role,
          createdAt: now,
          addedBy: invite.invitedBy,
          inviteId: invite.inviteId,
        });
        membership.action = "granted";
        await auditMembership(
          "portal.membership_granted",
          "workspace",
          invite.role,
        );
      }
    } catch (err) {
      ctx.logger.error(
        { err, inviteId: invite.inviteId, workspaceId: invite.workspaceId },
        "workspace_members write failed",
      );
      membership.action = "failed";
      // Emit explicit failed event so the operator surface can flag it
      // without having to infer absence-of-granted.
      await auditMembership(
        "portal.membership_write_failed",
        "workspace",
        invite.role,
        { error: err instanceof Error ? err.message : String(err) },
      );
      // Don't fail the accept — invite is already flipped. The audit row
      // 'portal.invite_accepted' is in place; the explicit
      // 'membership_write_failed' row is the signal a backfill is needed.
    }
  }
  // Company-scoped invite (no workspace) — write company_admins row.
  else if (invite.companyId && ctx.companiesDb) {
    membership.target = "company";
    const caCol = ctx.companiesDb.collection("company_admins");
    try {
      const existing = await caCol.findOne({
        userId: user.userId,
        companyId: invite.companyId,
      });
      if (existing) {
        membership.action = "already_present";
        await auditMembership(
          "portal.membership_already_present",
          "company",
          invite.role,
        );
      } else {
        await caCol.insertOne({
          userId: user.userId,
          companyId: invite.companyId,
          role: invite.role,
          createdAt: now,
          addedBy: invite.invitedBy,
          inviteId: invite.inviteId,
        });
        membership.action = "granted";
        await auditMembership(
          "portal.membership_granted",
          "company",
          invite.role,
        );
      }
    } catch (err) {
      ctx.logger.error(
        { err, inviteId: invite.inviteId, companyId: invite.companyId },
        "company_admins write failed",
      );
      membership.action = "failed";
      await auditMembership(
        "portal.membership_write_failed",
        "company",
        invite.role,
        { error: err instanceof Error ? err.message : String(err) },
      );
    }
  }
  // Portal-level invite (both nulls) — no membership row to write.
  else if (!invite.companyId && !invite.workspaceId) {
    membership.target = "portal";
    membership.action = "skipped";
  }

  // ─── Sprint 1 5.18f — Module Admin bootstrap ───────────────────────────
  // If this accept granted the FIRST membership in a company, promote the
  // accepter to Module Admin of the Users module for that company. The
  // helper itself enforces the "first user" semantics (count rows; insert
  // only if none). Failure is logged inside the helper and never blocks
  // the accept response.
  if (
    membership.action === "granted" &&
    membership.target === "company" &&
    invite.companyId
  ) {
    const boot = await bootstrapModuleAdmin({
      db: ctx.db,
      logger: ctx.logger,
      moduleKey: "users",
      tenantScope: "company",
      tenantId: invite.companyId,
      userId: user.userId,
    });
    try {
      await auditCol.insertOne({
        at: new Date(),
        actorUserId: user.userId,
        event: "portal.module_admin_bootstrap",
        payload: {
          moduleKey: "users",
          tenantScope: "company",
          tenantId: invite.companyId,
          userId: user.userId,
          action: boot.action,
          source: "acceptInviteV3",
          ...(boot.reason ? { reason: boot.reason } : {}),
        },
      });
    } catch (err) {
      ctx.logger.warn(
        { err },
        "portal_audit_log insert (module_admin_bootstrap) failed",
      );
    }
  }

  return { ok: true, invite: updated, membership };
}
