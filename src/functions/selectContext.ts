/**
 * selectContext — switch the active company/workspace on a session.
 *
 * Takes a Bearer-authenticated request and a body of
 *   { companyId, companyName?, workspaceId?, workspaceName? }
 * Verifies the caller is a member of the given company, then re-issues a JWT
 * with companyId/companyName (and optionally workspaceId/workspaceName)
 * populated. Workspace membership is NOT verified here — workspaces is a
 * separate sovereign module and owns its own membership check.
 *
 * Returns the same shape as /v1/otp/verify so the FE can reuse its token-
 * swap path: { userId, isNewUser:false, sessionToken, expiresAt }.
 */
import type { Db } from "mongodb";
import type { Logger } from "pino";
import { z } from "zod";
import type { IdentityContext, RoleAssignment } from "../vendor/authz";
import { collections } from "../mongo";
import { issueSessionToken, newId } from "../identity";
import { getOperatorAssignment } from "../operators";

const COMPANIES_URL =
  process.env.COMPANIES_SERVICE_URL ||
  "https://freshify-companies-sbzaekoo4q-uc.a.run.app";

export const SelectContextInput = z.object({
  companyId: z.string().min(1),
  companyName: z.string().min(1).max(200).optional(),
  workspaceId: z.string().min(1).optional(),
  workspaceName: z.string().min(1).max(200).optional(),
});

export const SelectContextOutput = z.object({
  userId: z.string(),
  isNewUser: z.literal(false),
  sessionToken: z.string(),
  expiresAt: z.string(),
});

export type SelectContextInput = z.infer<typeof SelectContextInput>;
export type SelectContextOutput = z.infer<typeof SelectContextOutput>;

export async function selectContext(
  rawInput: unknown,
  ctx: {
    db: Db;
    logger: Logger;
    identity: IdentityContext;
    bearerToken: string;
  },
): Promise<SelectContextOutput> {
  const input = SelectContextInput.parse(rawInput);
  const userId = ctx.identity.user.userId;

  // Look up the caller's role in the requested company by asking the
  // Companies module — it owns the source of truth for company membership.
  // We forward the caller's Bearer token so Companies can authenticate.
  // If the user is not a member, Companies returns an empty list and we
  // refuse the select. This is a one-hop interservice call on a low-frequency
  // endpoint (only fires when a user switches active company).
  let role: "admin" | "member" | null = null;
  let resolvedCompanyName: string | null = input.companyName ?? null;
  try {
    const res = await fetch(`${COMPANIES_URL}/v1/companies`, {
      headers: { authorization: `Bearer ${ctx.bearerToken}` },
    });
    if (res.ok) {
      const json = (await res.json()) as {
        companies: Array<{ companyId: string; name: string; role: string }>;
      };
      const row = json.companies?.find((c) => c.companyId === input.companyId);
      if (row) {
        role = (row.role === "admin" ? "admin" : "member");
        if (!resolvedCompanyName) resolvedCompanyName = row.name;
      }
    }
  } catch (err) {
    ctx.logger.warn({ err }, "companies_lookup_failed_during_select");
  }

  if (!role) {
    const err = new Error("not_a_member_of_company");
    (err as Error & { status?: number }).status = 403;
    throw err;
  }

  const newRoles: RoleAssignment[] = [
    ...ctx.identity.roles.filter(
      (r) => !(r.layer === "company" && r.scope === input.companyId),
    ),
    {
      layer: "company",
      scope: input.companyId,
      role,
    },
  ];

  // Re-check operator assignment so the operator claim stays fresh on
  // every context switch (honours revocations between logins).
  const operatorAssignment = await getOperatorAssignment(ctx.db, userId);
  const operatorClaim = operatorAssignment
    ? { operatorId: userId, reason: operatorAssignment.reason }
    : (ctx.identity.operator ?? null);

  // Re-issue session token with the selected context + role.
  const session = issueSessionToken({
    userId,
    email: ctx.identity.user.email,
    displayName: ctx.identity.user.displayName,
    companyId: input.companyId,
    companyName: resolvedCompanyName,
    workspaceId: input.workspaceId ?? null,
    workspaceName: input.workspaceName ?? null,
    roles: newRoles,
    operator: operatorClaim,
  });

  // Record the new auth session row alongside the old one (don't revoke the
  // old token — the FE may still have it in flight). Sessions expire by TTL.
  const sessionId = newId("ses");
  const now = new Date();
  await collections.sessions(ctx.db).insertOne({
    sessionId,
    userId,
    tokenHash: session.tokenHash,
    issuedAt: now,
    expiresAt: session.expiresAt,
    ip: null,
    userAgent: null,
  });

  ctx.logger.info(
    {
      userId,
      companyId: input.companyId,
      workspaceId: input.workspaceId ?? null,
      sessionId,
    },
    "context_selected",
  );

  return SelectContextOutput.parse({
    userId,
    isNewUser: false,
    sessionToken: session.token,
    expiresAt: session.expiresAt.toISOString(),
  });
}
