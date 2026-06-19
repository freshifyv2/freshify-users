/**
 * Users module HTTP server.
 *
 * Thin Express adapter that:
 *   - surfaces the ModuleDescriptor at GET / (SMI v0.1 convention)
 *   - exposes health probes at /healthz and /readyz
 *   - dispatches the 6 module functions to handlers in src/functions/*
 *
 * Identity middleware runs on every protected route and sets req.identity.
 */
import express, { type Request, type Response } from "express";
import pinoHttp from "pino-http";
import pino from "pino";
import { ZodError } from "zod";

import descriptor from "./module";
import { getDb, getCompaniesDb, getWorkspacesDb } from "./mongo";
import {
  defaultCatalogs,
  normalizeCompanyRole,
  normalizeWorkspaceRole,
} from "./roleCatalogs";
import { identityMiddleware, requireUser, requireOperator } from "./identity";
import { getAuthAdapter, getPasswordAdapter } from "./auth";
import { peekConsoleCode } from "./auth/console";
import { createPublisher } from "./events/publisher";

import { requestOtp } from "./functions/requestOtp";
import { verifyOtp } from "./functions/verifyOtp";
// Sprint 1 — auth functions
import { register } from "./functions/register";
import { verifyEmail } from "./functions/verifyEmail";
import { login } from "./functions/login";
import { requestPasswordReset } from "./functions/requestPasswordReset";
import { resetPassword } from "./functions/resetPassword";
import { selectContext } from "./functions/selectContext";
import { inviteUser } from "./functions/inviteUser";
import { acceptInvite } from "./functions/acceptInvite";
import { listUsers } from "./functions/listUsers";
import { getUser } from "./functions/getUser";
import { listAllUsers } from "./functions/listAllUsers";
import { getAdminUser } from "./functions/getAdminUser";
import { createAdminUser } from "./functions/createAdminUser";
import { updateAdminUser } from "./functions/updateAdminUser";
import { deleteAdminUser } from "./functions/deleteAdminUser";

// Deploy 3 — Portal v3 additions
import { getPortalSettings } from "./functions/getPortalSettings";
import { updatePortalSettings } from "./functions/updatePortalSettings";
import { createInviteV3 } from "./functions/createInviteV3";
import { getInviteV3 } from "./functions/getInviteV3";
import { acceptInviteV3 } from "./functions/acceptInviteV3";
import { listInvitesV3 } from "./functions/listInvitesV3";
import { revokeInviteV3 } from "./functions/revokeInviteV3";
import { revokeInvitesBatchV3 } from "./functions/revokeInvitesBatchV3";
import { resendInviteV3 } from "./functions/resendInviteV3";
import { sendInviteEmail } from "./functions/sendInviteEmail";
// Deploy 5.13 — operator-only repair endpoints for accepted-but-missing
// or accepted-but-failed membership rows. See backfillMembership.ts.
import { backfillMembership } from "./functions/backfillMembership";
import { backfillMembershipsBatch } from "./functions/backfillMembershipsBatch";
import { getUsersStats } from "./functions/getUsersStats";
import { migrateSchemaV3 } from "./functions/migrateSchemaV3";

// Deploy 5 — portal-wide audit feed
import { getPortalAuditFeed } from "./functions/getPortalAuditFeed";

// Sprint 4 — Module Registry Settings (Phase B) + getModuleInfo
import { getModuleSettings } from "./functions/getModuleSettings";
import { updateModuleSettings } from "./functions/updateModuleSettings";
import { listModuleAdmins } from "./functions/listModuleAdmins";
import { addModuleAdmin } from "./functions/addModuleAdmin";
import { removeModuleAdmin } from "./functions/removeModuleAdmin";
import { getModuleInfo } from "./functions/getModuleInfo";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "freshify-users", version: descriptor.version },
});
const publisher = createPublisher(logger);
const adapter = getAuthAdapter(logger);
const passwordAdapter = getPasswordAdapter(logger);

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));
app.use(pinoHttp({ logger }));
app.use(identityMiddleware());

// SMI convention: descriptor summary at root
app.get("/", (_req, res) => {
  res.json({
    smi: {
      version: "0.1",
      module: {
        name: descriptor.name,
        version: descriptor.version,
        scope: descriptor.scope,
        functions: Object.keys(descriptor.api.functions),
        events: {
          publishes: descriptor.events.publishes.map((e) => e.name),
          subscribes: descriptor.events.subscribes.map((s) => s.name),
        },
        schemas: descriptor.schemas.map((s) => s.name),
      },
    },
  });
});

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

app.get("/readyz", async (_req, res) => {
  try {
    await getDb(logger);
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "readyz failed");
    res.status(503).json({ ok: false, error: (err as Error).message });
  }
});

// ─── Error wrapper ────────────────────────────────────────────────────────
// Slice 5.18g.1 — map ZodError → clean 400 invalid_input instead of letting
// the raw zod issue array stringify into a 500. Anonymous endpoints (verify,
// register, reset) are the primary source of malformed input; without this
// any short or missing token returns a 500 with a JSON-of-array-of-issues.
function wrap(
  handler: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response) => void {
  return (req, res) => {
    handler(req, res).catch((err: Error & { status?: number }) => {
      if (err instanceof ZodError) {
        req.log?.warn(
          { issues: err.issues, path: req.path },
          "invalid_input",
        );
        if (!res.headersSent) {
          res.status(400).json({
            error: "invalid_input",
            issues: err.issues.map((i) => ({
              path: i.path.join("."),
              code: i.code,
              message: i.message,
            })),
          });
        }
        return;
      }
      const status = err.status ?? 500;
      req.log?.error({ err, path: req.path }, "handler failed");
      if (!res.headersSent) {
        res.status(status).json({ error: err.message });
      }
    });
  };
}

