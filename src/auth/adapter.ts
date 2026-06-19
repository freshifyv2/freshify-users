/**
 * AuthAdapter — the pluggable interface for OTP challenge/verify.
 *
 * Sovereign Portal v0.1 ships with two adapters:
 *   - Twilio Verify (production reference)
 *   - Console-log (dev fallback when Twilio creds aren't configured)
 *
 * Customers swap in Auth0 / Okta / Cognito / Clerk by writing their own
 * adapter against this interface. The contract is intentionally minimal:
 * the adapter handles "send a challenge" and "verify a response". User
 * lookup, session issuance, and IdentityContext construction stay in the
 * Users module — the adapter doesn't touch them.
 */
import type { Logger } from "pino";

export type AuthChannel = "sms" | "email";

export interface AuthChallenge {
  /** Where to send the OTP. Phone (E.164) for SMS, email for email. */
  identifier: string;
  channel: AuthChannel;
}

export interface AuthVerifyInput {
  identifier: string;
  channel: AuthChannel;
  code: string;
}

export interface AuthAdapter {
  /** Name of the adapter implementation. Logged for audit. */
  name: string;
  /** Send the OTP. Returns an opaque provider reference for logging. */
  sendChallenge(input: AuthChallenge, logger: Logger): Promise<{ providerRef: string }>;
  /** Verify the OTP response. Returns true if valid. */
  verifyChallenge(input: AuthVerifyInput, logger: Logger): Promise<boolean>;
}
