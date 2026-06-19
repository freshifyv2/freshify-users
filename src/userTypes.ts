/**
 * User Type Registry — the Users module spec.
 *
 * The base UserDoc carries a `userType` field. Beyond the base shape (email,
 * displayName, status, etc.), each non-base type owns a set of extension
 * fields stored in the `user_type_extensions` collection keyed by
 * (userId, userType).
 *
 * The registry below defines which user types this install knows about and
 * what shape their extension data must conform to. Other modules can
 * register additional types at boot by calling registerUserType().
 *
 * Sub-Contractors and Drivers are explicitly NOT separate modules — they are
 * user_types backed by extension rows. Sub-Contractors are also surfaced
 * through the Companies module as a company_type filter (the Companies module spec).
 */
import type { ZodType } from "zod";
import { z } from "zod";

// ─── Built-in user types ──────────────────────────────────────────────────

/** Base type — every user has at least this. No extension data. */
export const USER_TYPE_BASE = "user";

/** Driver — fleet/last-mile workforce. Extension carries license + vehicle. */
export const USER_TYPE_DRIVER = "driver";

/** Sub-contractor — third-party operator. Extension carries 1099 details. */
export const USER_TYPE_SUB_CONTRACTOR = "sub_contractor";

/** Operator — Freshify staff with platform-wide access. No extension. */
export const USER_TYPE_OPERATOR = "operator";

// ─── Registry shape ───────────────────────────────────────────────────────

export interface UserTypeDescriptor {
  key: string;
  displayName: string;
  /** Zod schema for the extension data. Null if the type has no extension. */
  extensionSchema: ZodType<unknown> | null;
  /** Free-text description shown in admin UIs. */
  description: string;
}

// ─── Built-in extension schemas ───────────────────────────────────────────

const DriverExtension = z.object({
  licenseNumber: z.string().min(1).max(40),
  licenseClass: z.string().max(20).optional(),
  licenseExpiresAt: z.string().nullable().optional(), // ISO
  vehicleVin: z.string().max(40).nullable().optional(),
});
export type DriverExtension = z.infer<typeof DriverExtension>;

const SubContractorExtension = z.object({
  legalEntityName: z.string().min(1).max(200),
  taxIdLast4: z.string().regex(/^\d{4}$/).nullable().optional(),
  paymentTerms: z.enum(["net15", "net30", "net60"]).optional(),
});
export type SubContractorExtension = z.infer<typeof SubContractorExtension>;

// ─── The registry ─────────────────────────────────────────────────────────

const registry = new Map<string, UserTypeDescriptor>();

function register(d: UserTypeDescriptor): void {
  if (registry.has(d.key)) {
    throw new Error(`user_type already registered: ${d.key}`);
  }
  registry.set(d.key, d);
}

// Seed built-ins
register({
  key: USER_TYPE_BASE,
  displayName: "User",
  extensionSchema: null,
  description: "Standard user. No type-specific fields.",
});

register({
  key: USER_TYPE_DRIVER,
  displayName: "Driver",
  extensionSchema: DriverExtension,
  description: "Fleet / last-mile workforce. Carries license and vehicle data.",
});

register({
  key: USER_TYPE_SUB_CONTRACTOR,
  displayName: "Sub-Contractor",
  extensionSchema: SubContractorExtension,
  description:
    "Third-party operator. Carries legal entity, tax ID last-4, and payment terms.",
});

register({
  key: USER_TYPE_OPERATOR,
  displayName: "Operator",
  extensionSchema: null,
  description: "Platform staff with cross-tenant access. No extension data.",
});

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Register a new user_type at boot. Other modules can call this to extend
 * the closed set above. Throws if the key is already registered.
 */
export function registerUserType(d: UserTypeDescriptor): void {
  register(d);
}

/** Look up a registered user_type. Returns null if unknown. */
export function getUserType(key: string): UserTypeDescriptor | null {
  return registry.get(key) ?? null;
}

/** List all registered user_types. */
export function listUserTypes(): UserTypeDescriptor[] {
  return Array.from(registry.values());
}

/**
 * Validate extension data for a given user_type. Returns the parsed value on
 * success, or a string error message on failure. If the type has no
 * extension schema, returns null (and the caller MUST NOT write extension
 * data for it).
 */
export function validateExtension(
  userType: string,
  data: unknown,
):
  | { ok: true; value: unknown | null }
  | { ok: false; reason: string } {
  const t = registry.get(userType);
  if (!t) return { ok: false, reason: `unknown user_type: ${userType}` };
  if (!t.extensionSchema) {
    // No extension expected; reject any data
    if (data !== undefined && data !== null) {
      return { ok: false, reason: `user_type ${userType} has no extension; data must be empty` };
    }
    return { ok: true, value: null };
  }
  const parsed = t.extensionSchema.safeParse(data);
  if (!parsed.success) {
    return { ok: false, reason: parsed.error.issues.map((i) => i.message).join("; ") };
  }
  return { ok: true, value: parsed.data };
}