// ─── DEV ONLY: peek-otp ───────────────────────────────────────────────────
// Gated on DEV_OTP_PEEK=1 AND console adapter (no Twilio). Refuses otherwise.
// Used by automated smoke tests when SMS is not wired. NEVER enable when
// Twilio is configured — and the code itself enforces both gates.
app.get(
  "/v1/dev/peek-otp",
  wrap(async (req, res) => {
    if (process.env.DEV_OTP_PEEK !== "1") {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (
      process.env.TWILIO_ACCOUNT_SID ||
      process.env.TWILIO_AUTH_TOKEN ||
      process.env.TWILIO_VERIFY_SERVICE_SID
    ) {
      res.status(403).json({ error: "twilio_configured_peek_disabled" });
      return;
    }
    const identifier = String(req.query.identifier ?? "");
    const channel = String(req.query.channel ?? "sms");
    if (!identifier) {
      res.status(400).json({ error: "identifier required" });
      return;
    }
    const entry = peekConsoleCode(identifier, channel);
    if (!entry) {
      res.status(404).json({ error: "no_pending_code" });
      return;
    }
    res.json({ code: entry.code, expiresAt: new Date(entry.expiresAt).toISOString() });
  }),
);

// ─── Anonymous routes (no auth) ───────────────────────────────────────────
app.post(
  "/v1/otp/request",
  wrap(async (req, res) => {
    const db = await getDb(logger);
    const out = await requestOtp(req.body, { db, logger, adapter });
    res.json(out);
  }),
);

app.post(
  "/v1/otp/verify",
  wrap(async (req, res) => {
    const db = await getDb(logger);
    const out = await verifyOtp(req.body, { db, logger, adapter, publisher });
    res.json(out);
  }),
);

// ─── the auth spec — password + email-verification flow ───────────────
app.post(
  "/v1/auth/register",
  wrap(async (req, res) => {
    const db = await getDb(logger);
    const out = await register(req.body, {
      db,
      logger,
      passwordAdapter,
      publisher,
    });
    res.json(out);
  }),
);

app.post(
  "/v1/auth/verify-email",
  wrap(async (req, res) => {
    const db = await getDb(logger);
    const out = await verifyEmail(req.body, { db, logger, publisher });
    res.json(out);
  }),
);

app.post(
  "/v1/auth/login",
  wrap(async (req, res) => {
    const db = await getDb(logger);
    const out = await login(req.body, {
      db,
      logger,
      passwordAdapter,
      publisher,
    });
    res.json(out);
  }),
);

app.post(
  "/v1/auth/password-reset/request",
  wrap(async (req, res) => {
    const db = await getDb(logger);
    const out = await requestPasswordReset(req.body, { db, logger });
    res.json(out);
  }),
);

app.post(
  "/v1/auth/password-reset/consume",
  wrap(async (req, res) => {
    const db = await getDb(logger);
    const out = await resetPassword(req.body, {
      db,
      logger,
      passwordAdapter,
      publisher,
    });
    res.json(out);
  }),
);

app.post(
  "/v1/invites/accept",
  wrap(async (req, res) => {
    const db = await getDb(logger);
    const out = await acceptInvite(req.body, { db, logger, publisher });
    res.json(out);
  }),
);

// ─── Authenticated routes ─────────────────────────────────────────────────
app.post(
  "/v1/session/select",
  requireUser(),
  wrap(async (req, res) => {
    const db = await getDb(logger);
    const auth = req.header("authorization") ?? "";
    const bearerToken = auth.replace(/^Bearer\s+/i, "");
    const out = await selectContext(req.body, {
      db,
      logger,
      identity: req.identity!,
      bearerToken,
    });
    res.json(out);
  }),
);

app.post(
  "/v1/invites",
  requireUser(),
  wrap(async (req, res) => {
    const db = await getDb(logger);
    const out = await inviteUser(req.body, {
      db,
      logger,
      identity: req.identity!,
      publisher,
    });
    res.json(out);
  }),
);

app.get(
  "/v1/users",
  requireUser(),
  wrap(async (req, res) => {
    const db = await getDb(logger);
    const out = await listUsers(
      {
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        cursor: req.query.cursor ?? null,
      },
      { db, identity: req.identity! },
    );
    res.json(out);
  }),
);

app.get(
  "/v1/users/:userId",
  requireUser(),
  wrap(async (req, res) => {
    const db = await getDb(logger);
    const out = await getUser(
      { userId: req.params.userId },
      { db, identity: req.identity! },
    );
    res.json(out);
  }),
);

// ─── Operator-only routes ──────────────────────────────────────────────────
// Self-service: current user's memberships (for account page)
app.get(
  "/v1/me/memberships",
  requireUser(),
  wrap(async (req, res) => {
    const userId = req.identity!.user.userId;
    const { fetchCompanyMembershipsForUser, fetchWorkspaceMembershipsForUser } =
      await import("./internalClients");
    const [companies, workspaces] = await Promise.all([
      fetchCompanyMembershipsForUser(userId, logger),
      fetchWorkspaceMembershipsForUser(userId, logger),
    ]);
    res.json({ companies, workspaces });
  }),
);

app.get(
  "/v1/admin/users",
  requireUser(),
  requireOperator(),
  wrap(async (req, res) => {
    const db = await getDb(logger);
    const auth = req.header("authorization") ?? "";
    const bearerToken = auth.replace(/^Bearer\s+/i, "");
    void bearerToken;
    const out = await listAllUsers({
      db,
      logger,
      identity: req.identity!,
    });
    res.json(out);
  }),
);

app.post(
  "/v1/admin/users",
  requireUser(),
  requireOperator(),
  wrap(async (req, res) => {
    const db = await getDb(logger);
    const out = await createAdminUser(req.body, {
      db,
      logger,
      identity: req.identity!,
      publisher,
    });
    res.status(201).json(out);
  }),
);

app.get(
  "/v1/admin/users/:userId",
  requireUser(),
  requireOperator(),
  wrap(async (req, res) => {
    const db = await getDb(logger);
    const out = await getAdminUser(
      { userId: req.params.userId },
      { db, logger, identity: req.identity! },
    );
    res.json(out);
  }),
);

app.patch(
  "/v1/admin/users/:userId",
  requireUser(),
  requireOperator(),
  wrap(async (req, res) => {
    const db = await getDb(logger);
    const out = await updateAdminUser(req.params.userId, req.body, {
      db,
      logger,
      identity: req.identity!,
    });
    res.json(out);
  }),
);

app.delete(
  "/v1/admin/users/:userId",
  requireUser(),
  requireOperator(),
  wrap(async (req, res) => {
    const db = await getDb(logger);
    const out = await deleteAdminUser(
      { userId: req.params.userId },
      { db, logger, identity: req.identity! },
    );
    res.json(out);
  }),
);

// ─── Role catalogs — read-only access for the Role Settings UI ────────────
// Any authenticated user can read the catalogs (they describe the role
// model, not sensitive data). Returns the latest version per scope.
app.get(
  "/v1/role-catalogs/:scope",
  requireUser(),
  wrap(async (req, res) => {
    const scope = req.params.scope;
    if (scope !== "company" && scope !== "workspace" && scope !== "module") {
      res.status(400).json({ error: "invalid_scope" });
      return;
    }
    const usersDb = await getDb(logger);
    const catalogsCol = usersDb.collection("role_catalogs");
    const moduleKey = req.query.moduleKey
      ? String(req.query.moduleKey)
      : null;
    // Latest version for the given (scope, moduleKey).
    const docs = await catalogsCol
      .find({ scope, moduleKey })
      .sort({ version: -1 })
      .limit(1)
      .toArray();
    const doc = docs[0];
    if (!doc) {
      res.status(404).json({ error: "catalog_not_found" });
      return;
    }
    res.json({
      catalogId: doc.catalogId,
      scope: doc.scope,
      moduleKey: doc.moduleKey,
      version: doc.version,
      roles: doc.roles,
      updatedAt: doc.updatedAt instanceof Date
        ? doc.updatedAt.toISOString()
        : doc.updatedAt,
    });
  }),
);

// ─── Bootstrap: seed first operator (dev/staging only) ───────────────────
// Gated by INTERNAL_S2S_SECRET (header x-internal-secret OR body.secret).
// Falls back to DEV_OTP_BYPASS=1 + bypass code when INTERNAL_S2S_SECRET is
// unset (developer convenience). Production: set INTERNAL_S2S_SECRET and
// leave DEV_OTP_BYPASS unset.
//
// Two call modes:
//   Legacy: { userId, reason, secret } — assigns operator to existing userId
//   Bootstrap: { phone, email, firstName, lastName, companyId, workspaceIds, secret }
//              — upserts user by phone, assigns operator, adds memberships
//
// Remove this route before production hardening.
app.post(
  "/v1/internal/seed-operator",
  wrap(async (req, res) => {
    const internalSecret = process.env.INTERNAL_S2S_SECRET;
    const headerSecret = req.header("x-internal-secret");

    // Path A: INTERNAL_S2S_SECRET configured — require header match.
    if (internalSecret) {
      if (headerSecret !== internalSecret) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }
    } else {
      // Path B (legacy/dev): allow if DEV_OTP_BYPASS=1 and no Twilio is wired.
      const bypassEnabled =
        process.env.DEV_OTP_BYPASS === "1" &&
        !process.env.TWILIO_ACCOUNT_SID &&
        !process.env.TWILIO_VERIFY_SERVICE_SID;
      if (!bypassEnabled) {
        res.status(404).json({ error: "not_found" });
        return;
      }
    }
    const bypassCode = process.env.DEV_OTP_BYPASS_CODE || "424242";

    const body = req.body as {
      // Bootstrap mode fields
      phone?: string;
      email?: string;
      firstName?: string;
      lastName?: string;
      companyId?: string;
      workspaceIds?: string[];
      // Legacy mode fields
      userId?: string;
      reason?: string;
      secret?: string;
    };

    // Path B (legacy): also require body.secret match when no header secret.
    if (!internalSecret && body.secret !== bypassCode) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    const db = await getDb(logger);
    const { upsertOperatorAssignment } = await import("./operators");
    const { newId } = await import("./identity");

    // ── Bootstrap mode: full upsert by phone ────────────────────────────────
    if (body.phone) {
      const { phone, email, firstName, lastName, companyId, workspaceIds } = body;

      if (!phone || !firstName || !lastName) {
        res.status(400).json({ error: "phone, firstName, lastName required for bootstrap mode" });
        return;
      }

      const displayName = `${firstName} ${lastName}`.trim();
      const resolvedEmail = email
        ? email.toLowerCase()
        : `phone+${phone.replace(/[^0-9+]/g, "")}@users.freshify.io`;

      const now = new Date();
      const usersCol = db.collection<{
        userId: string;
        email: string;
        displayName: string | null;
        phoneE164: string | null;
        createdAt: Date;
        updatedAt: Date;
        status: string;
      }>("users");

      // Upsert by phone (primary) or email
      let userDoc = await usersCol.findOne({ phoneE164: phone });
      if (!userDoc) {
        userDoc = await usersCol.findOne({ email: resolvedEmail });
      }

      let userId: string;
      if (userDoc) {
        userId = userDoc.userId;
        await usersCol.updateOne(
          { userId },
          {
            $set: {
              displayName,
              email: resolvedEmail,
              phoneE164: phone,
              status: "active",
              updatedAt: now,
            },
          },
        );
        logger.info({ userId }, "seed_operator_bootstrap_updated_existing_user");
      } else {
        userId = newId("usr");
        await usersCol.insertOne({
          userId,
          email: resolvedEmail,
          displayName,
          phoneE164: phone,
          createdAt: now,
          updatedAt: now,
          status: "active",
        });
        logger.info({ userId }, "seed_operator_bootstrap_created_user");
      }

      // Upsert operator assignment
      await upsertOperatorAssignment(db, userId, "audit");
      logger.info({ userId }, "seed_operator_bootstrap_operator_assigned");

      // Upsert company membership in local users DB
      const assignedWorkspaceIds: string[] = [];
      if (companyId) {
        const membershipsCol = db.collection<{
          userId: string;
          companyId: string;
          role: string;
          createdAt: Date;
        }>("user_company_memberships");
        const existingMem = await membershipsCol.findOne({ userId, companyId });
        if (!existingMem) {
          await membershipsCol.insertOne({
            userId,
            companyId,
            role: "member",
            createdAt: now,
          });
          logger.info({ userId, companyId }, "seed_operator_bootstrap_company_membership_created");
        } else {
          logger.info({ userId, companyId }, "seed_operator_bootstrap_company_membership_exists");
        }

        // Best-effort: call Companies BE
        const companiesUrl =
          process.env.COMPANIES_SERVICE_URL ||
          "https://freshify-companies-sbzaekoo4q-uc.a.run.app";
        try {
          await fetch(`${companiesUrl}/v1/internal/memberships`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(process.env.INTERNAL_S2S_SECRET
                ? { "x-internal-secret": process.env.INTERNAL_S2S_SECRET }
                : {}),
            },
            body: JSON.stringify({ userId, companyId, role: "member" }),
          });
        } catch (e) {
          logger.warn({ err: e }, "seed_operator_bootstrap_companies_be_failed_best_effort");
        }

        // Best-effort: call Workspaces BE for each workspace
        if (workspaceIds?.length) {
          const workspacesUrl =
            process.env.WORKSPACES_SERVICE_URL ||
            "https://freshify-workspaces-sbzaekoo4q-uc.a.run.app";
          for (const workspaceId of workspaceIds) {
            try {
              await fetch(`${workspacesUrl}/v1/internal/memberships`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  ...(process.env.INTERNAL_S2S_SECRET
                    ? { "x-internal-secret": process.env.INTERNAL_S2S_SECRET }
                    : {}),
                },
                body: JSON.stringify({ userId, workspaceId, companyId, role: "member" }),
              });
              assignedWorkspaceIds.push(workspaceId);
            } catch (e) {
              logger.warn({ err: e, workspaceId }, "seed_operator_bootstrap_workspaces_be_failed_best_effort");
            }
          }
        }
      }

      logger.info({ userId, displayName, companyId, workspaceIds }, "seed_operator_bootstrap_complete");
      res.json({
        ok: true,
        userId,
        displayName,
        email: resolvedEmail,
        reason: "audit",
        companyId: companyId ?? null,
        workspaceIds: assignedWorkspaceIds,
      });
      return;
    }

    // ── Legacy mode: assign operator to existing userId ──────────────────────
    const { userId, reason } = body;
    if (!userId || !reason) {
      res.status(400).json({ error: "userId and reason required (or use phone for bootstrap mode)" });
      return;
    }
    const validReasons = ["support", "incident", "audit", "migration", "impersonation"];
    if (!validReasons.includes(reason)) {
      res.status(400).json({ error: "invalid reason", valid: validReasons });
      return;
    }
    await upsertOperatorAssignment(db, userId, reason as import("./vendor/authz").OperatorReason);
    logger.info({ userId, reason }, "seed_operator_assignment");
    res.json({ ok: true, userId, reason });
  }),
);

