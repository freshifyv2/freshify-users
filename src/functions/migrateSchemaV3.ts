/**
 * migrateSchemaV3 (users-be) — Deploy 3 / Portal v3 additive schema migration.
 *
 * Idempotent. Backfills optional UserDoc fields and seeds the portal_settings
 * singleton + invites collection.
 *
 * Steps:
 *   1. For every user missing `uiPreferences`, set uiPreferences = { theme: "system" }.
 *   2. Ensure portal_settings singleton exists, seeded with defaults.
 *   3. Ensure `invites` collection exists.
 *
 * Body: { dryRun?: boolean }
 */
import type { Db } from "mongodb";
import type { Logger } from "pino";
import { DEFAULT_PORTAL_SETTINGS } from "./getPortalSettings";

export interface MigrateSchemaV3Output {
  dryRun: boolean;
  users: {
    total: number;
    uiPreferencesBackfilled: number;
  };
  portalSettings: {
    seeded: boolean;
    alreadyPresent: boolean;
  };
  invitesCollectionReady: boolean;
}

export async function migrateSchemaV3(
  body: { dryRun?: boolean },
  ctx: { db: Db; logger: Logger },
): Promise<MigrateSchemaV3Output> {
  const dryRun = body.dryRun === true;
  const usersCol = ctx.db.collection("users");

  // Step 1: backfill uiPreferences.
  const total = await usersCol.countDocuments({});
  const missingUiPrefs = await usersCol.countDocuments({
    uiPreferences: { $exists: false },
  });
  if (!dryRun && missingUiPrefs > 0) {
    await usersCol.updateMany(
      { uiPreferences: { $exists: false } },
      { $set: { uiPreferences: { theme: "system" } } },
    );
  }

  // Step 2: portal_settings singleton.
  const settingsCol = ctx.db.collection("portal_settings");
  const existing = await settingsCol.findOne({ settingsId: "singleton" });
  let seeded = false;
  const alreadyPresent = !!existing;
  if (!existing && !dryRun) {
    await settingsCol.insertOne({
      ...DEFAULT_PORTAL_SETTINGS,
      updatedAt: new Date(),
      updatedBy: null,
    });
    seeded = true;
  }

  // Step 3: ensure invites collection exists.
  let invitesCollectionReady = false;
  try {
    if (!dryRun) {
      try {
        await ctx.db.createCollection("invites");
      } catch (err) {
        const msg = (err as Error).message ?? "";
        if (!msg.toLowerCase().includes("already exists")) {
          ctx.logger.warn({ err }, "createCollection invites unexpected error");
        }
      }
    }
    invitesCollectionReady = true;
  } catch (err) {
    ctx.logger.warn({ err }, "invites collection ensure failed");
  }

  return {
    dryRun,
    users: {
      total,
      uiPreferencesBackfilled: missingUiPrefs,
    },
    portalSettings: {
      seeded,
      alreadyPresent,
    },
    invitesCollectionReady,
  };
}
