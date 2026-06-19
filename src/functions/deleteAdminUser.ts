/**
 * deleteAdminUser — hard-delete a user record and all related data.
 *
 * Operator-only. Removes:
 *   1. The user document from the `users` collection
 *   2. Any `operator_assignment` document for that user
 *   3. Any `user_company_memberships` documents for that user
 *
 * Also makes best-effort calls to:
 *   - Companies BE to remove company memberships (logged on failure, never throws)
 *   - Workspaces BE to remove workspace memberships (logged on failure, never throws)
 *
 * Returns { deleted: true, userId } on success.
 * Returns 404 if the user does not exist.
 */
import type { Db } from "mongodb";
import type { Logger } from "pino";
import type { IdentityContext } from "../vendor/authz";
import { collections } from "../mongo";

const COMPANIES_URL =
  process.env.COMPANIES_SERVICE_URL ||
  "https://freshify-companies-sbzaekoo4q-uc.a.run.app";

const WORKSPACES_URL =
  process.env.WORKSPACES_SERVICE_URL ||
  "https://freshify-workspaces-sbzaekoo4q-uc.a.run.app";

export interface DeleteAdminUserInput {
  userId: string;
}

export interface DeleteAdminUserOutput {
  deleted: true;
  userId: string;
}

export async function deleteAdminUser(
  input: DeleteAdminUserInput,
  ctx: {
    db: Db;
    logger: Logger;
    identity: IdentityContext;
  },
): Promise<DeleteAdminUserOutput> {
  // Guard: operator-only
  if (!ctx.identity.operator) {
    const err = new Error("operator_required");
    (err as Error & { status?: number }).status = 403;
    throw err;
  }

  const { userId } = input;

  // 1. Verify user exists
  const userDoc = await collections.users(ctx.db).findOne({ userId });
  if (!userDoc) {
    const err = new Error("user_not_found");
    (err as Error & { status?: number }).status = 404;
    throw err;
  }

  // 2. Delete the user document
  await collections.users(ctx.db).deleteOne({ userId });
  ctx.logger.info({ userId }, "delete_admin_user_deleted_user");

  // 3. Delete any operator_assignment for this user
  const opResult = await ctx.db
    .collection("operator_assignments")
    .deleteOne({ userId });
  if (opResult.deletedCount > 0) {
    ctx.logger.info({ userId }, "delete_admin_user_deleted_operator_assignment");
  }

  // 4. Delete company memberships from local users DB
  const memResult = await collections.memberships(ctx.db).deleteMany({ userId });
  ctx.logger.info(
    { userId, count: memResult.deletedCount },
    "delete_admin_user_deleted_local_memberships",
  );

  // 5. Best-effort: notify Companies BE to remove memberships
  try {
    const compResp = await fetch(
      `${COMPANIES_URL}/v1/internal/memberships/${encodeURIComponent(userId)}`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
      },
    );
    ctx.logger.info(
      { userId, status: compResp.status },
      "delete_admin_user_companies_be_notified",
    );
  } catch (err) {
    ctx.logger.warn(
      { userId, err },
      "delete_admin_user_companies_be_notify_failed_best_effort",
    );
  }

  // 6. Best-effort: notify Workspaces BE to remove memberships
  try {
    const wsResp = await fetch(
      `${WORKSPACES_URL}/v1/internal/memberships/${encodeURIComponent(userId)}`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
      },
    );
    ctx.logger.info(
      { userId, status: wsResp.status },
      "delete_admin_user_workspaces_be_notified",
    );
  } catch (err) {
    ctx.logger.warn(
      { userId, err },
      "delete_admin_user_workspaces_be_notify_failed_best_effort",
    );
  }

  ctx.logger.info(
    { userId, operatorId: ctx.identity.operator.operatorId },
    "delete_admin_user_complete",
  );

  // Deploy 5.1 — portal audit (best-effort).
  try {
    await collections.portalAuditLog(ctx.db).insertOne({
      at: new Date(),
      actorUserId: ctx.identity.user.userId,
      event: "portal.admin_user_deleted",
      payload: { userId },
    });
  } catch (err) {
    ctx.logger.warn({ err }, "portal_audit_log insert failed");
  }

  return { deleted: true, userId };
}
