/**
 * getPortalSettings — read the portal-wide settings singleton.
 *
 * Operator-only (sovereign portal admins only). Returns the seeded defaults
 * when no row exists yet so the caller can render a settings form before
 * the first write.
 */
import type { Db } from "mongodb";
import type { Logger } from "pino";
import { collections, type PortalSettingsDoc } from "../mongo";
import type { IdentityContext } from "../vendor/authz";

export const DEFAULT_PORTAL_SETTINGS: PortalSettingsDoc = {
  settingsId: "singleton",
  branding: {
    appName: "Sovereign Portal",
    logoUrl: null,
    faviconUrl: null,
    accentColor: "#0F0F0F",
    backgroundTone: "#0A0A0F",
    sidebarStyle: "dark",
    defaultTheme: "system",
    allowUserThemeOverride: true,
  },
  email: {
    provider: "freshify-comms",
    senderName: "Sovereign Portal",
    senderAddress: "noreply@freshify.io",
    replyTo: null,
  },
  sms: {
    provider: "twilio",
    senderId: null,
    twilioVerifyServiceSid: null,
  },
  auth: {
    allowEmailPassword: true,
    allowPhoneOtp: true,
    requireEmailVerification: false,
    sessionTtlHours: 168,
  },
  invites: {
    expiryHours: 168,
    defaultCompanyRole: "member",
  },
  catalog: {
    companyTypes: ["Enterprise", "Client", "Sub-Contractor", "Partner", "Affiliate"],
    workspaceTypes: ["Operations", "Development", "Marketing", "Sales", "Support", "Other"],
  },
  audit: {
    retentionDays: 365,
  },
};

export async function getPortalSettings(
  ctx: { db: Db; logger: Logger; identity: IdentityContext },
): Promise<PortalSettingsDoc> {
  if (!ctx.identity.operator) {
    const err = new Error("operator_only");
    (err as Error & { status?: number }).status = 403;
    throw err;
  }
  const doc = await collections.portalSettings(ctx.db).findOne({ settingsId: "singleton" });
  if (!doc) return DEFAULT_PORTAL_SETTINGS;
  // Merge with defaults so missing nested groups still come back populated.
  return {
    ...DEFAULT_PORTAL_SETTINGS,
    ...doc,
    branding: { ...DEFAULT_PORTAL_SETTINGS.branding, ...(doc.branding ?? {}) },
    email: { ...DEFAULT_PORTAL_SETTINGS.email, ...(doc.email ?? {}) },
    sms: { ...DEFAULT_PORTAL_SETTINGS.sms, ...(doc.sms ?? {}) },
    auth: { ...DEFAULT_PORTAL_SETTINGS.auth, ...(doc.auth ?? {}) },
    invites: { ...DEFAULT_PORTAL_SETTINGS.invites, ...(doc.invites ?? {}) },
    catalog: { ...DEFAULT_PORTAL_SETTINGS.catalog, ...(doc.catalog ?? {}) },
    audit: { ...DEFAULT_PORTAL_SETTINGS.audit, ...(doc.audit ?? {}) },
  };
}
