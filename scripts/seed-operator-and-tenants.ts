#!/usr/bin/env ts-node
/**
 * seed-operator-and-tenants.ts
 *
 * Idempotent seed script that populates the Sovereign Portal with:
 *   - Operator assignment for usr_c0TsxItsk5LSJv7e (Alex Morgan, alex.morgan@sovereign.dev)
 *   - Sovereign Corp company (internal) + operator admin membership in it
 *   - Renames legacy operator identity if it still uses real-person fields
 *   - 3 demo tenant companies: Atlantic Logistics, Cascade Health, Midwest Manufacturing
 *   - 2 workspaces per tenant company (6 total)
 *   - ~5 users per tenant (15 total) via OTP bypass + membership assignment
 *   - Each user assigned to their company + one workspace
 *
 * HOW TO RUN:
 *   1. Set environment variables (copy from Cloud Run / .env):
 *      export MONGODB_URI="mongodb+srv://..."
 *      export JWT_SECRET="..."
 *      export USERS_BE_URL="https://freshify-users-sbzaekoo4q-uc.a.run.app"          # optional
 *      export COMPANIES_BE_URL="https://freshify-companies-sbzaekoo4q-uc.a.run.app"  # optional
 *      export WORKSPACES_BE_URL="https://freshify-workspaces-sbzaekoo4q-uc.a.run.app" # optional
 *
 *   2. Run with ts-node (from repo root):
 *      npx ts-node --project tsconfig.json scripts/seed-operator-and-tenants.ts
 *
 *   OR compile first:
 *      npx tsc -p tsconfig.json && node dist/scripts/seed-operator-and-tenants.js
 *
 *   NOTE: This script targets the LIVE BEs over HTTP.
 *         It uses the dev OTP bypass code 424242 for admin login.
 *         The MONGODB_URI is used directly to upsert the operator_assignment
 *         and to upsert user records that can't be created purely via HTTP
 *         (phones in range +16085550110–+16085550129).
 *
 * IDEMPOTENCY:
 *   - Company creation: checks existing list before creating
 *   - User creation: uses upsert in Mongo by email
 *   - Membership assignment: uses Companies/Workspaces BE (idempotent addMember)
 *   - Operator assignment: upsert by userId
 */

import { MongoClient } from "mongodb";

// ─── Configuration ────────────────────────────────────────────────────────────

const USERS_BE = process.env.USERS_BE_URL || "https://freshify-users-sbzaekoo4q-uc.a.run.app";
const COMPANIES_BE = process.env.COMPANIES_BE_URL || "https://freshify-companies-sbzaekoo4q-uc.a.run.app";
const WORKSPACES_BE = process.env.WORKSPACES_BE_URL || "https://freshify-workspaces-sbzaekoo4q-uc.a.run.app";

const ADMIN_PHONE = "+16085550199";
const OTP_BYPASS_CODE = "424242";
const OPERATOR_USER_ID = "usr_c0TsxItsk5LSJv7e";
const OPERATOR_EMAIL = "alex.morgan@sovereign.dev";
const OPERATOR_DISPLAY_NAME = "Alex Morgan";
const OPERATOR_PHONE = "+16085550100";
// ─── Tenant definitions ───────────────────────────────────────────────────────

const TENANTS = [
  {
    name: "Sovereign Corp",
    kind: "internal" as const,
    workspaces: ["Operations", "Engineering"],
    users: [] as UserSeed[], // No demo users; this is the internal tenant
  },
  {
    name: "Atlantic Logistics",
    kind: "customer" as const,
    workspaces: ["New York Hub", "Boston Operations"],
    users: [
      { firstName: "Anna", lastName: "A.", phone: "+16085550110" },
      { firstName: "Ben", lastName: "B.", phone: "+16085550111" },
      { firstName: "Carla", lastName: "C.", phone: "+16085550112" },
      { firstName: "Dave", lastName: "D.", phone: "+16085550113" },
      { firstName: "Erin", lastName: "E.", phone: "+16085550114" },
    ] as UserSeed[],
  },
  {
    name: "Cascade Health",
    kind: "customer" as const,
    workspaces: ["Seattle Clinic", "Portland Clinic"],
    users: [
      { firstName: "Frank", lastName: "F.", phone: "+16085550115" },
      { firstName: "Gina", lastName: "G.", phone: "+16085550116" },
      { firstName: "Hank", lastName: "H.", phone: "+16085550117" },
      { firstName: "Iris", lastName: "I.", phone: "+16085550118" },
      { firstName: "Jack", lastName: "J.", phone: "+16085550119" },
    ] as UserSeed[],
  },
  {
    name: "Midwest Manufacturing",
    kind: "customer" as const,
    workspaces: ["Chicago Plant", "Detroit Plant"],
    users: [
      { firstName: "Kate", lastName: "K.", phone: "+16085550120" },
      { firstName: "Leo", lastName: "L.", phone: "+16085550121" },
      { firstName: "Mia", lastName: "M.", phone: "+16085550122" },
      { firstName: "Noah", lastName: "N.", phone: "+16085550123" },
      { firstName: "Olive", lastName: "O.", phone: "+16085550124" },
    ] as UserSeed[],
  },
];

