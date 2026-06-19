/**
 * LocalPasswordAdapter — bcrypt-based reference implementation of
 * PasswordAuthAdapter.
 *
 * Hash storage:  bcrypt with 12 rounds (configurable via BCRYPT_ROUNDS).
 * Policy:        the auth spec — min 8 chars, at least one letter
 *                and one digit. Customers may tighten via portal_settings
 *                (post-v0.2).
 *
 * No external service required. This adapter is appropriate for any install
 * that owns its own user database. For SSO / hosted identity, plug in a
 * different PasswordAuthAdapter implementation.
 */
import bcrypt from "bcryptjs";
import type { Logger } from "pino";
import type {
  PasswordAuthAdapter,
  PasswordHashResult,
  PasswordVerifyInput,
} from "./passwordAdapter";

const DEFAULT_ROUNDS = 12;

export function createLocalPasswordAdapter(): PasswordAuthAdapter {
  const rounds = parseRounds(process.env.BCRYPT_ROUNDS) ?? DEFAULT_ROUNDS;

  return {
    name: "local-password-bcrypt",

    async hashPassword(plaintext: string, logger: Logger): Promise<PasswordHashResult> {
      const hash = await bcrypt.hash(plaintext, rounds);
      logger.debug({ adapter: "local-password-bcrypt", rounds }, "password hashed");
      return { hash };
    },

    async verifyPassword(input: PasswordVerifyInput, logger: Logger): Promise<boolean> {
      const ok = await bcrypt.compare(input.candidate, input.hash);
      logger.debug({ adapter: "local-password-bcrypt", ok }, "password verified");
      return ok;
    },

    checkPasswordPolicy(plaintext: string): string | null {
      if (plaintext.length < 8) {
        return "Password must be at least 8 characters.";
      }
      if (!/[A-Za-z]/.test(plaintext)) {
        return "Password must contain at least one letter.";
      }
      if (!/[0-9]/.test(plaintext)) {
        return "Password must contain at least one digit.";
      }
      return null;
    },
  };
}

function parseRounds(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 4 || n > 15) return null;
  return n;
}
