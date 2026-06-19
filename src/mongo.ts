/**
 * MongoDB connection — lazy, pooled, single client per process.
 *
 * Reads MONGODB_URI from env. The URI is project-wide; per-module databases
 * are selected by name (freshify_users, freshify_companies, freshify_workspaces).
 *
 * Indexes are created on first connect via ensureIndexes().
 */
import { MongoClient, Db, Collection } from "mongodb";
import type { Logger } from "pino";

const DB_NAME = "freshify_users";

let client: MongoClient | null = null;
let db: Db | null = null;
let indexesReady = false;

export async function getDb(logger: Logger): Promise<Db> {
  if (db) return db;

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI not set — service is not configured");
  }

  client = new MongoClient(uri, {
    appName: "freshify-users",
    maxPoolSize: 10,
    minPoolSize: 1,
    retryWrites: true,
    serverSelectionTimeoutMS: 5_000,
  });

  await client.connect();
  db = client.db(DB_NAME);

  logger.info({ db: DB_NAME }, "mongo connected");

  if (!indexesReady) {
    await ensureIndexes(db, logger);
    indexesReady = true;
  }

  return db;
}

async function ensureIndexes(db: Db, logger: Logger): Promise<void> {
  // users: globally unique email
  await db.collection("users").createIndex({ email: 1 }, { unique: true });

  // user_company_memberships: a user belongs to a company at most once
  await db
    .collection("user_company_memberships")
    .createIndex({ userId: 1, companyId: 1 }, { unique: true });
  await db.collection("user_company_memberships").createIndex({ userId: 1 });
  await db.collection("user_company_memberships").createIndex({ companyId: 1 });

  // auth_sessions: lookups by token hash, with TTL cleanup
  await db.collection("auth_sessions").createIndex({ tokenHash: 1 }, { unique: true });
  await db.collection("auth_sessions").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await db.collection("auth_sessions").createIndex({ userId: 1 });

  // pending_invites: lookups by token + TTL cleanup
  await db.collection("pending_invites").createIndex({ token: 1 }, { unique: true });
  await db.collection("pending_invites").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });

  // pending_otps: short-lived OTP challenges (demo/dev adapter only on default install)
  await db.collection("pending_otps").createIndex({ challengeId: 1 }, { unique: true });
  await db.collection("pending_otps").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });

  // Sprint 1 — auth — email verification tokens
  // One row per outstanding email-verify challenge. TTL-indexed.
  await db
    .collection("pending_email_verifications")
    .createIndex({ token: 1 }, { unique: true });
  await db
    .collection("pending_email_verifications")
    .createIndex({ userId: 1 });
  await db
    .collection("pending_email_verifications")
    .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });

  // Sprint 1 — auth — password reset tokens
  // One row per outstanding reset challenge. TTL-indexed.
  await db
    .collection("pending_password_resets")
    .createIndex({ token: 1 }, { unique: true });
  await db
    .collection("pending_password_resets")
    .createIndex({ userId: 1 });
  await db
    .collection("pending_password_resets")
    .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });

  // Sprint 1 — the Users module spec — user_type extension table registry
  // One row per (userId, userType) holding type-specific extension fields.
  await db
    .collection("user_type_extensions")
    .createIndex({ userId: 1, userType: 1 }, { unique: true });
  await db
    .collection("user_type_extensions")
    .createIndex({ userType: 1 });

  // Sprint 1 5.18f — Module Admins for the Users module.
  // the Users module spec: the first user of a tenant is auto-
  // promoted to Module Admin across every installed module. Each module BE
  // owns its own module_admins collection (sovereignty — no shared table).
  // Row key is (moduleKey, tenantScope, tenantId, userId). tenantScope is
  // "company" | "workspace" | "portal". For Users module the canonical
  // grant is at company scope; workspace-scope rows are reserved for
  // workspace-bound user-management overrides (not used in v1.1).
  await db
    .collection("module_admins")
    .createIndex(
      { moduleKey: 1, tenantScope: 1, tenantId: 1, userId: 1 },
      { unique: true },
    );
  await db.collection("module_admins").createIndex({ userId: 1 });
  await db
    .collection("module_admins")
    .createIndex({ moduleKey: 1, tenantScope: 1, tenantId: 1 });

  // role_catalogs: one current document per (scope, moduleKey). version is
  // monotonic; older versions are kept for audit.
  await db
    .collection("role_catalogs")
    .createIndex({ scope: 1, moduleKey: 1, version: -1 });
  await db
    .collection("role_catalogs")
    .createIndex({ catalogId: 1 }, { unique: true });

  // Deploy 3 — portal_settings is a singleton; key is settingsId = "singleton".
  await db.collection("portal_settings").createIndex({ settingsId: 1 }, { unique: true });

  // Deploy 3 — invites collection (new). Distinct from pending_invites which
  // remains the legacy company-membership invite store. Email is the lookup
  // key during signup; token authorizes acceptance.
  await db.collection("invites").createIndex({ token: 1 }, { unique: true });
  await db.collection("invites").createIndex({ email: 1, status: 1 });
  await db.collection("invites").createIndex({ inviteId: 1 }, { unique: true });
  await db.collection("invites").createIndex({ expiresAt: 1 });

  // Deploy 5 — portal-scope audit log. Sibling to company_audit_log and
  // workspace_audit_log in their respective DBs; this one owns portal-level
  // events (portal_settings updates, invite create/accept, operator admin
  // user CRUD, OTP/auth notable events). Powers GET /v1/admin/audit-feed.
  await db.collection("portal_audit_log").createIndex({ at: -1 });
  await db.collection("portal_audit_log").createIndex({ actorUserId: 1, at: -1 });
  await db.collection("portal_audit_log").createIndex({ event: 1, at: -1 });
  // Deploy 5.1 — retention TTL. Mongo TTL is fixed-seconds-from-field; we
  // align with the default portal_settings.audit.retentionDays (365). To
  // change retention, drop and recreate this index with the new
  // expireAfterSeconds value (one-time ops command — documented in the
  // runbook). Future rows beyond the retention window are deleted by
  // Mongo's TTL monitor (runs every ~60s).
  try {
    await db
      .collection("portal_audit_log")
      .createIndex({ at: 1 }, { expireAfterSeconds: 365 * 24 * 60 * 60, name: "audit_ttl" });
  } catch (err) {
    // If the index already exists with a different expireAfterSeconds, Mongo
    // throws IndexOptionsConflict (code 85). That is recoverable via
    // collMod — we log and continue rather than crash boot.
    logger.warn({ err }, "portal_audit_log TTL index create skipped");
  }

  logger.info("mongo indexes ready");
}