interface UserSeed {
  firstName: string;
  lastName: string;
  phone: string;
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

async function httpPost(url: string, body: unknown, token?: string): Promise<unknown> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`POST ${url} failed (${res.status}): ${text}`);
  }
  return JSON.parse(text);
}

async function httpGet(url: string, token?: string): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`GET ${url} failed (${res.status}): ${text}`);
  }
  return JSON.parse(text);
}

// ─── Auth helpers ─────────────────────────────────────────────────────────────

async function getAdminJwt(): Promise<string> {
  console.log("  → Logging in as admin...");
  await httpPost(`${USERS_BE}/v1/otp/request`, {
    identifier: ADMIN_PHONE,
    channel: "sms",
  });
  const verifyRes = await httpPost(`${USERS_BE}/v1/otp/verify`, {
    identifier: ADMIN_PHONE,
    channel: "sms",
    code: OTP_BYPASS_CODE,
  }) as { sessionToken: string };
  console.log("  ✓ Got admin JWT (no company context)");
  return verifyRes.sessionToken;
}

async function selectCompanyContext(baseJwt: string, companyId: string, companyName: string): Promise<string> {
  const res = await httpPost(`${USERS_BE}/v1/session/select`, {
    companyId,
    companyName,
  }, baseJwt) as { sessionToken: string };
  return res.sessionToken;
}

// ─── Company helpers ──────────────────────────────────────────────────────────

async function ensureCompany(
  name: string,
  kind: string,
  adminJwt: string,
): Promise<{ companyId: string; jwt: string }> {
  // Check if company already exists
  const listRes = await httpGet(`${COMPANIES_BE}/v1/companies`, adminJwt) as {
    companies: Array<{ companyId: string; name: string }>;
  };
  const existing = listRes.companies.find((c) => c.name === name);
  if (existing) {
    console.log(`  ✓ Company "${name}" already exists: ${existing.companyId}`);
    const companyJwt = await selectCompanyContext(adminJwt, existing.companyId, name);
    return { companyId: existing.companyId, jwt: companyJwt };
  }

  const createRes = await httpPost(`${COMPANIES_BE}/v1/companies`, {
    name,
    kind,
  }, adminJwt) as { companyId: string };
  console.log(`  ✓ Created company "${name}": ${createRes.companyId}`);

  // Get a company-scoped JWT
  const companyJwt = await selectCompanyContext(adminJwt, createRes.companyId, name);
  return { companyId: createRes.companyId, jwt: companyJwt };
}

// ─── Workspace helpers ────────────────────────────────────────────────────────

async function ensureWorkspace(
  name: string,
  companyJwt: string,
): Promise<string> {
  // List existing workspaces
  const listRes = await httpGet(`${WORKSPACES_BE}/v1/workspaces`, companyJwt) as {
    workspaces: Array<{ workspaceId: string; name: string }>;
  };
  const existing = listRes.workspaces.find((w) => w.name === name);
  if (existing) {
    console.log(`    ✓ Workspace "${name}" already exists: ${existing.workspaceId}`);
    return existing.workspaceId;
  }

  const createRes = await httpPost(`${WORKSPACES_BE}/v1/workspaces`, { name }, companyJwt) as {
    workspaceId: string;
  };
  console.log(`    ✓ Created workspace "${name}": ${createRes.workspaceId}`);
  return createRes.workspaceId;
}

// ─── User helpers (via Mongo for direct upsert) ───────────────────────────────

async function ensureUserViaOtp(
  db: import("mongodb").Db,
  displayName: string,
  phone: string,
): Promise<string> {
  const email = `phone+${phone.replace(/[^0-9+]/g, "")}@users.freshify.io`;

  const usersCol = db.collection<{
    userId: string;
    email: string;
    displayName: string | null;
    phoneE164: string | null;
    createdAt: Date;
    updatedAt: Date;
    status: string;
  }>("users");

  const existing = await usersCol.findOne({ email });
  if (existing) {
    // Update displayName if not set
    if (!existing.displayName) {
      await usersCol.updateOne(
        { userId: existing.userId },
        { $set: { displayName, updatedAt: new Date() } },
      );
    }
    console.log(`    ✓ User "${displayName}" already exists: ${existing.userId}`);
    return existing.userId;
  }

  // Create a new user doc directly (same shape as verifyOtp creates)
  const { randomBytes } = await import("node:crypto");
  const userId = `usr_${randomBytes(12).toString("base64url")}`;
  const now = new Date();
  await usersCol.insertOne({
    userId,
    email,
    displayName,
    phoneE164: phone,
    createdAt: now,
    updatedAt: now,
    status: "active",
  });
  console.log(`    ✓ Created user "${displayName}" (${phone}): ${userId}`);
  return userId;
}

