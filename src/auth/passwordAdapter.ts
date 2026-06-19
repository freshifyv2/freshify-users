/**
 * PasswordAuthAdapter — pluggable interface for password + email-verification
 * sign-in flows, per the auth spec.
 *
 * Distinct from AuthAdapter (which is OTP-shaped: challenge → verify code).
 * The password flow has more surface area: register (creates user + issues
 * verification token), login (returns session), request verification, verify
 * email token, request reset, reset password with token.
 *
 * Sovereign Portal v0.2 ships with one reference implementation:
 *   - LocalPasswordAdapter — bcrypt hashes stored in the users collection,
 *     verification + reset tokens stored in Mongo TTL-indexed collections.
 *
 * Customers swap this out for Auth0 / Okta / Cognito / Clerk by writing their
 * own adapter against this interface. The contract owns password lifecycle
 * (hashing, verification, reset). User lookup, session issuance, and
 * IdentityContext construction stay in the Users module — the adapter does
 * not touch them.
 *
 * The Twilio OTP path (AuthAdapter) remains available as a demo/dev adapter
 * for installs that want a passwordless reference build. It is not the
 * default for portal v0.2 — the auth spec wins.
 */
import type { Logger } from "pino";

export interface PasswordHashResult {
  hash: string;
}

export interface PasswordVerifyInput {
  hash: string;
  candidate: string;
}

/**
 * Adapter for password storage + verification.
 *
 * Token issuance + storage is handled by the Users module itself (in the
 * pending_email_verifications and pending_password_resets collections). The
 * adapter only owns the cryptographic primitives — hash a password, verify a
 * candidate against a hash, and (optionally) check password policy.
 */
export interface PasswordAuthAdapter {
  /** Name of the adapter implementation. Logged for audit. */
  name: string;

  /**
   * Hash a plaintext password for storage. Implementations MUST return a
   * hash that includes its own salt + algorithm tag (bcrypt, argon2id, etc.)
   * so verifyPassword can read it back without external state.
   */
  hashPassword(plaintext: string, logger: Logger): Promise<PasswordHashResult>;

  /**
   * Compare a candidate plaintext against a stored hash. Returns true on
   * match, false otherwise. MUST be constant-time on success/failure paths.
   */
  verifyPassword(input: PasswordVerifyInput, logger: Logger): Promise<boolean>;

  /**
   * Check whether a candidate password meets policy. Returns null on pass,
   * or a short human-readable reason string on fail. The reference adapter
   * enforces the auth spec: min 8 chars, at least one letter and
   * one digit. Customers may tighten.
   */
  checkPasswordPolicy(plaintext: string): string | null;
}
