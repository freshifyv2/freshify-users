/**
 * getAdminUser — fetch a single user by userId for a Freshify operator.
 *
 * Operator-only. Returns the same AdminUserView shape as listAllUsers so the
 * FE can use the same renderer for both the list row and the detail panel.
 *
 * Cross-service enrichment: company and workspace memberships are resolved
 * via S2S calls to the Companies and Workspaces BEs (see internalClients).
 * Failures degrade gracefully to empty arrays — the page never crashes
 * because of a sibling outage.
 */
import type { Db } from "mongodb";
import type { Logger } from "pino";
import type { IdentityContext } from "../vendor/authz";
import { collections } from "../mongo";
import type { AdminUserView } from "./listAllUsers";
import {
  fetchCompanyMembershipsForUser,
  fetchWorkspaceMembershipsForUser,
} from "../internalClients";

export interface GetAdminUserInput {
  userId: string;
}

export interface GetAdminUserOutput {
  user: AdminUserView;
}

export async function getAdminUser(
  input: GetAdminUserInput,
  ctx: {
    db: Db;
    logger: Logger;
    identity: IdentityContext;
  },
): Promise<GetAdminUserOutput> {
  // Guard: operator-only
  if (!ctx.identity.operator) {
    const err = new Error("operator_required");
    (err as Error & { status?: number }).status = 403;
    throw err;
  }

  // Fetch user — no company scope, cross-tenant read
  const userDoc = await collections.users(ctx.db).findOne({ userId: input.userId });
  if (!userDoc) {
    const err = new Error("user_not_found");
    (err as Error & { status?: number }).status = 404;
    throw err;
  }

  // Resolve memberships from sibling services in parallel
  const [companyMemberships, workspaceMemberships] = await Promise.all([
    fetchCompanyMembershipsForUser(input.userId, ctx.logger),
    fetchWorkspaceMembershipsForUser(input.userId, ctx.logger),
  ]);

  // Map UserDoc.status → AdminUserView.status
  let status: AdminUserView["status"];
  if (userDoc.status === "active") {
    status = "active";
  } else if (userDoc.status === "invited") {
    status = "pending";
  } else {
    status = "inactive";
  }

  const user: AdminUserView = {
    userId: userDoc.userId,
    displayName: userDoc.displayName,
    email: userDoc.email,
    handle: userDoc.username ?? null,
    title: userDoc.title ?? null,
    phone: userDoc.phoneE164,
    lastActiveAt: userDoc.lastActivityAt ? userDoc.lastActivityAt.toISOString() : null,
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

  return { user };
}