/**
 * getCompaniesDb — returns the companies DB on the same shared client.
 *
 * users-be normally only writes to freshify_users, but the operator
 * cleanup migration needs to insert into freshify_companies.company_admins
 * to satisfy the SMI v0.2 §13 rule that operator role grants are real
 * Layer 2 assignments, not implicit from the operator JWT claim.
 */
export async function getCompaniesDb(logger: Logger): Promise<Db> {
  // Ensure the shared client is initialised by calling getDb() first.
  await getDb(logger);
  if (!client) {
    throw new Error("mongo client unavailable after getDb()");
  }
  return client.db("freshify_companies");
}

/**
 * getWorkspacesDb — returns the workspaces DB on the same shared client.
 *
 * Same pattern as getCompaniesDb. Used by the Owner-everywhere migration
 * to backfill ownership on Workspace documents and normalize
 * workspace_members.role to the SMI v0.2 workspace catalog.
 */
export async function getWorkspacesDb(logger: Logger): Promise<Db> {
  await getDb(logger);
  if (!client) {
    throw new Error("mongo client unavailable after getDb()");
  }
  return client.db("freshify_workspaces");
}

export async function closeDb(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    db = null;
    indexesReady = false;
  }
}

// Typed collection helpers — keep call sites concise
export const collections = {
  users: (db: Db): Collection<UserDoc> => db.collection<UserDoc>("users"),
  memberships: (db: Db): Collection<MembershipDoc> =>
    db.collection<MembershipDoc>("user_company_memberships"),
  sessions: (db: Db): Collection<SessionDoc> => db.collection<SessionDoc>("auth_sessions"),
  invites: (db: Db): Collection<InviteDoc> => db.collection<InviteDoc>("pending_invites"),
  otps: (db: Db): Collection<OtpDoc> => db.collection<OtpDoc>("pending_otps"),
  roleCatalogs: (db: Db): Collection<RoleCatalogDoc> =>
    db.collection<RoleCatalogDoc>("role_catalogs"),
  // Deploy 3 additions
  portalSettings: (db: Db): Collection<PortalSettingsDoc> =>
    db.collection<PortalSettingsDoc>("portal_settings"),
  invitesV3: (db: Db): Collection<InviteDocV3> => db.collection<InviteDocV3>("invites"),
  // Sprint 1 — auth + the Users module spec
  emailVerifications: (db: Db): Collection<PendingEmailVerificationDoc> =>
    db.collection<PendingEmailVerificationDoc>("pending_email_verifications"),
  passwordResets: (db: Db): Collection<PendingPasswordResetDoc> =>
    db.collection<PendingPasswordResetDoc>("pending_password_resets"),
  userTypeExtensions: (db: Db): Collection<UserTypeExtensionDoc> =>
    db.collection<UserTypeExtensionDoc>("user_type_extensions"),
  // Sprint 1 5.18f — Module Admins for the Users module.
  moduleAdmins: (db: Db): Collection<ModuleAdminDoc> =>
    db.collection<ModuleAdminDoc>("module_admins"),
  // Deploy 5 — portal-scope audit log
  portalAuditLog: (db: Db): Collection<PortalAuditDoc> =>
    db.collection<PortalAuditDoc>("portal_audit_log"),
};

