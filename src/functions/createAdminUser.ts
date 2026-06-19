/**
 * createAdminUser — operator creates a user cross-tenant, bypassing the
 * normal invite flow.
 *
 * Two modes:
 *   "invite"  — creates a pending_invite record (same as inviteUser but
 *               the operator can target any companyId regardless of their
 *               own company context). Emits users.invited.
 *   "draft"   — creates an active user record immediately with no invite
 *               email. Useful for seeding / migration. Assigns memberships
 *               directly.
 *
 * The phone field must be E.164 ("+1…"). The synthetic email pattern is the
 * same as verifyOtp: phone+<E164>@users.freshify.io when no email is given.
 *
 * Operator-only. Caller must have ctx.identity.operator set.
 */
import { randomBytes } from "node:crypto";
import type { Db } from "mongodb";
import type { Logger } from "pino";
import { z } from "zod";
import { collections } from "../mongo";
import { newId } from "../identity";
import type { IdentityContext } from "../vendor/authz";
import type { Publisher } from "../events/publisher";
import { systemIdentity } from "../events/publisher";
import {
  upsertCompanyMembership,
  upsertWorkspaceMembership,
} from "../internalClients";

// ─── Input / Output schemas ───────────────────────────────────────────────

export const CreateAdminUserInput = z.object({
  mode: z.enum(["invite", "draft"]),
  firstName: z.string().min(1).max(60),
  lastName: z.string().min(1).max(60),
  /** E.164 phone, optional if email is provided. */
  phone: z.string().regex(/^\+[1-9]\d{7,14}$/).optional(),
  /** Email address. Required for mode=invite. */
  email: z.string().email().optional(),
  /** Optional display title (job title / role label). */
  title: z.string().max(120).optional(),
  /** If given, immediately assign membership in this company (draft only). */
  companyId: z.string().optional(),
  /** Role in the company. Defaults to member. */
  companyRole: z.enum(["admin", "member"]).default("member"),
  /** Workspace IDs to assign the user to (draft only, requires companyId). */
  workspaceIds: z.array(z.string()).optional(),
}).refine(
  (d) => d.email !== undefined || d.phone !== undefined,
  { message: "At least one of email or phone is required" },
).refine(
  (d) => d.mode !== "invite" || d.email !== undefined,
  { message: "email is required for mode=invite" },
).refine(
  (d) => d.mode !== "invite" || d.companyId !== undefined,
  { message: "companyId is required for mode=invite" },
);
export type CreateAdminUserInput = z.infer<typeof CreateAdminUserInput>;

export interface CreateAdminUserOutput {
  userId: string;
  email: string;
  displayName: string;
  mode: "invite" | "draft";
  /** Populated when mode=invite */
  inviteId?: string;
  /** Populated when mode=invite */
  inviteToken?: string;
  companyId?: string;
  workspaceIds?: string[];
}

const INVITE_TTL_SEC = 60 * 60 * 24 * 7; // 7 days

// ─── Handler ─────────────────────────────────────────────────────────────

