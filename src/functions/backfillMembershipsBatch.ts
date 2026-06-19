/**
 * backfillMembershipsBatch — operator-only bulk repair (Deploy 5.13).
 *
 * Scans accepted invites in the last 90 days, derives the same
 * membershipStatus that listInvitesV3 surfaces, and calls
 * `backfillMembership` on every invite with status `missing` or
 * `failed`. Returns an aggregate result so the UI can show a summary.
 *
 * Bounded by `MAX_BATCH` to keep the request from running away on
 * a large pre-5.11 backlog. Operators can call repeatedly until the
 * "Needs attention" count reaches zero.
 */
import type { Db } from "mongodb";
import type { Logger } from "pino";
import { collections, type PortalAuditDoc } from "../mongo";
import type { IdentityContext } from "../vendor/authz";
import {
  backfillMembership,
  type BackfillContext,
  type BackfillResult,
} from "./backfillMembership";

const MAX_BATCH = 50;
const LOOKBACK_DAYS = 90;

export interface BackfillBatchResult {
  scanned: number;
  attempted: number;
  granted: number;
  alreadyPresent: number;
  skipped: number;
  failed: number;
  results: BackfillResult[];
  // Sentinel — true when more candidates exist beyond MAX_BATCH; the
  // operator can press the button again to continue draining.
  hasMore: boolean;
}

export async function backfillMembershipsBatch(
  _input: unknown,
  ctx: BackfillContext & { identity: IdentityContext; db: Db; logger: Logger },
): Promise<BackfillBatchResult> {
  if (!ctx.identity.operator) {
    const err = new Error("operator_required");
    (err as Error & { status?: number }).status = 403;
    throw err;
  }

  const acceptedSince = new Date(
    Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
  );
  const accepted = await collections
    .invitesV3(ctx.db)
    .find({
      status: "accepted",
      acceptedAt: { $gte: acceptedSince },
      // Portal-level invites have nothing to backfill — exclude.
      $or: [
        { companyId: { $ne: null } },
        { workspaceId: { $ne: null } },
      ],
    })
    .sort({ acceptedAt: -1 })
    .limit(500) // cap the scan even before filtering
    .toArray();

  const inviteIds = accepted.map((i) => i.inviteId);
  if (inviteIds.length === 0) {
    return {
      scanned: 0,
      attempted: 0,
      granted: 0,
      alreadyPresent: 0,
      skipped: 0,
      failed: 0,
      results: [],
      hasMore: false,
    };
  }

  // Pull the latest membership audit event per invite. We need both
  // granted/already_present (to skip) and failed/backfilled (to retry
  // or skip-already-fixed). Sorted desc, first-write-wins per inviteId.
  const auditRows = await collections
    .portalAuditLog(ctx.db)
    .find({
      event: {
        $in: [
          "portal.membership_granted",
          "portal.membership_already_present",
          "portal.membership_write_failed",
          "portal.membership_backfilled",
        ],
      },
      "payload.inviteId": { $in: inviteIds },
    })
    .sort({ at: -1 })
    .toArray();

  const latestByInvite = new Map<string, PortalAuditDoc>();
  for (const row of auditRows) {
    const id = (row.payload?.inviteId as string | undefined) ?? null;
    if (!id) continue;
    if (!latestByInvite.has(id)) latestByInvite.set(id, row);
  }

  // Candidates: latest event is failed, OR no event at all (missing).
  // Already-granted and already-backfilled are skipped — nothing to do.
  const candidates = accepted.filter((inv) => {
    const ev = latestByInvite.get(inv.inviteId);
    if (!ev) return true; // missing
    return ev.event === "portal.membership_write_failed";
  });

  const slice = candidates.slice(0, MAX_BATCH);

  const result: BackfillBatchResult = {
    scanned: accepted.length,
    attempted: slice.length,
    granted: 0,
    alreadyPresent: 0,
    skipped: 0,
    failed: 0,
    results: [],
    hasMore: candidates.length > MAX_BATCH,
  };

  for (const invite of slice) {
    try {
      const out = await backfillMembership(invite.inviteId, ctx);
      result.results.push(out);
      if (out.action === "granted") result.granted += 1;
      else if (out.action === "already_present") result.alreadyPresent += 1;
      else if (out.action === "skipped") result.skipped += 1;
      else if (out.action === "failed") result.failed += 1;
    } catch (err) {
      ctx.logger.warn(
        { err, inviteId: invite.inviteId },
        "backfill batch — per-invite call threw",
      );
      result.failed += 1;
      result.results.push({
        ok: true,
        inviteId: invite.inviteId,
        target: invite.workspaceId ? "workspace" : "company",
        action: "failed",
        role: invite.role ?? null,
        companyId: invite.companyId,
        workspaceId: invite.workspaceId,
        userId: invite.acceptedBy ?? null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}