// ===================================================================
// POST /v1/internal/apply-operator-rename
//
// One-shot idempotent migration that aligns the operator user record
// with the SMI v0.2 cleanup phase:
//
//   1. Rename operator user (usr_c0TsxItsk5LSJv7e) email/displayName/
//      phone to the Alex Morgan operator persona if any field still
//      holds legacy real-person values.
//   2. Backfill operator as 'admin' in freshify_companies.company_admins
//      for the company specified in the request body (default: Sovereign
//      Corp / cmp_llAsevtjc4ki0plW).
//
// Gated by the same INTERNAL_S2S_SECRET as /v1/internal/seed-operator.
// Safe to call multiple times.
// ===================================================================
app.post(
  "/v1/internal/apply-operator-rename",
  wrap(async (req: Request, res: Response) => {
    const internalSecret = process.env.INTERNAL_S2S_SECRET;
    const headerSecret = req.header("x-internal-secret");
    if (internalSecret) {
      if (headerSecret !== internalSecret) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }
    } else {
      const bypassEnabled =
        process.env.DEV_OTP_BYPASS === "1" &&
        !process.env.TWILIO_ACCOUNT_SID &&
        !process.env.TWILIO_VERIFY_SERVICE_SID;
      if (!bypassEnabled) {
        res.status(404).json({ error: "not_found" });
        return;
      }
    }

    const body = (req.body ?? {}) as {
      operatorUserId?: string;
      operatorEmail?: string;
      operatorDisplayName?: string;
      operatorPhone?: string;
      companyId?: string;
    };

    const operatorUserId = body.operatorUserId ?? "usr_c0TsxItsk5LSJv7e";
    const operatorEmail = body.operatorEmail ?? "alex.morgan@sovereign.dev";
    const operatorDisplayName = body.operatorDisplayName ?? "Alex Morgan";
    const operatorPhone = body.operatorPhone ?? "+16085550100";
    const companyId = body.companyId ?? "cmp_llAsevtjc4ki0plW";

    const db = await getDb(logger);
    const companiesDb = await getCompaniesDb(logger);
    const usersCol = db.collection("users");
    const adminsCol = companiesDb.collection("company_admins");

    const summary: Record<string, unknown> = {
      operatorUserId,
      companyId,
      changes: {} as Record<string, unknown>,
    };
    const changes = summary.changes as Record<string, unknown>;

    // ── Step 1: rename operator user record ────────────────────────────────
    const user = await usersCol.findOne({ userId: operatorUserId });
    if (!user) {
      res.status(404).json({ error: "operator_user_not_found", operatorUserId });
      return;
    }

    const updates: Record<string, unknown> = {};
    if (user.email !== operatorEmail) {
      const conflict = await usersCol.findOne({ email: operatorEmail });
      if (conflict && conflict.userId !== operatorUserId) {
        changes.emailSkipped = `${operatorEmail} already taken by ${conflict.userId}`;
      } else {
        updates.email = operatorEmail;
      }
    }
    if (user.displayName !== operatorDisplayName) {
      updates.displayName = operatorDisplayName;
    }
    if (user.phoneE164 !== operatorPhone) {
      updates.phoneE164 = operatorPhone;
    }
    if (Object.keys(updates).length > 0) {
      updates.updatedAt = new Date();
      await usersCol.updateOne({ userId: operatorUserId }, { $set: updates });
      changes.renamed = updates;
    } else {
      changes.renamed = "no-op";
    }

    // ── Step 2: backfill operator as company admin ─────────────────────────
    const existingAdmin = await adminsCol.findOne({
      userId: operatorUserId,
      companyId,
    });
    if (!existingAdmin) {
      await adminsCol.insertOne({
        userId: operatorUserId,
        companyId,
        role: "admin",
        createdAt: new Date(),
        addedBy: "apply-operator-rename",
      });
      changes.companyAdmin = "inserted";
    } else if (existingAdmin.role !== "admin") {
      await adminsCol.updateOne(
        { userId: operatorUserId, companyId },
        { $set: { role: "admin" } },
      );
      changes.companyAdmin = `upgraded_from_${existingAdmin.role}`;
    } else {
      changes.companyAdmin = "already_admin";
    }

    logger.info(summary, "apply_operator_rename");
    res.json({ ok: true, ...summary });
  }),
);

