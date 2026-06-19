/**
 * Twilio Verify implementation of AuthAdapter.
 *
 * Uses Twilio's hosted Verify service. We do NOT manage OTP codes or
 * expirations ourselves — Twilio handles all of that. Our pending_otps
 * collection only tracks the challengeId we issued so the caller can
 * resume the verify flow.
 *
 * Env vars required:
 *   - TWILIO_ACCOUNT_SID
 *   - TWILIO_AUTH_TOKEN
 *   - TWILIO_VERIFY_SERVICE_SID
 */
import twilio from "twilio";
import type { Logger } from "pino";
import type { AuthAdapter, AuthChallenge, AuthVerifyInput } from "./adapter";

export function createTwilioAdapter(): AuthAdapter {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const verifyService = process.env.TWILIO_VERIFY_SERVICE_SID;

  if (!sid || !token || !verifyService) {
    throw new Error(
      "Twilio adapter requires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VERIFY_SERVICE_SID",
    );
  }

  const client = twilio(sid, token);

  return {
    name: "twilio-verify",
    async sendChallenge(input: AuthChallenge, logger: Logger) {
      const verification = await client.verify.v2
        .services(verifyService)
        .verifications.create({
          to: input.identifier,
          channel: input.channel,
        });
      logger.info(
        {
          adapter: "twilio-verify",
          to: maskIdentifier(input.identifier),
          channel: input.channel,
          status: verification.status,
        },
        "otp sent",
      );
      return { providerRef: verification.sid };
    },
    async verifyChallenge(input: AuthVerifyInput, logger: Logger) {
      const check = await client.verify.v2
        .services(verifyService)
        .verificationChecks.create({
          to: input.identifier,
          code: input.code,
        });
      const ok = check.status === "approved";
      logger.info(
        {
          adapter: "twilio-verify",
          to: maskIdentifier(input.identifier),
          status: check.status,
          ok,
        },
        "otp verified",
      );
      return ok;
    },
  };
}

function maskIdentifier(id: string): string {
  // Mask middle of email or phone for logs
  if (id.includes("@")) {
    const [user, domain] = id.split("@");
    return `${user.slice(0, 2)}***@${domain}`;
  }
  return `${id.slice(0, 3)}****${id.slice(-2)}`;
}
