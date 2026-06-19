/**
 * ModuleDescriptor for the Users sovereign module.
 *
 * This is the single source of truth the framework reads to load, mount,
 * route, verify, and document the module. The Express server in server.ts
 * is a thin adapter — it doesn't redefine anything that lives here.
 *
 * Conforms to SMI v0.1 (Section 4: Module Descriptor).
 */
import type {
  ModuleDescriptor,
  ModuleLifecycle,
  PermissionPolicy,
  ApiSurface,
  EventSurface,
  SchemaDescriptor,
  HealthStatus,
} from "./vendor/authz";
import {
  named,
  InviteUserInput,
  InviteUserOutput,
  AcceptInviteInput,
  AcceptInviteOutput,
  ListUsersInput,
  ListUsersOutput,
  GetUserInput,
  GetUserOutput,
  RequestOtpInput,
  RequestOtpOutput,
  VerifyOtpInput,
  VerifyOtpOutput,
  RegisterInput,
  RegisterOutput,
  VerifyEmailInput,
  VerifyEmailOutput,
  LoginInput,
  LoginOutput,
  RequestPasswordResetInput,
  RequestPasswordResetOutput,
  ResetPasswordInput,
  ResetPasswordOutput,
  UserCreatedPayload,
  UserInvitedPayload,
  UserAuthenticatedPayload,
} from "./schemas";

const MODULE_NAME = "users";
const MODULE_VERSION = "0.1.0";

// ─── Lifecycle ────────────────────────────────────────────────────────────
// The Users module is "company"-scoped but it's also the bootstrap module
// for the entire portal — it owns the auth path. Lifecycle hooks for v0.1
// are intentionally minimal; ensureIndexes() is called on first mongo
// connect (see src/mongo.ts), so onInstall is a no-op today.
const lifecycle: ModuleLifecycle = {
  async onInstall() {
    // Indexes are ensured lazily on first connect. Nothing to do here.
  },
  async onUpgrade(_ctx, _from, _to) {
    // Schema migrations land here as the module evolves.
  },
  async onWorkspaceCreated() {
    // Users module is company-scoped; no per-workspace setup.
  },
  async onUninstall() {
    // Users module is the foundation — uninstall is not supported in v0.1.
    return { exportLocation: "n/a", recordCount: 0 };
  },
  async health(): Promise<HealthStatus> {
    return { state: "healthy" };
  },
};

// ─── Permissions ──────────────────────────────────────────────────────────
// v0.1 policy is intentionally simple. Function-specific role checks are
// enforced inside each function (e.g. inviteUser requires company:admin).
// The conformance suite will eventually generate this from declarations.
const permissions: PermissionPolicy = {
  canAccessModule(ctx) {
    if (!ctx.user) {
      return { allow: false, reason: "no user in identity", code: "no_identity" };
    }
    return { allow: true };
  },
  canCallFunction(ctx, functionName) {
    // Anonymous functions: OTP path + invite acceptance + the auth spec flow.
    const ANON_OK = new Set([
      "requestOtp",
      "verifyOtp",
      "acceptInvite",
      "register",
      "verifyEmail",
      "login",
      "requestPasswordReset",
      "resetPassword",
    ]);
    if (ANON_OK.has(functionName)) return { allow: true };

    if (!ctx.user) {
      return { allow: false, reason: "auth required", code: "no_identity" };
    }
    return { allow: true };
  },
  dataScope(ctx, resource) {
    // All Users data is company-scoped except a user's own record.
    if (resource === "users" && ctx.company) {
      return { filter: { kind: "company", companyId: ctx.company.companyId } };
    }
    return null;
  },
};