// ===================================================================
// POST /v1/internal/consolidate-users-by-phone
//
// One-shot idempotent migration that merges duplicate user records that
// share a phone number (E.164). The canonical user is the one whose
// userId matches `canonicalUserId` in the body (or, if omitted, the
// oldest user record by createdAt). All other matching duplicates are:
//
//   1. Their auth_sessions reassigned to canonical (so any active token
//      keeps working).
//   2. Their operator_assignments reassigned to canonical, then any
//      duplicate rows are collapsed.
//   3. Their freshify_companies.company_admins rows reassigned to
//      canonical (cross-db), with duplicates collapsed.
//   4. The duplicate user docs are deleted.
//
// Then the canonical user has phoneE164 backfilled (if missing) so future
// phone logins find it by phoneE164 (matches verifyOtp lookup order).
//
// Gated by INTERNAL_S2S_SECRET. Safe to call multiple times.
// ===================================================================
app.post(
  "/v1/internal/consolidate-users-by-phone",
  wrap(async (req: Request, res: Response) => {
    const internalSecret = process.env.INTERNAL_S2S_SECRET;
    const headerSecret = req.header("x-internal-secret");
    if (internalSecret) {
      if (headerSecret !== internalSecret) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }
    } else {
      const bypassEnabled =
        process.env.DEV_OTP_BYPASS === "1" &&
        !process.env.TWILIO_ACCOUNT_SID &&
        !process.env.TWILIO_VERIFY_SERVICE_SID;
      if (!bypassEnabled) {
        res.status(404).json({ error: "not_found" });
        return;
      }
    }

    const body = (req.body ?? {}) as {
      phone?: string;
      canonicalUserId?: string;
      dryRun?: boolean;
    };
    const phone = body.phone;
    if (!phone || !phone.startsWith("+")) {
      res.status(400).json({ error: "phone_required_e164" });
      return;
    }
    const dryRun = body.dryRun === true;

    const db = await getDb(logger);
    const companiesDb = await getCompaniesDb(logger);
    const usersCol = db.collection("users");
    const sessionsCol = db.collection("auth_sessions");
    const opAssignCol = db.collection("operator_assignments");
    const companyAdminsCol = companiesDb.collection("company_admins");

    // Find all candidates: by phoneE164 OR by synthetic phone email.
    const syntheticEmail = `phone+${phone.replace(/[^0-9+]/g, "")}@users.freshify.io`;
    const candidates = await usersCol
      .find({
        $or: [
          { phoneE164: phone },
          { email: syntheticEmail },
        ],
      })
      .toArray();

    if (candidates.length === 0) {
      res.status(404).json({ error: "no_users_for_phone", phone });
      return;
    }

    // Pick canonical: explicit override > caller-preferred > oldest by createdAt.
    let canonical = body.canonicalUserId
      ? candidates.find((u) => u.userId === body.canonicalUserId)
      : undefined;
    if (!canonical) {
      canonical = [...candidates].sort((a, b) => {
        const aT = a.createdAt instanceof Date ? a.createdAt.getTime() : 0;
        const bT = b.createdAt instanceof Date ? b.createdAt.getTime() : 0;
        return aT - bT;
      })[0];
    }
    if (!canonical) {
      res.status(500).json({ error: "canonical_selection_failed" });
      return;
    }

    const duplicates = candidates.filter((u) => u.userId !== canonical!.userId);
    const duplicateIds = duplicates.map((u) => u.userId);

    const summary: Record<string, unknown> = {
      phone,
      canonicalUserId: canonical.userId,
      duplicateUserIds: duplicateIds,
      dryRun,
      changes: {} as Record<string, unknown>,
    };
    const changes = summary.changes as Record<string, unknown>;

    if (dryRun) {
      changes.note = "dryRun=true — no writes performed";
      res.json({ ok: true, ...summary });
      return;
    }

    if (duplicateIds.length === 0) {
      changes.note = "no duplicates — only canonical exists";
    } else {
      // 1. Reassign auth_sessions.
      const sessRes = await sessionsCol.updateMany(
        { userId: { $in: duplicateIds } },
        { $set: { userId: canonical.userId } },
      );
      changes.sessionsReassigned = sessRes.modifiedCount;

      // 2. operator_assignments — reassign, then collapse dupes.
      const opAssignRes = await opAssignCol.updateMany(
        { userId: { $in: duplicateIds } },
        { $set: { userId: canonical.userId } },
      );
      changes.operatorAssignmentsReassigned = opAssignRes.modifiedCount;
      // Collapse: keep the oldest per (userId), delete the rest.
      const allOpAssign = await opAssignCol
        .find({ userId: canonical.userId })
        .sort({ createdAt: 1 })
        .toArray();
      if (allOpAssign.length > 1) {
        const toDelete = allOpAssign.slice(1).map((r) => r._id);
        const delRes = await opAssignCol.deleteMany({ _id: { $in: toDelete } });
        changes.operatorAssignmentsDeduped = delRes.deletedCount;
      }

      // 3. company_admins (cross-db) — reassign, then collapse dupes.
      const caRes = await companyAdminsCol.updateMany(
        { userId: { $in: duplicateIds } },
        { $set: { userId: canonical.userId } },
      );
      changes.companyAdminsReassigned = caRes.modifiedCount;
      // Collapse per companyId: keep oldest.
      const allCa = await companyAdminsCol
        .find({ userId: canonical.userId })
        .sort({ createdAt: 1 })
        .toArray();
      const seenByCompany = new Set<string>();
      const caDeleteIds: import("mongodb").ObjectId[] = [];
      for (const row of allCa) {
        const key = String(row.companyId);
        if (seenByCompany.has(key)) {
          caDeleteIds.push(row._id);
        } else {
          seenByCompany.add(key);
        }
      }
      if (caDeleteIds.length > 0) {
        const delRes = await companyAdminsCol.deleteMany({
          _id: { $in: caDeleteIds },
        });
        changes.companyAdminsDeduped = delRes.deletedCount;
      }

      // 4. Delete duplicate user docs.
      const userDelRes = await usersCol.deleteMany({
        userId: { $in: duplicateIds },
      });
      changes.duplicateUsersDeleted = userDelRes.deletedCount;
    }

    // 5. Backfill phoneE164 on canonical (idempotent).
    if (canonical.phoneE164 !== phone) {
      await usersCol.updateOne(
        { userId: canonical.userId },
        { $set: { phoneE164: phone, updatedAt: new Date() } },
      );
      changes.canonicalPhoneBackfilled = phone;
    } else {
      changes.canonicalPhoneBackfilled = "already_set";
    }

    logger.info(summary, "consolidate_users_by_phone");
    res.json({ ok: true, ...summary });
  }),
);

