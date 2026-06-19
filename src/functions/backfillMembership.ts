/**
 * backfillMembership — operator-only repair for invites that flipped to
 * `accepted` but never got a membership row written (Deploy 5.13).
 *
 * Pre-5.11 accepts never wrote rows; post-5.11 accepts can still fail if
 * the sibling DB write throws. listInvitesV3 surfaces these as
 * `membershipStatus = "missing"` or `"failed"`. This function fixes them.
 *
 * Semantics:
 *   - Invite MUST be in `accepted` status (404 otherwise — nothing to
 *     backfill on a pending or revoked invite).
 *   - Uses `invite.acceptedBy` as the target user (the person who
 *     originally accepted), not the operator running the backfill. That
 *     way the membership row's userId matches what the operator sees.
 *   - Idempotent: if a matching membership row already exists we emit
 *     `portal.membership_already_present` and return; we do NOT clobber
 *     an existing higher-privilege role.
 *   - Portal-level invites (companyId + workspaceId both null) return
 *     a `skipped` result instead of 404 so bulk callers don't blow up.
 *   - Audit row's `actorUserId` is the operator running the backfill
 *     (so the audit log shows who repaired it), while the payload's
 *     `userId` is the original accepter.
 *   - Emits a new `portal.membership_backfilled` event tag (a
 *     wrapper around `granted` so the audit log can distinguish
 *     accept-time grants from operator backfills).
 */
import type { Db } from "mongodb";
import type { Logger } from "pino";
import { collections } from "../mongo";
import type { IdentityContext } from "../vendor/authz";

export interface BackfillContext {
  db: Db;
  logger: Logger;
  identity: IdentityContext;
  companiesDb?: Db;
  workspacesDb?: Db;
}

export type BackfillAction =
  | "granted"
  | "already_present"
  | "skipped"
  | "failed";

export interface BackfillResult {
  ok: true;
  inviteId: string;
  target: "company" | "workspace" | "portal";
  action: BackfillAction;
  role: string | null;
  companyId: string | null;
  workspaceId: string | null;
  userId: string | null;
  error?: string;
}

export async function backfillMembership(
  inviteId: string,
  ctx: BackfillContext,
): Promise<BackfillResult> {
  if (!ctx.identity.operator) {
    const err = new Error("operator_required");
    (err as Error & { status?: number }).status = 403;
    throw err;
  }
  if (!inviteId) {
    const err = new Error("inviteId_required");
    (err as Error & { status?: number }).status = 400;
    throw err;
  }

  const invite = await collections.invitesV3(ctx.db).findOne({ inviteId });
  if (!invite) {
    const err = new Error("invite_not_found");
    (err as Error & { status?: number }).status = 404;
    throw err;
  }
  if (invite.status !== "accepted") {
    // Nothing to backfill — there's no acceptedBy on a pending/revoked
    // invite. Return 409 so callers can distinguish from "missing invite".
    const err = new Error(`invite_${invite.status}`);
    (err as Error & { status?: number }).status = 409;
    throw err;
  }
  if (!invite.acceptedBy) {
    const err = new Error("invite_missing_acceptedBy");
    (err as Error & { status?: number }).status = 409;
    throw err;
  }

  const targetUserId = invite.acceptedBy;
  const operatorId = ctx.identity.user.userId;
  const auditCol = collections.portalAuditLog(ctx.db);
  const now = new Date();

  const baseResult: BackfillResult = {
    ok: true,
    inviteId: invite.inviteId,
    target: "portal",
    action: "skipped",
    role: invite.role ?? null,
    companyId: invite.companyId,
    workspaceId: invite.workspaceId,
    userId: targetUserId,
  };

  const audit = async (
    event:
      | "portal.membership_backfilled"
      | "portal.membership_already_present"
      | "portal.membership_write_failed",
    target: "company" | "workspace",
    role: string,
    extra?: Record<string, unknown>,
  ) => {
    try {
      await auditCol.insertOne({
        at: new Date(),
        actorUserId: operatorId,
        event,
        payload: {
          inviteId: invite.inviteId,
          userId: targetUserId,
          target,
          role,
          companyId: invite.companyId,
          workspaceId: invite.workspaceId,
          backfill: true,
          ...(extra ?? {}),
        },
      });
    } catch (err) {
      ctx.logger.warn(
        { err, event, inviteId: invite.inviteId },
        "portal_audit_log insert (backfill) failed",
      );
    }
  };

  // Workspace-scoped invite
  if (invite.workspaceId && ctx.workspacesDb) {
    baseResult.target = "workspace";
    const wmCol = ctx.workspacesDb.collection("workspace_members");
    try {
      const existing = await wmCol.findOne({
        userId: targetUserId,
        workspaceId: invite.workspaceId,
      });
      if (existing) {
        baseResult.action = "already_present";
        await audit(
          "portal.membership_already_present",
          "workspace",
          invite.role,
        );
      } else {
        await wmCol.insertOne({
          userId: targetUserId,
          workspaceId: invite.workspaceId,
          companyId: invite.companyId,
          role: invite.role,
          createdAt: now,
          addedBy: operatorId,
          inviteId: invite.inviteId,
          backfilled: true,
          backfilledBy: operatorId,
          backfilledAt: now,
        });
        baseResult.action = "granted";
        await audit("portal.membership_backfilled", "workspace", invite.role);
      }
    } catch (err) {
      baseResult.action = "failed";
      baseResult.error = err instanceof Error ? err.message : String(err);
      ctx.logger.error(
        { err, inviteId: invite.inviteId, workspaceId: invite.workspaceId },
        "backfill workspace_members write failed",
      );
      await audit("portal.membership_write_failed", "workspace", invite.role, {
        error: baseResult.error,
      });
    }
    return baseResult;
  }

  // Company-scoped invite
  if (invite.companyId && ctx.companiesDb) {
    baseResult.target = "company";
    const caCol = ctx.companiesDb.collection("company_admins");
    try {
      const existing = await caCol.findOne({
        userId: targetUserId,
        companyId: invite.companyId,
      });
      if (existing) {
        baseResult.action = "already_present";
        await audit(
          "portal.membership_already_present",
          "company",
          invite.role,
        );
      } else {
        await caCol.insertOne({
          userId: targetUserId,
          companyId: invite.companyId,
          role: invite.role,
          createdAt: now,
          addedBy: operatorId,
          inviteId: invite.inviteId,
          backfilled: true,
          backfilledBy: operatorId,
          backfilledAt: now,
        });
        baseResult.action = "granted";
        await audit("portal.membership_backfilled", "company", invite.role);
      }
    } catch (err) {
      baseResult.action = "failed";
      baseResult.error = err instanceof Error ? err.message : String(err);
      ctx.logger.error(
        { err, inviteId: invite.inviteId, companyId: invite.companyId },
        "backfill company_admins write failed",
      );
      await audit("portal.membership_write_failed", "company", invite.role, {
        error: baseResult.error,
      });
    }
    return baseResult;
  }

  // Portal-level invite — nothing to backfill.
  baseResult.target = "portal";
  baseResult.action = "skipped";
  return baseResult;
}
