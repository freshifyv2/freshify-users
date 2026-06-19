/**
 * listInvitesV3 — operator-only listing of outstanding + recently-accepted
 * portal invites with derived membership status (Deploy 5.12).
 *
 * Returns:
 *   - all `pending` invites whose expiresAt is in the future
 *   - all `accepted` invites whose acceptedAt is within the last 30 days
 *
 * For each invite, we look up the latest `portal.membership_*` audit event
 * keyed by `payload.inviteId` and derive a `membershipStatus` field so the
 * operator UI can flag invites that accepted but never granted membership
 * (i.e. need a backfill).
 *
 * membershipStatus values:
 *   - "pending"        — invite still outstanding (not yet accepted)
 *   - "granted"        — accepted + membership row written
 *   - "already_member" — accepted + user was already a member (no-op)
 *   - "failed"         — accepted + membership write threw (explicit event)
 *   - "missing"        — accepted + no membership audit event recorded
 *                        (older accept, pre-5.11 — needs backfill)
 *   - "n/a"            — portal-level invite (no membership target)
 */
import type { Db } from "mongodb";
import { collections, type InviteDocV3, type PortalAuditDoc } from "../mongo";
import type { IdentityContext } from "../vendor/authz";
import type { Logger } from "pino";
import {
  loadUserNames,
  loadCompanyNames,
  loadWorkspaceNames,
} from "./_displayNameHelpers";

export type MembershipStatus =
  | "pending"
  | "granted"
  | "already_member"
  | "failed"
  | "missing"
  | "n/a";

export interface ListInvitesV3Output {
  invites: Array<{
    inviteId: string;
    email: string;
    token: string;
    companyId: string | null;
    // Deploy 5.15 — hydrated display names so the operator table can render
    // "Sovereign Corp" / "Operations" / "Alex Morgan" instead of opaque IDs.
    companyName?: string | null;
    workspaceId: string | null;
    workspaceName?: string | null;
    role: string;
    invitedBy: string;
    invitedByName?: string | null;
    acceptedByName?: string | null;
    createdAt: string;
    expiresAt: string;
    status: InviteDocV3["status"];
    acceptedAt?: string | null;
    acceptedBy?: string | null;
    resentCount?: number;
    emailSentAt?: string | null;
    emailSendError?: string | null;
    emailProvider?: string | null;
    // Deploy 5.12 — derived from latest portal.membership_* audit event
    membershipStatus: MembershipStatus;
    membershipEventAt?: string | null;
    membershipError?: string | null;
  }>;
}

const ACCEPTED_LOOKBACK_DAYS = 30;
const MEMBERSHIP_EVENTS = [
  "portal.membership_granted",
  "portal.membership_already_present",
  "portal.membership_write_failed",
  // Deploy 5.13 — backfill emits this; treat as granted for status purposes
  // so the row clears the Needs-attention filter after a successful repair.
  "portal.membership_backfilled",
];

function membershipStatusFromEvent(event: string | null): MembershipStatus {
  if (event === "portal.membership_granted") return "granted";
  if (event === "portal.membership_backfilled") return "granted";
  if (event === "portal.membership_already_present") return "already_member";
  if (event === "portal.membership_write_failed") return "failed";
  return "missing";
}

