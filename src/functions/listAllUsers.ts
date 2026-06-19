/**
 * listAllUsers — cross-tenant user listing for Freshify operators.
 *
 * Operator-only endpoint. Returns all users across every tenant with their
 * basic profile fields enriched by sibling sovereign module data.
 *
 * Cross-service enrichment (sovereign architecture — Users does NOT own
 * company memberships):
 *   • Company memberships → Companies BE `/v1/internal/memberships-for-user`
 *     (one call per user, parallel, fully resolved with name + role)
 *   • Workspace memberships → Workspaces BE `/v1/internal/memberships-for-user`
 *     (one call per user, parallel)
 *
 * Both calls degrade gracefully to empty arrays on sibling failure — the
 * operator list page never crashes due to a sibling outage.
 *
 * Previous implementation read `user_company_memberships` from the local Users
 * DB; that collection is dead state since Companies BE became the source of
 * truth (May 2026). Stage 4 fix.
 */
import type { Db } from "mongodb";
import type { Logger } from "pino";
import type { IdentityContext } from "../vendor/authz";
import { collections } from "../mongo";
import {
  fetchCompanyMembershipsForUser,
  fetchWorkspaceMembershipsForUser,
} from "../internalClients";

export interface AdminUserView {
  userId: string;
  displayName: string | null;
  email: string;
  handle: string | null;
  title: string | null;
  phone: string | null;
  lastActiveAt: string | null;
  status: "active" | "pending" | "inactive";
  assignedCompanies: Array<{
    companyId: string;
    name: string;
    role?: "admin" | "member";
    isPrimary?: boolean;
  }>;
  assignedWorkspaces: Array<{
    workspaceId: string;
    name: string;
    companyId?: string;
    role?: "admin" | "member";
  }>;
}

export interface ListAllUsersOutput {
  users: AdminUserView[];
  total: number;
}

export async function listAllUsers(
  ctx: {
    db: Db;
    logger: Logger;
    identity: IdentityContext;
  },
): Promise<ListAllUsersOutput> {
  if (!ctx.identity.operator) {
    const err = new Error("operator_required");
    (err as Error & { status?: number }).status = 403;
    throw err;
  }

  const allUsers = await collections.users(ctx.db).find({}).toArray();

  // Per-user parallel S2S resolution (matches getAdminUser pattern).
  // Bounded by Cloud Run concurrent fetch limits; typical operator session has
  // < 100 users so the in-flight fan-out is acceptable.
  const enriched = await Promise.all(
    allUsers.map(async (u) => {
      const [companyMemberships, workspaceMemberships] = await Promise.all([
        fetchCompanyMembershipsForUser(u.userId, ctx.logger),
        fetchWorkspaceMembershipsForUser(u.userId, ctx.logger),
      ]);
      return { user: u, companyMemberships, workspaceMemberships };
    }),
  );

  const users: AdminUserView[] = enriched.map(
    ({ user: u, companyMemberships, workspaceMemberships }) => {
      let status: "active" | "pending" | "inactive";
      if (u.status === "active") {
        status = "active";
      } else if (u.status === "invited") {
        status = "pending";
      } else {
        status = "inactive";
      }

      return {
        userId: u.userId,
        displayName: u.displayName,
        email: u.email,
        handle: null,
        title: null,
        phone: u.phoneE164,
        lastActiveAt: null,
        status,
        assignedCompanies: companyMemberships.map((m, idx) => ({
          companyId: m.companyId,
          name: m.name,
          role: m.role,
          isPrimary: idx === 0,
        })),
        assignedWorkspaces: workspaceMemberships.map((m) => ({
          workspaceId: m.workspaceId,
          name: m.name,
          companyId: m.companyId,
          role: m.role,
        })),
      };
    },
  );

  return { users, total: users.length };
}