// Sprint 1 5.18f — Module Admin row.
// Marks a user as Module Admin of a given module within a given tenant
// scope. Inserted by the bootstrap rule the first time a tenant gains its
// first member, or by an explicit admin grant from an existing Module
// Admin (RLG/URM grant flows — out of scope for 5.18f).
export interface ModuleAdminDoc {
  moduleKey: string; // e.g. "users", "companies", "workspaces"
  tenantScope: "company" | "workspace" | "portal";
  tenantId: string | null; // null only when tenantScope === "portal"
  userId: string;
  grantedAt: Date;
  grantedBy: string | null; // null when granted by bootstrap rule
  source: "bootstrap" | "manual"; // bootstrap = first-user auto-promotion
}

// Deploy 5 — portal-scope audit log row. Append-only. Mirrors the shape of
// CompanyAuditDoc and WorkspaceAuditDoc so the aggregator can union them.
export interface PortalAuditDoc {
  at: Date;
  actorUserId: string | null;
  event: string; // e.g. "portal.settings_updated", "portal.invite_created"
  payload: Record<string, unknown>;
}

// ─── Persisted document shapes ────────────────────────────────────────────
export interface UserDoc {
  userId: string;
  email: string;
  displayName: string | null;
  phoneE164: string | null;
  createdAt: Date;
  updatedAt: Date;
  status: "active" | "invited" | "disabled";
  // ─── Deploy 3 / Portal v3 additions (all optional during rolling window)
  title?: string | null;
  username?: string | null; // unique handle, lowercase
  lastActivityAt?: Date | null;
  profilePhotoUrl?: string | null;
  passwordHash?: string | null; // bcrypt; null when email-login not configured
  emailVerifiedAt?: Date | null;
  uiPreferences?: { theme?: "system" | "light" | "dark" };
  // ─── Sprint 1 — user_type registry — extensible user_type
  // The base type is "user" by default. Other types (driver, sub_contractor,
  // operator, …) carry type-specific fields in user_type_extensions keyed by
  // (userId, userType). The registry of known types lives in src/userTypes.ts.
  userType?: string;
}

// Sprint 1 — auth — pending email verification token.
// TTL-indexed on expiresAt.
export interface PendingEmailVerificationDoc {
  token: string;
  userId: string;
  email: string; // snapshotted at issue time
  createdAt: Date;
  expiresAt: Date;
}

// Sprint 1 — auth — pending password reset token.
// TTL-indexed on expiresAt.
export interface PendingPasswordResetDoc {
  token: string;
  userId: string;
  email: string; // snapshotted at issue time
  createdAt: Date;
  expiresAt: Date;
  usedAt?: Date | null;
}

