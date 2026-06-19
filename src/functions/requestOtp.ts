/**
 * requestOtp — start an OTP sign-in flow.
 *
 * Caller submits identifier + channel. We record a pending_otps challenge,
 * then delegate sending to the AuthAdapter (Twilio Verify in prod, console
 * in dev). Returns a challengeId the caller passes to verifyOtp.
 *
 * Per Twilio Verify semantics, we do NOT generate or store the code itself.
 * Twilio holds the code on its side; we only track that a challenge exists.
 */
import type { Db } from "mongodb";
import type { Logger } from "pino";
import { RequestOtpInput, RequestOtpOutput } from "../schemas";
import { collections } from "../mongo";
import { newId } from "../identity";
import type { AuthAdapter } from "../auth";

const OTP_TTL_SEC = 10 * 60; // 10 minutes — matches Twilio Verify default

export async function requestOtp(
  rawInput: unknown,
  ctx: { db: Db; logger: Logger; adapter: AuthAdapter },
): Promise<RequestOtpOutput> {
  const input = RequestOtpInput.parse(rawInput);

  // Send via the configured adapter first — if Twilio rejects (invalid number,
  // unsupported region), we fail loudly instead of writing a dead record.
  await ctx.adapter.sendChallenge(
    { identifier: input.identifier, channel: input.channel },
    ctx.logger,
  );

  const now = new Date();
  const challengeId = newId("otp");
  await collections.otps(ctx.db).insertOne({
    challengeId,
    identifier: input.identifier,
    channel: input.channel,
    attempts: 0,
    createdAt: now,
    expiresAt: new Date(now.getTime() + OTP_TTL_SEC * 1000),
  });

  return RequestOtpOutput.parse({
    challengeId,
    expiresAt: new Date(now.getTime() + OTP_TTL_SEC * 1000).toISOString(),
  });
}
