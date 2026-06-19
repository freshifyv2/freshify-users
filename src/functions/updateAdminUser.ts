/**
 * updateAdminUser — operator updates an existing user's editable fields.
 *
 * Editable fields:
 *   • displayName
 *   • email           (lowercased on write)
 *   • phoneE164       (E.164 validated)
 *   • status          (active | inactive)
 *
 * Operator-only. Caller must have ctx.identity.operator set.
 *
 * Membership changes (company / workspace assignments) are NOT handled here —
 * those are owned by Companies BE / Workspaces BE and are mutated via their
 * own endpoints (or via createAdminUser at user-creation time).
 */
import type { Db } from "mongodb";
import type { Logger } from "pino";
import { z } from "zod";
import { collections } from "../mongo";
import type { IdentityContext } from "../vendor/authz";

export const UpdateAdminUserInput = z.object({
  displayName: z.string().min(1).max(120).optional(),
  email: z.string().email().optional(),
  phone: z.string().regex(/^\+[1-9]\d{7,14}$/).optional().nullable(),
  status: z.enum(["active", "inactive"]).optional(),
});
export type UpdateAdminUserInput = z.infer<typeof UpdateAdminUserInput>;

export interface UpdateAdminUserOutput {
  ok: true;
  userId: string;
  changed: string[];
}

export async function updateAdminUser(
  userId: string,
  rawInput: unknown,
  ctx: {
    db: Db;
    logger: Logger;
    identity: IdentityContext;
  },
): Promise<UpdateAdminUserOutput> {
  if (!ctx.identity.operator) {
    const err = new Error("operator_required");
    (err as Error & { status?: number }).status = 403;
    throw err;
  }

  const input = UpdateAdminUserInput.parse(rawInput);

  const usersCol = collections.users(ctx.db);
  const userDoc = await usersCol.findOne({ userId });
  if (!userDoc) {
    const err = new Error("user_not_found");
    (err as Error & { status?: number }).status = 404;
    throw err;
  }

  const set: Record<string, unknown> = { updatedAt: new Date() };
  const changed: string[] = [];

  if (input.displayName !== undefined && input.displayName !== userDoc.displayName) {
    set.displayName = input.displayName;
    changed.push("displayName");
  }
  if (input.email !== undefined) {
    const normalized = input.email.toLowerCase();
    if (normalized !== userDoc.email) {
      // Reject conflicts — another user already owns this email.
      const conflict = await usersCol.findOne({ email: normalized });
      if (conflict && conflict.userId !== userId) {
        const err = new Error("email_conflict");
        (err as Error & { status?: number }).status = 409;
        throw err;
      }
      set.email = normalized;
      changed.push("email");
    }
  }
  if (input.phone !== undefined && input.phone !== userDoc.phoneE164) {
    set.phoneE164 = input.phone;
    changed.push("phoneE164");
  }
  if (input.status !== undefined && input.status !== userDoc.status) {
    set.status = input.status;
    changed.push("status");
  }

  if (changed.length === 0) {
    return { ok: true, userId, changed };
  }

  await usersCol.updateOne({ userId }, { $set: set });

  ctx.logger.info(
    {
      userId,
      changed,
      operatorId: ctx.identity.operator.operatorId,
    },
    "operator_updated_user",
  );

  // Deploy 5.1 — portal audit (best-effort).
  try {
    await collections.portalAuditLog(ctx.db).insertOne({
      at: new Date(),
      actorUserId: ctx.identity.user.userId,
      event: "portal.admin_user_updated",
      payload: { userId, changed },
    });
  } catch (err) {
    ctx.logger.warn({ err }, "portal_audit_log insert failed");
  }

  return { ok: true, userId, changed };
}