// ===================================================================
// Shared auth guard for internal admin endpoints (SMI v0.2 §13).
// ===================================================================
function guardInternal(req: Request, res: Response): boolean {
  const internalSecret = process.env.INTERNAL_S2S_SECRET;
  const headerSecret = req.header("x-internal-secret");
  if (internalSecret) {
    if (headerSecret !== internalSecret) {
      res.status(401).json({ error: "unauthorized" });
      return false;
    }
    return true;
  }
  const bypassEnabled =
    process.env.DEV_OTP_BYPASS === "1" &&
    !process.env.TWILIO_ACCOUNT_SID &&
    !process.env.TWILIO_VERIFY_SERVICE_SID;
  if (!bypassEnabled) {
    res.status(404).json({ error: "not_found" });
    return false;
  }
  return true;
}

// ===================================================================
// POST /v1/internal/migrate-owner-everywhere
//
// SMI v0.2 §6 — Owner-everywhere data migration.
//
// Steps (all idempotent):
//   1. Upsert the 3 default role catalogs (company.v1, workspace.v1, module.v1)
//      into freshify_users.role_catalogs.
//   2. For every Company in freshify_companies.companies:
//        - If company.ownership.ownerUserId is unset, pick Owner by:
//            a. company.ownerUserId if present (legacy field), OR
//            b. oldest company_admins row by createdAt, OR
//            c. fallback to fallbackOperatorUserId if no admins exist.
//        - Write company.ownership = { ownerUserId, transferredFrom: null,
//          transferredAt: null, version: 1 }.
//        - Ensure the Owner has a company_admins row with role=owner; collapse
//          duplicates for that user.
//        - Normalize all company_admins.role values to the company catalog.
//   3. For every Workspace in freshify_workspaces.workspaces:
//        - If workspace.ownership.ownerUserId is unset, pick Owner by:
//            a. workspace.createdBy if present, OR
//            b. oldest workspace_members row with rank >= manager, OR
//            c. fallback to fallbackOperatorUserId.
//        - Write workspace.ownership = { ownerUserId, transferredFrom: null,
//          transferredAt: null, version: 1 }.
//        - Ensure the Owner has a workspace_members row with role=owner;
//          collapse duplicates.
//        - Normalize all workspace_members.role values to the workspace catalog.
//
// Body: { fallbackOperatorUserId?: string, dryRun?: boolean }
// Returns: per-step summary suitable for spot-checking.
// ===================================================================
app.post(
  "/v1/internal/migrate-owner-everywhere",
  wrap(async (req: Request, res: Response) => {
    if (!guardInternal(req, res)) return;

    const body = (req.body ?? {}) as {
      fallbackOperatorUserId?: string;
      dryRun?: boolean;
    };
    const dryRun = body.dryRun === true;
    const fallbackOperatorUserId =
      body.fallbackOperatorUserId ?? "usr_KV1im21A_b8OotEV"; // Alex Morgan

    const now = new Date();
    const usersDb = await getDb(logger);
    const companiesDb = await getCompaniesDb(logger);
    const workspacesDb = await getWorkspacesDb(logger);

    const summary: Record<string, unknown> = {
      dryRun,
      fallbackOperatorUserId,
      catalogs: { upserted: 0 },
      companies: {
        total: 0,
        ownershipBackfilled: 0,
        ownerByLegacyField: 0,
        ownerByOldestAdmin: 0,
        ownerByFallback: 0,
        adminRolesNormalized: 0,
      },
      workspaces: {
        total: 0,
        ownershipBackfilled: 0,
        ownerByCreatedBy: 0,
        ownerByOldestMember: 0,
        ownerByFallback: 0,
        memberRolesNormalized: 0,
      },
    };
    const companiesSum = summary.companies as Record<string, number>;
    const workspacesSum = summary.workspaces as Record<string, number>;
    const catalogsSum = summary.catalogs as Record<string, number>;

    // ─── Step 1: upsert default catalogs ──────────────────────────────
    const catalogsCol = usersDb.collection("role_catalogs");
    const catalogs = defaultCatalogs(now);
    for (const cat of catalogs) {
      if (!dryRun) {
        await catalogsCol.updateOne(
          { catalogId: cat.catalogId },
          {
            $set: {
              scope: cat.scope,
              moduleKey: cat.moduleKey,
              version: cat.version,
              roles: cat.roles,
              updatedAt: now,
            },
            $setOnInsert: {
              catalogId: cat.catalogId,
              createdAt: now,
            },
          },
          { upsert: true },
        );
      }
      catalogsSum.upserted += 1;
    }

    // ─── Step 2: companies ────────────────────────────────────────
    const companiesCol = companiesDb.collection("companies");
    const companyAdminsCol = companiesDb.collection("company_admins");
    const companies = await companiesCol.find({}).toArray();
    companiesSum.total = companies.length;

    for (const company of companies) {
      const companyId = company.companyId;
      const existingOwnership = (company as { ownership?: { ownerUserId?: string } })
        .ownership;
      let ownerUserId: string | null =
        existingOwnership?.ownerUserId ?? null;
      let ownerSource: "existing" | "legacy" | "oldest_admin" | "fallback" =
        "existing";

      if (!ownerUserId) {
        if (typeof company.ownerUserId === "string" && company.ownerUserId) {
          ownerUserId = company.ownerUserId;
          ownerSource = "legacy";
        } else {
          const oldestAdmin = await companyAdminsCol
            .find({ companyId })
            .sort({ createdAt: 1 })
            .limit(1)
            .next();
          if (oldestAdmin) {
            ownerUserId = oldestAdmin.userId;
            ownerSource = "oldest_admin";
          } else {
            ownerUserId = fallbackOperatorUserId;
            ownerSource = "fallback";
          }
        }
      }

      if (!ownerUserId) continue; // safety

      // Backfill ownership envelope.
      if (!existingOwnership || !existingOwnership.ownerUserId) {
        if (!dryRun) {
          await companiesCol.updateOne(
            { companyId },
            {
              $set: {
                ownership: {
                  ownerUserId,
                  transferredFrom: null,
                  transferredAt: null,
                  version: 1,
                },
                ownerUserId, // keep legacy field in sync
                updatedAt: now,
              },
            },
          );
        }
        companiesSum.ownershipBackfilled += 1;
        if (ownerSource === "legacy") companiesSum.ownerByLegacyField += 1;
        else if (ownerSource === "oldest_admin")
          companiesSum.ownerByOldestAdmin += 1;
        else if (ownerSource === "fallback")
          companiesSum.ownerByFallback += 1;
      }

      // Ensure Owner has a company_admins row with role=owner, collapse dupes.
      const ownerAdminRows = await companyAdminsCol
        .find({ companyId, userId: ownerUserId })
        .sort({ createdAt: 1 })
        .toArray();
      if (!dryRun) {
        if (ownerAdminRows.length === 0) {
          await companyAdminsCol.insertOne({
            userId: ownerUserId,
            companyId,
            role: "owner",
            createdAt: now,
            addedBy: null,
          });
        } else {
          await companyAdminsCol.updateOne(
            { _id: ownerAdminRows[0]._id },
            { $set: { role: "owner", updatedAt: now } },
          );
          if (ownerAdminRows.length > 1) {
            await companyAdminsCol.deleteMany({
              _id: { $in: ownerAdminRows.slice(1).map((r) => r._id) },
            });
          }
        }
      }

      // Normalize all OTHER admin rows for this company.
      const otherRows = await companyAdminsCol
        .find({ companyId, userId: { $ne: ownerUserId } })
        .toArray();
      for (const row of otherRows) {
        const normalized = normalizeCompanyRole(String(row.role ?? "member"));
        if (normalized !== row.role) {
          if (!dryRun) {
            await companyAdminsCol.updateOne(
              { _id: row._id },
              { $set: { role: normalized, updatedAt: now } },
            );
          }
          companiesSum.adminRolesNormalized += 1;
        }
      }
    }

    // ─── Step 3: workspaces ───────────────────────────────────────
    const workspacesCol = workspacesDb.collection("workspaces");
    const workspaceMembersCol = workspacesDb.collection("workspace_members");
    const workspaces = await workspacesCol.find({}).toArray();
    workspacesSum.total = workspaces.length;

    // Workspace rank order (manager-or-above is eligible for Owner backfill).
    const WS_RANK: Record<string, number> = {
      owner: 100,
      admin: 90, // legacy alias → treated as eligible
      manager: 70,
      member: 30,
      viewer: 10,
    };

    for (const workspace of workspaces) {
      const workspaceId = workspace.workspaceId;
      const existingOwnership = (workspace as { ownership?: { ownerUserId?: string } })
        .ownership;
      let ownerUserId: string | null =
        existingOwnership?.ownerUserId ?? null;
      let ownerSource: "existing" | "created_by" | "oldest_member" | "fallback" =
        "existing";

      if (!ownerUserId) {
        if (typeof workspace.createdBy === "string" && workspace.createdBy) {
          ownerUserId = workspace.createdBy;
          ownerSource = "created_by";
        } else {
          const eligible = await workspaceMembersCol
            .find({ workspaceId })
            .sort({ createdAt: 1 })
            .toArray();
          const first = eligible.find((m) => {
            const r = String(m.role ?? "member");
            return (WS_RANK[r] ?? 30) >= 70;
          });
          if (first) {
            ownerUserId = first.userId;
            ownerSource = "oldest_member";
          } else {
            ownerUserId = fallbackOperatorUserId;
            ownerSource = "fallback";
          }
        }
      }

      if (!ownerUserId) continue;

      if (!existingOwnership || !existingOwnership.ownerUserId) {
        if (!dryRun) {
          await workspacesCol.updateOne(
            { workspaceId },
            {
              $set: {
                ownership: {
                  ownerUserId,
                  transferredFrom: null,
                  transferredAt: null,
                  version: 1,
                },
                updatedAt: now,
              },
            },
          );
        }
        workspacesSum.ownershipBackfilled += 1;
        if (ownerSource === "created_by") workspacesSum.ownerByCreatedBy += 1;
        else if (ownerSource === "oldest_member")
          workspacesSum.ownerByOldestMember += 1;
        else if (ownerSource === "fallback")
          workspacesSum.ownerByFallback += 1;
      }

      // Ensure Owner has a workspace_members row with role=owner.
      const ownerMemberRows = await workspaceMembersCol
        .find({ workspaceId, userId: ownerUserId })
        .sort({ createdAt: 1 })
        .toArray();
      if (!dryRun) {
        if (ownerMemberRows.length === 0) {
          await workspaceMembersCol.insertOne({
            userId: ownerUserId,
            workspaceId,
            companyId: workspace.companyId,
            role: "owner",
            createdAt: now,
            addedBy: null,
          });
        } else {
          await workspaceMembersCol.updateOne(
            { _id: ownerMemberRows[0]._id },
            { $set: { role: "owner", updatedAt: now } },
          );
          if (ownerMemberRows.length > 1) {
            await workspaceMembersCol.deleteMany({
              _id: { $in: ownerMemberRows.slice(1).map((r) => r._id) },
            });
          }
        }
      }

      // Normalize all OTHER member rows for this workspace.
      const otherMembers = await workspaceMembersCol
        .find({ workspaceId, userId: { $ne: ownerUserId } })
        .toArray();
      for (const row of otherMembers) {
        const normalized = normalizeWorkspaceRole(String(row.role ?? "member"));
        if (normalized !== row.role) {
          if (!dryRun) {
            await workspaceMembersCol.updateOne(
              { _id: row._id },
              { $set: { role: normalized, updatedAt: now } },
            );
          }
          workspacesSum.memberRolesNormalized += 1;
        }
      }
    }

    logger.info(summary, "migrate_owner_everywhere");
    res.json({ ok: true, ...summary });
  }),
);

