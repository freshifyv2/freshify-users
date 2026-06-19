/**
 * Console-log AuthAdapter — dev fallback.
 *
 * Generates a 6-digit code, logs it to stdout, and remembers it in memory
 * so the verify call succeeds. NOT for production. Activates automatically
 * when Twilio env vars are not set.
 */
import type { Logger } from "pino";
import type { AuthAdapter, AuthChallenge, AuthVerifyInput } from "./adapter";

const codes = new Map<string, { code: string; expiresAt: number }>();
const TTL_MS = 10 * 60 * 1000; // 10 min

function key(identifier: string, channel: string): string {
  return `${channel}:${identifier}`;
}

/**
 * DEV ONLY — return the pending code for (identifier, channel) if one exists.
 * Used by the /v1/dev/peek-otp endpoint when DEV_OTP_PEEK=1. The endpoint
 * itself refuses to run when Twilio is configured, so this can never leak
 * production codes (Twilio never generates them on our side).
 */
export function peekConsoleCode(
  identifier: string,
  channel: string,
): { code: string; expiresAt: number } | null {
  const entry = codes.get(key(identifier, channel));
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) return null;
  return entry;
}

export function createConsoleAdapter(): AuthAdapter {
  return {
    name: "console-log",
    async sendChallenge(input: AuthChallenge, logger: Logger) {
      const code = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = Date.now() + TTL_MS;
      codes.set(key(input.identifier, input.channel), { code, expiresAt });
      logger.warn(
        {
          adapter: "console-log",
          to: input.identifier,
          channel: input.channel,
          code,
        },
        "OTP CODE (dev only — do not enable in production)",
      );
      return { providerRef: `console-${Date.now()}` };
    },
    async verifyChallenge(input: AuthVerifyInput, logger: Logger) {
      const entry = codes.get(key(input.identifier, input.channel));
      if (!entry) {
        logger.warn({ adapter: "console-log" }, "no pending code");
        return false;
      }
      if (entry.expiresAt < Date.now()) {
        codes.delete(key(input.identifier, input.channel));
        logger.warn({ adapter: "console-log" }, "code expired");
        return false;
      }
      const ok = entry.code === input.code;
      if (ok) codes.delete(key(input.identifier, input.channel));
      logger.info({ adapter: "console-log", ok }, "code verified");
      return ok;
    },
  };
}
