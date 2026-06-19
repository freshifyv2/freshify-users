/**
 * Auth adapter selection.
 *
 * Sovereign Portal v0.2 ships with two adapter families:
 *
 *   - PasswordAuthAdapter (default, the auth spec):
 *       password + email verification via the LocalPasswordAdapter (bcrypt).
 *
 *   - AuthAdapter (legacy / demo, OTP-shaped):
 *       Twilio Verify reference. Console-log fallback in dev.
 *
 * Both can run side-by-side. Operators choose which flow is exposed at the
 * UI layer via portal_settings.auth (allowEmailPassword / allowPhoneOtp).
 * The selectors here just construct the adapters; they don't gate routes.
 *
 * If Twilio creds are not configured, the OTP adapter falls back to the
 * console adapter (dev only — logs the code instead of sending it). The
 * password adapter has no external dependency and is always available.
 */
import type { Logger } from "pino";
import type { AuthAdapter } from "./adapter";
import type { PasswordAuthAdapter } from "./passwordAdapter";
import { createTwilioAdapter } from "./twilio";
import { createConsoleAdapter } from "./console";
import { createLocalPasswordAdapter } from "./localPassword";

let cachedOtp: AuthAdapter | null = null;
let cachedPassword: PasswordAuthAdapter | null = null;

/**
 * OTP-shaped adapter (legacy / demo). Returns Twilio when configured,
 * console-log otherwise. Use only behind portal_settings.auth.allowPhoneOtp.
 */
export function getAuthAdapter(logger: Logger): AuthAdapter {
  if (cachedOtp) return cachedOtp;

  const hasTwilio =
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_VERIFY_SERVICE_SID;

  if (hasTwilio) {
    logger.info("otp adapter: twilio-verify");
    cachedOtp = createTwilioAdapter();
  } else {
    logger.warn(
      "otp adapter: console-log (Twilio env not configured — DO NOT USE IN PRODUCTION)",
    );
    cachedOtp = createConsoleAdapter();
  }
  return cachedOtp;
}

/**
 * Password adapter (default per the auth spec). Always available — no
 * external service required. Swap in a different PasswordAuthAdapter
 * implementation here for hosted identity (Auth0, Okta, Cognito, Clerk).
 */
export function getPasswordAdapter(logger: Logger): PasswordAuthAdapter {
  if (cachedPassword) return cachedPassword;
  logger.info("password adapter: local-password-bcrypt");
  cachedPassword = createLocalPasswordAdapter();
  return cachedPassword;
}

export type { AuthAdapter, AuthChallenge, AuthChannel, AuthVerifyInput } from "./adapter";
export type {
  PasswordAuthAdapter,
  PasswordHashResult,
  PasswordVerifyInput,
} from "./passwordAdapter";