// ===================================================================
// Deploy 3 — Portal v3 routes
// ===================================================================

// GET /v1/portal-settings — operator-only, returns merged singleton + defaults
app.get(
  "/v1/portal-settings",
  requireUser(),
  wrap(async (req: Request, res: Response) => {
    const db = await getDb(logger);
    const out = await getPortalSettings({
      db,
      logger,
      identity: req.identity!,
    });
    res.json(out);
  }),
);

// PUT /v1/portal-settings — operator-only, partial update with deep-merge
app.put(
  "/v1/portal-settings",
  requireUser(),
  wrap(async (req: Request, res: Response) => {
    const db = await getDb(logger);
    const out = await updatePortalSettings(req.body, {
      db,
      logger,
      identity: req.identity!,
    });
    res.json(out);
  }),
);

// GET /v1/portal-invites — operator-only, list outstanding (pending,
// unexpired) invites. Returns up to 50, newest first.
app.get(
  "/v1/portal-invites",
  requireUser(),
  wrap(async (req: Request, res: Response) => {
    const db = await getDb(logger);
    const out = await listInvitesV3({}, { db, identity: req.identity!, logger });
    res.json(out);
  }),
);

// POST /v1/portal-invites — operator-only, mint a portal invite (v3).
// Distinct path from the legacy /v1/invites route (which is the company-
// membership inviteUser flow). Renamed to avoid Express route collision.
app.post(
  "/v1/portal-invites",
  requireUser(),
  wrap(async (req: Request, res: Response) => {
    const db = await getDb(logger);
    const out = await createInviteV3(req.body, {
      db,
      logger,
      identity: req.identity!,
    });
    res.json(out);
  }),
);