// ─── API surface ──────────────────────────────────────────────────────────
// Handlers are imported lazily inside the wrapper so module.ts can be loaded
// by tooling (AI Co-Architect Pack generator, conformance suite) without
// pulling in mongo, twilio, jwt, and so on.
const api: ApiSurface = {
  functions: {
    requestOtp: {
      description: "Start an OTP sign-in flow. Sends a code via SMS or email.",
      inputSchema: named("RequestOtpInput", RequestOtpInput),
      outputSchema: named("RequestOtpOutput", RequestOtpOutput),
      mutation: true,
      async handler() {
        throw new Error("dispatched_via_express");
      },
    },
    verifyOtp: {
      description: "Complete an OTP sign-in flow. Returns a session token.",
      inputSchema: named("VerifyOtpInput", VerifyOtpInput),
      outputSchema: named("VerifyOtpOutput", VerifyOtpOutput),
      mutation: true,
      async handler() {
        throw new Error("dispatched_via_express");
      },
    },
    register: {
      description:
        "Email + password sign-up. Creates a user with passwordHash, mints a verification token, sends email. Anonymous.",
      inputSchema: named("RegisterInput", RegisterInput),
      outputSchema: named("RegisterOutput", RegisterOutput),
      mutation: true,
      async handler() {
        throw new Error("dispatched_via_express");
      },
    },
    verifyEmail: {
      description:
        "Consume an email-verification token, mark the user verified, issue a session.",
      inputSchema: named("VerifyEmailInput", VerifyEmailInput),
      outputSchema: named("VerifyEmailOutput", VerifyEmailOutput),
      mutation: true,
      async handler() {
        throw new Error("dispatched_via_express");
      },
    },
    login: {
      description:
        "Email + password sign-in via the configured PasswordAuthAdapter. Returns a session token.",
      inputSchema: named("LoginInput", LoginInput),
      outputSchema: named("LoginOutput", LoginOutput),
      mutation: true,
      async handler() {
        throw new Error("dispatched_via_express");
      },
    },
    requestPasswordReset: {
      description:
        "Start a password reset flow. Always returns ok regardless of whether the email matches an account.",
      inputSchema: named("RequestPasswordResetInput", RequestPasswordResetInput),
      outputSchema: named("RequestPasswordResetOutput", RequestPasswordResetOutput),
      mutation: true,
      async handler() {
        throw new Error("dispatched_via_express");
      },
    },
    resetPassword: {
      description:
        "Consume a reset token, rehash, invalidate other sessions, issue a fresh session.",
      inputSchema: named("ResetPasswordInput", ResetPasswordInput),
      outputSchema: named("ResetPasswordOutput", ResetPasswordOutput),
      mutation: true,
      async handler() {
        throw new Error("dispatched_via_express");
      },
    },
    inviteUser: {
      description: "Invite a user to the caller's current company.",
      inputSchema: named("InviteUserInput", InviteUserInput),
      outputSchema: named("InviteUserOutput", InviteUserOutput),
      mutation: true,
      async handler() {
        throw new Error("dispatched_via_express");
      },
    },
    acceptInvite: {
      description: "Redeem an invite token. Anonymous; the token is the auth.",
      inputSchema: named("AcceptInviteInput", AcceptInviteInput),
      outputSchema: named("AcceptInviteOutput", AcceptInviteOutput),
      mutation: true,
      async handler() {
        throw new Error("dispatched_via_express");
      },
    },
    listUsers: {
      description: "Paginated list of users in the caller's current company.",
      inputSchema: named("ListUsersInput", ListUsersInput),
      outputSchema: named("ListUsersOutput", ListUsersOutput),
      mutation: false,
      async handler() {
        throw new Error("dispatched_via_express");
      },
    },
    getUser: {
      description: "Fetch a single user by id, scoped to the caller's company.",
      inputSchema: named("GetUserInput", GetUserInput),
      outputSchema: named("GetUserOutput", GetUserOutput),
      mutation: false,
      async handler() {
        throw new Error("dispatched_via_express");
      },
    },
  },
};

// ─── Events ───────────────────────────────────────────────────────────────
const events: EventSurface = {
  publishes: [
    { name: "users.created", payloadSchema: named("UserCreatedPayload", UserCreatedPayload) },
    { name: "users.invited", payloadSchema: named("UserInvitedPayload", UserInvitedPayload) },
    {
      name: "users.authenticated",
      payloadSchema: named("UserAuthenticatedPayload", UserAuthenticatedPayload),
    },
  ],
  subscribes: [],
};

// ─── Schemas owned ────────────────────────────────────────────────────────
const schemas: SchemaDescriptor[] = [
  {
    name: "users",
    owner: MODULE_NAME,
    description: "Canonical user records — one per email.",
  },
  {
    name: "user_company_memberships",
    owner: MODULE_NAME,
    description: "Many-to-many links between users and companies, with role.",
  },
  {
    name: "auth_sessions",
    owner: MODULE_NAME,
    description: "Issued session tokens, TTL-indexed for automatic cleanup.",
  },
  {
    name: "pending_invites",
    owner: MODULE_NAME,
    description: "Outstanding invite tokens. TTL-indexed.",
  },
  {
    name: "pending_otps",
    owner: MODULE_NAME,
    description: "Short-lived OTP challenges. TTL-indexed. Used only by the demo/dev OTP adapter.",
  },
  {
    name: "pending_email_verifications",
    owner: MODULE_NAME,
    description: "Email-verification tokens (the auth spec). TTL-indexed.",
  },
  {
    name: "pending_password_resets",
    owner: MODULE_NAME,
    description: "Password-reset tokens (the auth spec). TTL-indexed.",
  },
  {
    name: "user_type_extensions",
    owner: MODULE_NAME,
    description: "Per-user, per-type extension data (the Users module spec).",
  },
];

const moduleDescriptor: ModuleDescriptor = {
  name: MODULE_NAME,
  version: MODULE_VERSION,
  scope: "company",
  dependsOn: [],
  lifecycle,
  permissions,
  api,
  events,
  schemas,
};

export default moduleDescriptor;