export async function listInvitesV3(
  _input: unknown,
  ctx: { db: Db; identity: IdentityContext; logger: Logger },
): Promise<ListInvitesV3Output> {
  if (!ctx.identity.operator) {
    const err = new Error("operator_required");
    (err as Error & { status?: number }).status = 403;
    throw err;
  }
  const now = new Date();
  const acceptedSince = new Date(
    now.getTime() - ACCEPTED_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
  );

  // Pull pending (unexpired) + recently-accepted in a single OR query so the
  // operator gets both outstanding work and recent outcomes in one view.
  const rows = await collections
    .invitesV3(ctx.db)
    .find({
      $or: [
        { status: "pending", expiresAt: { $gt: now } },
        { status: "accepted", acceptedAt: { $gte: acceptedSince } },
      ],
    })
    .sort({ createdAt: -1 })
    .limit(100)
    .toArray();

  // Batch lookup: latest membership event per inviteId. We sort by `at` desc
  // then take the first row per inviteId via a JS reduce — index is on
  // (event, at desc) so this is cheap for the limited inviteId set.
  const acceptedInviteIds = rows
    .filter((r) => r.status === "accepted")
    .map((r) => r.inviteId);

  const latestByInvite = new Map<string, PortalAuditDoc>();
  if (acceptedInviteIds.length > 0) {
    const auditRows = await collections
      .portalAuditLog(ctx.db)
      .find({
        event: { $in: MEMBERSHIP_EVENTS },
        "payload.inviteId": { $in: acceptedInviteIds },
      })
      .sort({ at: -1 })
      .toArray();
    for (const row of auditRows) {
      const inviteId = (row.payload?.inviteId as string | undefined) ?? null;
      if (!inviteId) continue;
      // First occurrence wins because we sorted desc.
      if (!latestByInvite.has(inviteId)) latestByInvite.set(inviteId, row);
    }
  }

  // Deploy 5.15 — hydrate inviter / acceptor / company / workspace display
  // names in parallel. Each helper degrades to an empty map on failure so the
  // list never fails because of a join miss.
  const [userNames, companyNames, workspaceNames] = await Promise.all([
    loadUserNames(
      ctx.db,
      [
        ...rows.map((r) => r.invitedBy),
        ...rows.map((r) => r.acceptedBy ?? null),
      ],
      ctx.logger,
    ),
    loadCompanyNames(
      rows.map((r) => r.companyId),
      ctx.logger,
    ),
    loadWorkspaceNames(
      rows.map((r) => r.workspaceId),
      ctx.logger,
    ),
  ]);

  return {
    invites: rows.map((r) => {
      let membershipStatus: MembershipStatus;
      let membershipEventAt: string | null = null;
      let membershipError: string | null = null;

      if (r.status === "pending") {
        membershipStatus = "pending";
      } else if (!r.companyId && !r.workspaceId) {
        // Portal-level invite — there is no membership row to write.
        membershipStatus = "n/a";
      } else {
        const event = latestByInvite.get(r.inviteId);
        membershipStatus = membershipStatusFromEvent(event?.event ?? null);
        membershipEventAt = event ? event.at.toISOString() : null;
        if (event?.event === "portal.membership_write_failed") {
          const err = event.payload?.error;
          membershipError = typeof err === "string" ? err : null;
        }
      }

      return {
        inviteId: r.inviteId,
        email: r.email,
        token: r.token,
        companyId: r.companyId,
        companyName: r.companyId ? (companyNames.get(r.companyId) ?? null) : null,
        workspaceId: r.workspaceId,
        workspaceName: r.workspaceId
          ? (workspaceNames.get(r.workspaceId) ?? null)
          : null,
        role: r.role,
        invitedBy: r.invitedBy,
        invitedByName: userNames.get(r.invitedBy) ?? null,
        acceptedByName: r.acceptedBy
          ? (userNames.get(r.acceptedBy) ?? null)
          : null,
        createdAt: r.createdAt.toISOString(),
        expiresAt: r.expiresAt.toISOString(),
        status: r.status,
        acceptedAt: r.acceptedAt ? r.acceptedAt.toISOString() : null,
        acceptedBy: r.acceptedBy ?? null,
        resentCount: r.resentCount ?? 0,
        emailSentAt: r.emailSentAt ? r.emailSentAt.toISOString() : null,
        emailSendError: r.emailSendError ?? null,
        emailProvider: r.emailProvider ?? null,
        membershipStatus,
        membershipEventAt,
        membershipError,
      };
    }),
  };
}
