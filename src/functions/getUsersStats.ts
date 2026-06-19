/**
 * getUsersStats — operator dashboard counters for the Users module.
 *
 * Counts:
 *   - total users
 *   - active in last 7 days (uses lastActivityAt; falls back to updatedAt)
 *   - users currently in invited state (status === "invited")
 *   - outstanding portal invites (invites collection, status pending, not expired)
 */
import type { Db } from "mongodb";
import { collections } from "../mongo";
import type { IdentityContext } from "../vendor/authz";

export async function getUsersStats(
  ctx: { db: Db; identity: IdentityContext },
): Promise<{
  total: number;
  activeLast7d: number;
  invited: number;
  outstandingInvites: number;
}> {
  if (!ctx.identity.operator) {
    const err = new Error("operator_only");
    (err as Error & { status?: number }).status = 403;
    throw err;
  }
  const usersCol = collections.users(ctx.db);
  const invitesCol = collections.invitesV3(ctx.db);
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000);

  const [total, activeLast7d, invited, outstandingInvites] = await Promise.all([
    usersCol.countDocuments({}),
    usersCol.countDocuments({
      $or: [
        { lastActivityAt: { $gte: sevenDaysAgo } },
        { lastActivityAt: { $exists: false }, updatedAt: { $gte: sevenDaysAgo } },
      ],
    }),
    usersCol.countDocuments({ status: "invited" }),
    invitesCol.countDocuments({ status: "pending", expiresAt: { $gt: now } }),
  ]);

  return { total, activeLast7d, invited, outstandingInvites };
}