async function ensureCompanyMembership(
  db: import("mongodb").Db,
  userId: string,
  companyId: string,
): Promise<void> {
  const membershipsCol = db.collection<{
    userId: string;
    companyId: string;
    role: string;
    createdAt: Date;
  }>("user_company_memberships");

  const existing = await membershipsCol.findOne({ userId, companyId });
  if (existing) {
    console.log(`      ✓ Membership ${userId} → ${companyId} already exists`);
    return;
  }

  await membershipsCol.insertOne({
    userId,
    companyId,
    role: "member",
    createdAt: new Date(),
  });
  console.log(`      ✓ Added ${userId} as member of ${companyId}`);
}

async function ensureWorkspaceMembership(
  companyJwt: string,
  workspaceId: string,
  userId: string,
): Promise<void> {
  try {
    await httpPost(
      `${WORKSPACES_BE}/v1/workspaces/${workspaceId}/members`,
      { userId, role: "member" },
      companyJwt,
    );
    console.log(`      ✓ Added ${userId} to workspace ${workspaceId}`);
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes("409") || msg.includes("already") || msg.includes("member")) {
      console.log(`      ✓ ${userId} already in workspace ${workspaceId}`);
    } else {
      console.warn(`      ⚠ workspace membership skipped: ${msg}`);
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("=== Freshify Operator + Tenant Seed ===\n");

  // ── Connect to MongoDB ────────────────────────────────────────────────────
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    throw new Error(
      "MONGODB_URI not set. Export it before running:\n" +
      "  export MONGODB_URI=\"mongodb+srv://...\"\n",
    );
  }
  console.log("Connecting to MongoDB...");
  const client = new MongoClient(mongoUri, { appName: "freshify-seed" });
  await client.connect();
  const db = client.db("freshify_users");
  const companiesDb = client.db("freshify_companies");
  console.log("✓ MongoDB connected (freshify_users + freshify_companies)\n");

  // ── Step 1: Promote smoke user to operator (Alex Morgan) ──────────────────
  console.log("Step 1: Setting up operator identity (Alex Morgan)");

  const usersCol = db.collection<{
    userId: string;
    email: string;
    displayName: string | null;
    phoneE164: string | null;
    createdAt: Date;
    updatedAt: Date;
    status: string;
  }>("users");

  // Apply rename: email, displayName, phone all reset to Alex Morgan identity
  const smokeUser = await usersCol.findOne({ userId: OPERATOR_USER_ID });
  if (!smokeUser) {
    console.warn(`  ⚠ User ${OPERATOR_USER_ID} not found — operator identity not applied`);
  } else {
    const updates: Record<string, unknown> = {};
    const needsEmail = smokeUser.email !== OPERATOR_EMAIL;
    const needsName = smokeUser.displayName !== OPERATOR_DISPLAY_NAME;
    const needsPhone = smokeUser.phoneE164 !== OPERATOR_PHONE;

    if (needsEmail) {
      const emailConflict = await usersCol.findOne({ email: OPERATOR_EMAIL });
      if (emailConflict && emailConflict.userId !== OPERATOR_USER_ID) {
        console.warn(`  ⚠ ${OPERATOR_EMAIL} already taken by ${emailConflict.userId} — leaving email as-is`);
      } else {
        updates.email = OPERATOR_EMAIL;
      }
    }
    if (needsName) updates.displayName = OPERATOR_DISPLAY_NAME;
    if (needsPhone) updates.phoneE164 = OPERATOR_PHONE;

    if (Object.keys(updates).length > 0) {
      updates.updatedAt = new Date();
      await usersCol.updateOne({ userId: OPERATOR_USER_ID }, { $set: updates });
      console.log(`  ✓ Renamed operator identity:`, updates);
    } else {
      console.log(`  ✓ Operator identity already set to ${OPERATOR_DISPLAY_NAME} (${OPERATOR_EMAIL})`);
    }

  }

  // Upsert operator_assignment
  const opCol = db.collection<{
    userId: string;
    reason: string;
    createdAt: Date;
  }>("operator_assignments");

  await opCol.updateOne(
    { userId: OPERATOR_USER_ID },
    {
      $set: { reason: "audit" },
      $setOnInsert: { userId: OPERATOR_USER_ID, createdAt: new Date() },
    },
    { upsert: true },
  );
  console.log(`  ✓ Upserted operator_assignment: { userId: ${OPERATOR_USER_ID}, reason: audit }\n`);

  // ── Step 2: Login as admin ────────────────────────────────────────────────
  console.log("Step 2: Obtaining admin JWT via OTP bypass");
  const adminJwt = await getAdminJwt();
  console.log();

  // ── Step 3: Create companies + workspaces + users ─────────────────────────
  console.log("Step 3: Creating tenant companies, workspaces, and users\n");

  for (const tenant of TENANTS) {
    console.log(`── Tenant: ${tenant.name} ──`);

    // Create / ensure company
    const { companyId, jwt: companyJwt } = await ensureCompany(
      tenant.name,
      tenant.kind,
      adminJwt,
    );

    // Operator must be a real admin of every tenant company they should see in the
    // tenant switcher. The Operator JWT claim controls visibility, but Layer 2 role
    // assignments still flow through real company_admins rows (per SMI v0.2 §13 —
    // "Operator does NOT auto-grant roles"). Backfill via direct upsert because
    // POST /v1/companies/:id/members requires the caller to already be an admin,
    // and we may be bootstrapping into a fresh DB.
    const companyAdminsCol = companiesDb.collection<{
      userId: string;
      companyId: string;
      role: string;
      createdAt: Date;
      addedBy?: string;
    }>("company_admins");
    const existingAdmin = await companyAdminsCol.findOne({
      userId: OPERATOR_USER_ID,
      companyId,
    });
    if (!existingAdmin) {
      await companyAdminsCol.insertOne({
        userId: OPERATOR_USER_ID,
        companyId,
        role: "admin",
        createdAt: new Date(),
        addedBy: "seed-script",
      });
      console.log(`  ✓ Backfilled operator as admin of "${tenant.name}" (${companyId})`);
    } else if (existingAdmin.role !== "admin") {
      await companyAdminsCol.updateOne(
        { userId: OPERATOR_USER_ID, companyId },
        { $set: { role: "admin" } },
      );
      console.log(`  ✓ Upgraded operator to admin of "${tenant.name}" (was ${existingAdmin.role})`);
    } else {
      console.log(`  ✓ Operator already admin of "${tenant.name}"`);
    }

    // Create workspaces
    const workspaceIds: string[] = [];
    for (const wsName of tenant.workspaces) {
      const wsId = await ensureWorkspace(wsName, companyJwt);
      workspaceIds.push(wsId);
    }

    // Create users and assign memberships
    for (let i = 0; i < tenant.users.length; i++) {
      const u = tenant.users[i];
      const displayName = `${u.firstName} ${u.lastName}`;
      console.log(`  Creating user: ${displayName} (${u.phone})`);

      // Create user in Mongo
      const userId = await ensureUserViaOtp(db, displayName, u.phone);

      // Add to company (via Mongo memberships — matches acceptInvite pattern)
      await ensureCompanyMembership(db, userId, companyId);

      // Also add to Companies BE so listCompanies works for the user
      try {
        await httpPost(
          `${COMPANIES_BE}/v1/companies/${companyId}/members`,
          { userId, role: "member" },
          companyJwt,
        );
        console.log(`      ✓ Added to Companies BE member list`);
      } catch (err) {
        const msg = (err as Error).message;
        if (msg.includes("409") || msg.includes("already") || msg.includes("member") || msg.includes("admin")) {
          console.log(`      ✓ Already in Companies BE member list`);
        } else {
          console.warn(`      ⚠ Companies BE membership skipped: ${msg}`);
        }
      }

      // Assign to first workspace (round-robin: user i → workspace i % len)
      const targetWorkspaceId = workspaceIds[i % workspaceIds.length];
      await ensureWorkspaceMembership(companyJwt, targetWorkspaceId, userId);
    }

    console.log();
  }

  // ── Done ──────────────────────────────────────────────────────────────────
  console.log("=== Seed complete ===");
  console.log(`\nOperator: ${OPERATOR_USER_ID} (${OPERATOR_EMAIL}) — reason: audit`);
  console.log("Tenants created: Sovereign Corp, Atlantic Logistics, Cascade Health, Midwest Manufacturing");
  console.log("Users created: 15 demo users across 3 tenant companies");
  console.log("\nVerify with:");
  console.log(`  # Get JWT, then:`);
  console.log(`  curl -H "Authorization: Bearer <OPERATOR_JWT>" ${USERS_BE}/v1/admin/users`);

  await client.close();
}

main().catch((err) => {
  console.error("\n✗ Seed failed:", err.message);
  process.exit(1);
});
