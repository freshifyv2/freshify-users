/**
 * updatePortalSettings — partial update of the portal_settings singleton.
 *
 * Operator-only. Body is a partial PortalSettingsDoc; nested groups are
 * deep-merged at the top level so callers can PUT a single sub-group without
 * losing the rest. We do NOT recursively merge below the top-level groups —
 * each group is replaced when present in the body.
 *
 * Audit (Deploy 5): in addition to the updatedAt/updatedBy stamp on the
 * singleton itself, we append a row to portal_audit_log with the list of
 * top-level groups touched. The full patch is not persisted to avoid
 * leaking secrets (e.g. SMS service SIDs) into the audit feed.
 */
import type { Db } from "mongodb";
import type { Logger } from "pino";
import { collections, type PortalSettingsDoc } from "../mongo";
import type { IdentityContext } from "../vendor/authz";

type SettingsPatch = Partial<Omit<PortalSettingsDoc, "settingsId" | "updatedAt" | "updatedBy">>;

export async function updatePortalSettings(
  rawInput: unknown,
  ctx: { db: Db; logger: Logger; identity: IdentityContext },
): Promise<PortalSettingsDoc> {
  if (!ctx.identity.operator) {
    const err = new Error("operator_only");
    (err as Error & { status?: number }).status = 403;
    throw err;
  }
  const patch = (rawInput ?? {}) as SettingsPatch;
  const now = new Date();
  const actorUserId = ctx.identity.user.userId;

  const settingsCol = collections.portalSettings(ctx.db);
  const current = await settingsCol.findOne({ settingsId: "singleton" });

  const next: PortalSettingsDoc = {
    settingsId: "singleton",
    branding: { ...(current?.branding ?? {}), ...(patch.branding ?? {}) },
    email: { ...(current?.email ?? {}), ...(patch.email ?? {}) },
    sms: { ...(current?.sms ?? {}), ...(patch.sms ?? {}) },
    auth: { ...(current?.auth ?? {}), ...(patch.auth ?? {}) },
    invites: { ...(current?.invites ?? {}), ...(patch.invites ?? {}) },
    catalog: { ...(current?.catalog ?? {}), ...(patch.catalog ?? {}) },
    audit: { ...(current?.audit ?? {}), ...(patch.audit ?? {}) },
    updatedAt: now,
    updatedBy: actorUserId,
  };

  await settingsCol.updateOne(
    { settingsId: "singleton" },
    { $set: next },
    { upsert: true },
  );

  const groups = Object.keys(patch);
  ctx.logger.info({ actorUserId, groups }, "portal_settings updated");

  // Deploy 5 — audit row. Best-effort; failures must not block the update.
  try {
    await collections.portalAuditLog(ctx.db).insertOne({
      at: now,
      actorUserId,
      event: "portal.settings_updated",
      payload: { groups },
    });
  } catch (err) {
    ctx.logger.warn({ err }, "portal_audit_log insert failed");
  }

  return next;
}