// DELETE /v1/portal-invites/:inviteId — operator-only, revoke a pending invite
// (Deploy 5.3). Idempotent: re-revoking returns status="already_revoked".
// Returns 409 if the invite has already been accepted.
app.delete(
  "/v1/portal-invites/:inviteId",
  requireUser(),
  wrap(async (req: Request, res: Response) => {
    const db = await getDb(logger);
    const out = await revokeInviteV3(
      { inviteId: String(req.params.inviteId ?? "") },
      { db, logger, identity: req.identity! },
    );
    res.json(out);
  }),
);

// POST /v1/portal-invites/_batch/revoke — operator-only, bulk revoke
// (Deploy 5.4). Underscored sub-path avoids collisions with future
// per-invite paths under /v1/portal-invites/:inviteId/*.
app.post(
  "/v1/portal-invites/_batch/revoke",
  requireUser(),
  wrap(async (req: Request, res: Response) => {
    const db = await getDb(logger);
    const out = await revokeInvitesBatchV3(req.body, {
      db,
      logger,
      identity: req.identity!,
    });
    res.json(out);
  }),
);

// POST /v1/portal-invites/:inviteId/resend — operator-only, regenerate the
// invite token + push expiresAt out (Deploy 5.5). Pending and expired
// invites can be resent; accepted and revoked return 409.
app.post(
  "/v1/portal-invites/:inviteId/resend",
  requireUser(),
  wrap(async (req: Request, res: Response) => {
    const db = await getDb(logger);
    const out = await resendInviteV3(
      { inviteId: String(req.params.inviteId ?? "") },
      { db, logger, identity: req.identity! },
    );
    res.json(out);
  }),
);

// POST /v1/portal-invites/:inviteId/_resend-email — operator-only, retry the
// invite email without rotating the token (Deploy 5.8). Idempotent: stamps
// emailSentAt (or emailSendError) on the invite row. Useful when the initial
// send failed transiently but the existing token + expiry are still valid.
app.post(
  "/v1/portal-invites/:inviteId/_resend-email",
  requireUser(),
  wrap(async (req: Request, res: Response) => {
    if (!req.identity?.operator) {
      res.status(403).json({ error: "operator_only" });
      return;
    }
    const db = await getDb(logger);
    const out = await sendInviteEmail(
      { inviteId: String(req.params.inviteId ?? ""), trigger: "retry" },
      { db, logger },
    );
    res.json(out);
  }),
);

// POST /v1/portal-invites/:inviteId/_backfill-membership — operator-only,
// repair an accepted-but-missing membership row (Deploy 5.13). Idempotent:
// re-running on an already-granted invite returns action="already_present".
app.post(
  "/v1/portal-invites/:inviteId/_backfill-membership",
  requireUser(),
  wrap(async (req: Request, res: Response) => {
    const [db, companiesDb, workspacesDb] = await Promise.all([
      getDb(logger),
      getCompaniesDb(logger),
      getWorkspacesDb(logger),
    ]);
    const out = await backfillMembership(String(req.params.inviteId ?? ""), {
      db,
      companiesDb,
      workspacesDb,
      logger,
      identity: req.identity!,
    });
    res.json(out);
  }),
);

// POST /v1/portal-invites/_backfill-memberships — operator-only, bulk repair
// of all accepted invites in the last 90 days whose membership status is
// `missing` or `failed` (Deploy 5.13). Capped per call — the response
// includes `hasMore` so the operator can press the button again.
app.post(
  "/v1/portal-invites/_backfill-memberships",
  requireUser(),
  wrap(async (req: Request, res: Response) => {
    const [db, companiesDb, workspacesDb] = await Promise.all([
      getDb(logger),
      getCompaniesDb(logger),
      getWorkspacesDb(logger),
    ]);
    const out = await backfillMembershipsBatch(req.body, {
      db,
      companiesDb,
      workspacesDb,
      logger,
      identity: req.identity!,
    });
    res.json(out);
  }),
);

// GET /v1/portal-invites/by-token/:token — public, used by signup page
app.get(
  "/v1/portal-invites/by-token/:token",
  wrap(async (req: Request, res: Response) => {
    const db = await getDb(logger);
    const out = await getInviteV3(String(req.params.token ?? ""), { db });
    res.json(out);
  }),
);

// POST /v1/portal-invites/:token/accept — authenticated, redeem invite
app.post(
  "/v1/portal-invites/:token/accept",
  requireUser(),
  wrap(async (req: Request, res: Response) => {
    const db = await getDb(logger);
    // Deploy 5.11 — pass sibling DBs so acceptInviteV3 can write membership
    // rows into freshify_companies.company_admins and
    // freshify_workspaces.workspace_members.
    const [companiesDb, workspacesDb] = await Promise.all([
      getCompaniesDb(logger),
      getWorkspacesDb(logger),
    ]);
    const out = await acceptInviteV3(String(req.params.token ?? ""), {
      db,
      companiesDb,
      workspacesDb,
      logger,
      identity: req.identity!,
    });
    res.json(out);
  }),
);

// GET /v1/admin/audit-feed — operator-only, portal-wide audit aggregator
// (Deploy 5). Unions portal_audit_log, company_audit_log, workspace_audit_log.
// Query params: cursor (ISO), limit (1..200), source (portal|company|workspace),
// actorUserId. Newest first. Hyphenated to avoid future /admin/audit/:id
// path-param collisions.
app.get(
  "/v1/admin/audit-feed",
  requireUser(),
  wrap(async (req: Request, res: Response) => {
    const db = await getDb(logger);
    const input = {
      cursor: typeof req.query.cursor === "string" ? req.query.cursor : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      source: typeof req.query.source === "string" ? req.query.source : undefined,
      actorUserId:
        typeof req.query.actorUserId === "string" ? req.query.actorUserId : undefined,
      since: typeof req.query.since === "string" ? req.query.since : undefined,
      until: typeof req.query.until === "string" ? req.query.until : undefined,
      eventPrefix:
        typeof req.query.eventPrefix === "string" ? req.query.eventPrefix : undefined,
    };
    const out = await getPortalAuditFeed(input, {
      db,
      logger,
      identity: req.identity!,
    });
    res.json(out);
  }),
);