export async function createAdminUser(
  rawInput: unknown,
  ctx: {
    db: Db;
    logger: Logger;
    identity: IdentityContext;
    publisher: Publisher;
  },
): Promise<CreateAdminUserOutput> {
  // Guard: operator-only
  if (!ctx.identity.operator) {
    const err = new Error("operator_required");
    (err as Error & { status?: number }).status = 403;
    throw err;
  }

  const input = CreateAdminUserInput.parse(rawInput);

  const displayName = `${input.firstName} ${input.lastName}`.trim();
  const email = input.email
    ? input.email.toLowerCase()
    : `phone+${(input.phone ?? "").replace(/[^0-9+]/g, "")}@users.freshify.io`;

  const now = new Date();

  // ── mode=invite ───────────────────────────────────────────────────────────
  if (input.mode === "invite") {
    const companyId = input.companyId!; // validated above

    // Check for duplicate pending invite
    const existingInvite = await collections.invites(ctx.db).findOne({
      email,
      companyId,
      status: "pending",
    });
    if (existingInvite) {
      const err = new Error("invite_already_pending");
      (err as Error & { status?: number }).status = 409;
      throw err;
    }

    // Check if already a member
    const existingUser = await collections.users(ctx.db).findOne({ email });
    if (existingUser) {
      const existingMembership = await collections
        .memberships(ctx.db)
        .findOne({ userId: existingUser.userId, companyId });
      if (existingMembership) {
        const err = new Error("user_already_member");
        (err as Error & { status?: number }).status = 409;
        throw err;
      }
    }

    const inviteId = newId("inv");
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(now.getTime() + INVITE_TTL_SEC * 1000);

    await collections.invites(ctx.db).insertOne({
      inviteId,
      token,
      email,
      companyId,
      role: input.companyRole,
      invitedBy: ctx.identity.user.userId,
      createdAt: now,
      expiresAt,
      status: "pending",
    });

    await ctx.publisher.emit({
      name: "users.invited",
      payload: {
        inviteId,
        email,
        companyId,
        role: input.companyRole,
        invitedBy: ctx.identity.user.userId,
        expiresAt: expiresAt.toISOString(),
      },
      identity: ctx.identity,
    });

    ctx.logger.info(
      {
        inviteId,
        email,
        companyId,
        role: input.companyRole,
        operatorId: ctx.identity.operator.operatorId,
      },
      "operator_created_invite",
    );

    // Deploy 5.1 — portal audit (best-effort).
    try {
      await collections.portalAuditLog(ctx.db).insertOne({
        at: new Date(),
        actorUserId: ctx.identity.user.userId,
        event: "portal.admin_user_created",
        payload: {
          mode: "invite",
          inviteId,
          email,
          companyId,
          role: input.companyRole,
        },
      });
    } catch (err) {
      ctx.logger.warn({ err }, "portal_audit_log insert failed");
    }

    return {
      userId: existingUser?.userId ?? "",
      email,
      displayName,
      mode: "invite",
      inviteId,
      inviteToken: token,
      companyId,
    };
  }

  // ── mode=draft ────────────────────────────────────────────────────────────
  // Find or create the user record directly (no invite flow).
  const usersCol = collections.users(ctx.db);
  let userId: string;
  const existingUser = await usersCol.findOne({ email });

  if (existingUser) {
    userId = existingUser.userId;
    // Update displayName if not already set
    if (!existingUser.displayName) {
      await usersCol.updateOne(
        { userId },
        { $set: { displayName, updatedAt: now } },
      );
    }
    ctx.logger.info(
      { userId, email, operatorId: ctx.identity.operator.operatorId },
      "operator_draft_user_found_existing",
    );
  } else {
    userId = newId("usr");
    const phoneE164 = input.phone ?? null;
    await usersCol.insertOne({
      userId,
      email,
      displayName,
      phoneE164,
      createdAt: now,
      updatedAt: now,
      status: "active",
    });

    await ctx.publisher.emit({
      name: "users.created",
      payload: {
        userId,
        email,
        displayName,
        via: "invite" as const, // closest semantic — no OTP was used
        createdAt: now.toISOString(),
      },
      identity: systemIdentity(),
    });

    ctx.logger.info(
      { userId, email, operatorId: ctx.identity.operator.operatorId },
      "operator_draft_user_created",
    );
  }

  // Assign to company if provided.
  //
  // Sovereign architecture: Companies BE owns company memberships; Workspaces BE
  // owns workspace memberships. We make S2S calls to each. We also keep a local
  // mirror in Users DB so legacy reads (and the bootstrap path) don't regress.
  const assignedWorkspaceIds: string[] = [];
  if (input.companyId) {
    const membershipsCol = collections.memberships(ctx.db);
    const existingMembership = await membershipsCol.findOne({
      userId,
      companyId: input.companyId,
    });
    if (!existingMembership) {
      await membershipsCol.insertOne({
        userId,
        companyId: input.companyId,
        role: input.companyRole,
        createdAt: now,
      });
      ctx.logger.info(
        { userId, companyId: input.companyId, role: input.companyRole },
        "operator_draft_membership_assigned_local",
      );
    }

    // S2S → Companies BE: persist the membership in the canonical store.
    const okCompany = await upsertCompanyMembership(
      { userId, companyId: input.companyId, role: input.companyRole },
      ctx.logger,
    );
    ctx.logger.info(
      { userId, companyId: input.companyId, ok: okCompany },
      "operator_draft_membership_assigned_companies_s2s",
    );

    // S2S → Workspaces BE: persist each requested workspace membership.
    if (input.workspaceIds?.length) {
      for (const workspaceId of input.workspaceIds) {
        const okWs = await upsertWorkspaceMembership(
          {
            userId,
            workspaceId,
            companyId: input.companyId,
            role: input.companyRole,
          },
          ctx.logger,
        );
        if (okWs) {
          assignedWorkspaceIds.push(workspaceId);
        }
        ctx.logger.info(
          { userId, workspaceId, ok: okWs },
          "operator_draft_workspace_assigned_workspaces_s2s",
        );
      }
    }
  }

  // Deploy 5.1 — portal audit (best-effort).
  try {
    await collections.portalAuditLog(ctx.db).insertOne({
      at: new Date(),
      actorUserId: ctx.identity.user.userId,
      event: "portal.admin_user_created",
      payload: {
        mode: "draft",
        userId,
        email,
        companyId: input.companyId,
        companyRole: input.companyRole,
        workspaceIds: assignedWorkspaceIds,
      },
    });
  } catch (err) {
    ctx.logger.warn({ err }, "portal_audit_log insert failed");
  }

  return {
    userId,
    email,
    displayName,
    mode: "draft",
    companyId: input.companyId,
    workspaceIds: assignedWorkspaceIds.length ? assignedWorkspaceIds : undefined,
  };
}