// Sprint 1 — the Users module spec — user_type extension row.
// One per (userId, userType). data is a free-form bag the registered type
// owns; the type registry (src/userTypes.ts) validates shape on write.
export interface UserTypeExtensionDoc {
  userId: string;
  userType: string; // e.g. "driver", "sub_contractor"
  data: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

// Deploy 3 — portal_settings singleton. Stored as a single document with
// settingsId = "singleton". All fields are optional so partial PUTs work.
export interface PortalSettingsDoc {
  settingsId: "singleton";
  branding?: {
    appName?: string;
    logoUrl?: string | null;
    faviconUrl?: string | null;
    accentColor?: string; // hex, e.g. "#0F0F0F"
    backgroundTone?: string; // hex
    sidebarStyle?: "light" | "dark" | "inverted";
    defaultTheme?: "system" | "light" | "dark";
    allowUserThemeOverride?: boolean;
  };
  email?: {
    provider?: "freshify-comms" | "smtp" | "none";
    senderName?: string;
    senderAddress?: string;
    replyTo?: string | null;
    commsUrl?: string; // override the freshify-comms URL
  };
  sms?: {
    provider?: "twilio" | "none";
    senderId?: string | null;
    twilioVerifyServiceSid?: string | null;
  };
  auth?: {
    allowEmailPassword?: boolean;
    allowPhoneOtp?: boolean;
    requireEmailVerification?: boolean;
    sessionTtlHours?: number;
  };
  invites?: {
    expiryHours?: number;
    defaultCompanyRole?: "admin" | "member";
  };
  catalog?: {
    companyTypes?: string[];
    workspaceTypes?: string[];
  };
  audit?: {
    retentionDays?: number;
  };
  updatedAt?: Date;
  updatedBy?: string | null;
}

// Deploy 3 — invite (portal-wide). One row per outstanding invite.
export interface InviteDocV3 {
  inviteId: string;
  token: string; // url-safe random; the invite link uses this
  email: string;
  companyId: string | null; // null for portal-level (operator) invites
  workspaceId: string | null;
  role: string; // role key in the relevant catalog
  invitedBy: string;
  createdAt: Date;
  expiresAt: Date;
  status: "pending" | "accepted" | "revoked" | "expired";
  acceptedBy?: string | null;
  acceptedAt?: Date | null;
  emailSentAt?: Date | null;
  emailSendError?: string | null;
  // Deploy 5.8 — populated by sendInviteEmail when comms returns a messageId.
  emailMessageId?: string | null;
  emailProvider?: string | null;
  // Deploy 5.3 — set when an operator revokes a pending invite.
  revokedAt?: Date | null;
  revokedBy?: string | null;
  // Deploy 5.5 — set when an operator resends an invite (new token + extended
  // expiry). resentCount counts resends; the original createdAt/invitedBy stay
  // pinned so audit history is preserved.
  resentAt?: Date | null;
  resentBy?: string | null;
  resentCount?: number;
}

export interface MembershipDoc {
  userId: string;
  companyId: string;
  role: "admin" | "member";
  createdAt: Date;
}

export interface SessionDoc {
  sessionId: string;
  userId: string;
  tokenHash: string;
  issuedAt: Date;
  expiresAt: Date;
  ip: string | null;
  userAgent: string | null;
}

export interface InviteDoc {
  inviteId: string;
  token: string;
  email: string;
  companyId: string;
  role: "admin" | "member";
  invitedBy: string;
  createdAt: Date;
  expiresAt: Date;
  status: "pending" | "accepted" | "revoked";
}

export interface OtpDoc {
  challengeId: string;
  identifier: string; // email or phoneE164
  channel: "sms" | "email";
  attempts: number;
  createdAt: Date;
  expiresAt: Date;
}

// ─── Role catalog (SMI v0.2 §6) ───────────────────────────────────────────
//
// One document per (scope, version). The framework ships v1 defaults for
// every scope; customers can fork a catalog for their own install but the
// shape is closed v0.2 (capability set is locked, role keys are extensible).

export type RoleCatalogScope = "company" | "workspace" | "module";

export type RoleCapability =
  | "read"
  | "write"
  | "manage_users"
  | "manage_settings"
  | "manage_roles"
  | "transfer_ownership"
  | "delete";

export interface RoleEntry {
  key: string; // e.g. "owner", "admin", "manager", "member", "viewer"
  name: string; // display name
  rank: number; // ordering, higher = more privileged
  capabilities: RoleCapability[];
  isAutoAssigned: "owner_on_create" | "invite_default" | null;
}

export interface RoleCatalogDoc {
  catalogId: string; // "company.v1", "workspace.v1", "module.v1"
  scope: RoleCatalogScope;
  moduleKey: string | null; // null for company/workspace; module key for per-module catalogs
  version: number; // monotonic per (scope, moduleKey)
  roles: RoleEntry[];
  createdAt: Date;
  updatedAt: Date;
}