// GET /v1/admin/users-stats — operator-only counters for the Users module.
// Hyphenated (not /v1/admin/users/stats) because /v1/admin/users/:userId is
// already registered with a path param that would swallow "stats".
app.get(
  "/v1/admin/users-stats",
  requireUser(),
  wrap(async (req: Request, res: Response) => {
    const db = await getDb(logger);
    const out = await getUsersStats({
      db,
      identity: req.identity!,
    });
    res.json(out);
  }),
);

// ===================================================================
// Sprint 4 — Module Registry Settings (Phase B) + getModuleInfo
//
// Portal-scope module registry surface for the Users module:
//   - GET    /v1/modules/users/settings
//   - PUT    /v1/modules/users/settings           (operator-only)
//   - GET    /v1/modules/users/admins
//   - POST   /v1/modules/users/admins             (operator-only)
//   - DELETE /v1/modules/users/admins/:userId     (operator-only)
//   - GET    /v1/modules/users/info               (authenticated, read-only)
// ===================================================================
app.get(
  "/v1/modules/users/settings",
  requireUser(),
  wrap(async (req: Request, res: Response) => {
    const db = await getDb(logger);
    const out = await getModuleSettings({}, {
      db,
      identity: req.identity!,
      logger,
    });
    res.json(out);
  }),
);

app.put(
  "/v1/modules/users/settings",
  requireUser(),
  wrap(async (req: Request, res: Response) => {
    const db = await getDb(logger);
    const out = await updateModuleSettings(req.body, {
      db,
      identity: req.identity!,
      logger,
    });
    res.json(out);
  }),
);

app.get(
  "/v1/modules/users/admins",
  requireUser(),
  wrap(async (req: Request, res: Response) => {
    const db = await getDb(logger);
    const out = await listModuleAdmins({}, {
      db,
      identity: req.identity!,
      logger,
    });
    res.json(out);
  }),
);

app.post(
  "/v1/modules/users/admins",
  requireUser(),
  wrap(async (req: Request, res: Response) => {
    const db = await getDb(logger);
    const out = await addModuleAdmin(req.body, {
      db,
      identity: req.identity!,
      logger,
    });
    res.json(out);
  }),
);

app.delete(
  "/v1/modules/users/admins/:userId",
  requireUser(),
  wrap(async (req: Request, res: Response) => {
    const db = await getDb(logger);
    const out = await removeModuleAdmin(
      { userId: String(req.params.userId ?? "") },
      { db, identity: req.identity!, logger },
    );
    res.json(out);
  }),
);

app.get(
  "/v1/modules/users/info",
  requireUser(),
  wrap(async (req: Request, res: Response) => {
    const db = await getDb(logger);
    const out = await getModuleInfo({}, {
      db,
      identity: req.identity!,
      logger,
    });
    res.json(out);
  }),
);

// POST /v1/internal/migrate-schema-v3 — additive idempotent backfill
app.post(
  "/v1/internal/migrate-schema-v3",
  wrap(async (req: Request, res: Response) => {
    if (!guardInternal(req, res)) return;
    const db = await getDb(logger);
    const out = await migrateSchemaV3((req.body ?? {}) as { dryRun?: boolean }, {
      db,
      logger,
    });
    res.json(out);
  }),
);

// ===================================================================
// GET /v1/internal/verify-owner-everywhere
//
// Invariant check for SMI v0.2 §6. Returns:
//   - Every Company has ownership.ownerUserId set; PASS/FAIL count.
//   - Every Company has exactly one company_admins row with role=owner; FAIL list.
//   - Every Workspace has ownership.ownerUserId set; PASS/FAIL count.
//   - Every Workspace has exactly one workspace_members row with role=owner; FAIL list.
//   - role_catalogs has the 3 default catalogs at expected versions.
//
// Safe to call repeatedly. Read-only.
// ===================================================================
app.get(
  "/v1/internal/verify-owner-everywhere",
  wrap(async (req: Request, res: Response) => {
    if (!guardInternal(req, res)) return;

    const usersDb = await getDb(logger);
    const companiesDb = await getCompaniesDb(logger);
    const workspacesDb = await getWorkspacesDb(logger);

    const catalogsCol = usersDb.collection("role_catalogs");
    const companiesCol = companiesDb.collection("companies");
    const companyAdminsCol = companiesDb.collection("company_admins");
    const workspacesCol = workspacesDb.collection("workspaces");
    const workspaceMembersCol = workspacesDb.collection("workspace_members");

    // Catalogs
    const expected = ["company.v1", "workspace.v1", "module.v1"];
    const presentCatalogs = await catalogsCol
      .find({ catalogId: { $in: expected } })
      .project({ catalogId: 1, version: 1, _id: 0 })
      .toArray();
    const missingCatalogs = expected.filter(
      (id) => !presentCatalogs.some((c) => c.catalogId === id),
    );

    // Companies
    const companies = await companiesCol.find({}).toArray();
    const companiesMissingOwnership: string[] = [];
    const companiesMultipleOwners: string[] = [];
    for (const c of companies) {
      const ownerId = (c as { ownership?: { ownerUserId?: string } }).ownership
        ?.ownerUserId;
      if (!ownerId) {
        companiesMissingOwnership.push(c.companyId);
        continue;
      }
      const ownerRows = await companyAdminsCol.countDocuments({
        companyId: c.companyId,
        role: "owner",
      });
      if (ownerRows !== 1) {
        companiesMultipleOwners.push(
          `${c.companyId} (${ownerRows} owner rows)`,
        );
      }
    }

    // Workspaces
    const workspaces = await workspacesCol.find({}).toArray();
    const workspacesMissingOwnership: string[] = [];
    const workspacesMultipleOwners: string[] = [];
    for (const w of workspaces) {
      const ownerId = (w as { ownership?: { ownerUserId?: string } }).ownership
        ?.ownerUserId;
      if (!ownerId) {
        workspacesMissingOwnership.push(w.workspaceId);
        continue;
      }
      const ownerRows = await workspaceMembersCol.countDocuments({
        workspaceId: w.workspaceId,
        role: "owner",
      });
      if (ownerRows !== 1) {
        workspacesMultipleOwners.push(
          `${w.workspaceId} (${ownerRows} owner rows)`,
        );
      }
    }

    const pass =
      missingCatalogs.length === 0 &&
      companiesMissingOwnership.length === 0 &&
      companiesMultipleOwners.length === 0 &&
      workspacesMissingOwnership.length === 0 &&
      workspacesMultipleOwners.length === 0;

    res.json({
      ok: true,
      pass,
      catalogs: {
        expected,
        present: presentCatalogs,
        missing: missingCatalogs,
      },
      companies: {
        total: companies.length,
        missingOwnership: companiesMissingOwnership,
        wrongOwnerCount: companiesMultipleOwners,
      },
      workspaces: {
        total: workspaces.length,
        missingOwnership: workspacesMissingOwnership,
        wrongOwnerCount: workspacesMultipleOwners,
      },
    });
  }),
);

const port = Number(process.env.PORT ?? 8080);
app.listen(port, () => {
  logger.info({ port, adapter: adapter.name }, "freshify-users listening");
});
