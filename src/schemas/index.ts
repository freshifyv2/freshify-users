/**
 * Zod schemas for the Users module API surface.
 *
 * Each function declared in module.ts references one of these schemas as
 * its inputSchema/outputSchema. The SMI's SchemaRef contract requires a
 * `name` and a `parse` function — Zod schemas already provide both shapes
 * (Zod schemas have .parse), we just wrap to add the name.
 */
import { z } from "zod";
import type { SchemaRef } from "../vendor/authz";

export function named<T>(name: string, schema: z.ZodType<T>): SchemaRef {
  return {
    name,
    parse: (v: unknown) => schema.parse(v),
  };
}

// ─── Input/output shapes ──────────────────────────────────────────────────

export const InviteUserInput = z.object({
  email: z.string().email(),
  role: z.enum(["admin", "member"]).default("member"),
});
export type InviteUserInput = z.infer<typeof InviteUserInput>;

export const InviteUserOutput = z.object({
  inviteId: z.string(),
  email: z.string().email(),
  expiresAt: z.string(), // ISO
});
export type InviteUserOutput = z.infer<typeof InviteUserOutput>;

export const AcceptInviteInput = z.object({
  token: z.string().min(20),
  displayName: z.string().min(1).max(120).optional(),
});
export type AcceptInviteInput = z.infer<typeof AcceptInviteInput>;

export const AcceptInviteOutput = z.object({
  userId: z.string(),
  companyId: z.string(),
  sessionToken: z.string(),
});
export type AcceptInviteOutput = z.infer<typeof AcceptInviteOutput>;

export const ListUsersInput = z.object({
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z.string().nullable().default(null),
});
export type ListUsersInput = z.infer<typeof ListUsersInput>;

export const ListUsersOutput = z.object({
  users: z.array(
    z.object({
      userId: z.string(),
      email: z.string(),
      displayName: z.string().nullable(),
      status: z.enum(["active", "invited", "disabled"]),
      role: z.enum(["admin", "member"]),
    }),
  ),
  nextCursor: z.string().nullable(),
});
export type ListUsersOutput = z.infer<typeof ListUsersOutput>;

export const GetUserInput = z.object({ userId: z.string() });
export type GetUserInput = z.infer<typeof GetUserInput>;

export const GetUserOutput = z.object({
  userId: z.string(),
  email: z.string(),
  displayName: z.string().nullable(),
  phoneE164: z.string().nullable(),
  status: z.enum(["active", "invited", "disabled"]),
});
export type GetUserOutput = z.infer<typeof GetUserOutput>;

export const RequestOtpInput = z.object({
  identifier: z.string().min(3), // email or E.164 phone
  channel: z.enum(["sms", "email"]),
});
export type RequestOtpInput = z.infer<typeof RequestOtpInput>;

export const RequestOtpOutput = z.object({
  challengeId: z.string(),
  expiresAt: z.string(),
});
export type RequestOtpOutput = z.infer<typeof RequestOtpOutput>;

export const VerifyOtpInput = z.object({
  identifier: z.string().min(3),
  channel: z.enum(["sms", "email"]),
  code: z.string().min(4).max(10),
  displayName: z.string().min(1).max(120).optional(),
});
export type VerifyOtpInput = z.infer<typeof VerifyOtpInput>;

export const VerifyOtpOutput = z.object({
  userId: z.string(),
  isNewUser: z.boolean(),
  sessionToken: z.string(),
  expiresAt: z.string(),
});
export type VerifyOtpOutput = z.infer<typeof VerifyOtpOutput>;

// Event payloads
export const UserCreatedPayload = z.object({
  userId: z.string(),
  email: z.string(),
  displayName: z.string().nullable(),
  via: z.enum(["otp", "invite"]),
  createdAt: z.string(),
});
export type UserCreatedPayload = z.infer<typeof UserCreatedPayload>;

export const UserInvitedPayload = z.object({
  inviteId: z.string(),
  email: z.string(),
  companyId: z.string(),
  role: z.enum(["admin", "member"]),
  invitedBy: z.string(),
  expiresAt: z.string(),
});
export type UserInvitedPayload = z.infer<typeof UserInvitedPayload>;

export const UserAuthenticatedPayload = z.object({
  userId: z.string(),
  email: z.string(),
  sessionId: z.string(),
  via: z.enum(["otp", "invite"]),
  authenticatedAt: z.string(),
});
export type UserAuthenticatedPayload = z.infer<typeof UserAuthenticatedPayload>;

// ─── Sprint 1 — auth schemas ────────────────────────────────

export const RegisterInput = z.object({
  email: z.string().email(),
  password: z.string().min(1), // adapter enforces real policy
  displayName: z.string().min(1).max(120).optional(),
});
export type RegisterInput = z.infer<typeof RegisterInput>;

export const RegisterOutput = z.object({
  userId: z.string(),
  status: z.enum(["verification_sent", "verification_resent", "already_verified"]),
  expiresAt: z.string().nullable(),
});
export type RegisterOutput = z.infer<typeof RegisterOutput>;

export const VerifyEmailInput = z.object({
  token: z.string().min(8),
});
export type VerifyEmailInput = z.infer<typeof VerifyEmailInput>;

export const VerifyEmailOutput = z.object({
  userId: z.string(),
  email: z.string(),
  sessionToken: z.string(),
  expiresAt: z.string(),
});
export type VerifyEmailOutput = z.infer<typeof VerifyEmailOutput>;

export const LoginInput = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof LoginInput>;

export const LoginOutput = z.object({
  userId: z.string(),
  sessionToken: z.string(),
  expiresAt: z.string(),
});
export type LoginOutput = z.infer<typeof LoginOutput>;

export const RequestPasswordResetInput = z.object({
  email: z.string().email(),
});
export type RequestPasswordResetInput = z.infer<typeof RequestPasswordResetInput>;

export const RequestPasswordResetOutput = z.object({
  status: z.literal("ok"),
});
export type RequestPasswordResetOutput = z.infer<typeof RequestPasswordResetOutput>;

export const ResetPasswordInput = z.object({
  token: z.string().min(8),
  password: z.string().min(1),
});
export type ResetPasswordInput = z.infer<typeof ResetPasswordInput>;

export const ResetPasswordOutput = z.object({
  userId: z.string(),
  sessionToken: z.string(),
  expiresAt: z.string(),
});
export type ResetPasswordOutput = z.infer<typeof ResetPasswordOutput>;
