/**
 * ensureOperatorPortalAdmin — auto-grant Module Admin on every sovereign
 * module (Users, Companies, Workspaces) at portal scope to any operator.
 *
 * Rationale: the public Sovereign Portal ships as a single-tenant solo-
 * founder install. The first (and typically only) operator should land
 * on the dashboard and see everything — empty workspaces lists, missing
 * companies, gated user records etc. are an "out-of-the-box broken"
 * experience for OSS users who just spun up the portal.
 *
 * The default first-operator gets Module Admin on every installed
 * sovereign module so the portal works without any post-install grant
 * dance. Multi-operator orgs that want finer control can revoke after.
 *
 * Idempotent. Called from every auth path that issues a session JWT
 * with operator=non-null (verifyOtp, login, verifyEmail, resetPassword,
 * selectContext). Safe to call repeatedly; bootstrapModuleAdmin no-ops
 * when a grant already exists.
 *
 * Best-effort: failures are logged and swallowed. A missing Module Admin
 * grant is recoverable via the URM grant flow.
 */
import type { Db } from "mongodb";
import type { Logger } from "pino";
import { bootstrapModuleAdmin, type ModuleKey } from "./bootstrapModuleAdmin";

const PORTAL_MODULES: ModuleKey[] = ["users", "companies", "workspaces"];

export async function ensureOperatorPortalAdmin(
  db: Db,
  logger: Logger,
  userId: string,
): Promise<void> {
  for (const moduleKey of PORTAL_MODULES) {
    try {
      await bootstrapModuleAdmin({
        db,
        logger,
        moduleKey,
        tenantScope: "portal",
        tenantId: null,
        userId,
      });
    } catch (err) {
      // bootstrapModuleAdmin already swallows; this is a belt-and-braces guard.
      logger.warn(
        { err, moduleKey, userId },
        "ensure_operator_portal_admin_failed",
      );
    }
  }
}
