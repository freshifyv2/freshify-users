/**
 * VENDORED FROM: github.com/freshifyv2/freshify-authz (src/smi.ts)
 *
 * SMI v0.1 contract. Do not edit. Resync with scripts/sync-smi.sh.
 *
 * Migration: when @freshifyv2/authz is published to public npm,
 * replace this file with: export * from '@freshifyv2/authz'
 */

// ─────────────────────────────────────────────────────────────────────────────
// §1 — IDENTITY CONTEXT
// ─────────────────────────────────────────────────────────────────────────────
//
// Every inbound request crosses the framework boundary with an IdentityContext.
// It is the only way a module knows who the caller is. Modules MUST NOT read
// session cookies, JWTs, or auth headers directly — that is the auth adapter's
// job. Modules only ever see a resolved IdentityContext.
//
// IdentityContext is the contract that makes the 4-Layer Permission System
// real in code.

/** The four sovereign identity layers. Loose-coupled, not strictly hierarchical. */
export interface IdentityContext {
  /** The acting user. Always present once authenticated. */
  user: UserIdentity;

  /**
   * The company the user is acting on behalf of in this request.
   * A user can belong to many companies; the active one is resolved per-request
   * (typically from a header, subdomain, or path segment — adapter's choice).
   */
  company: CompanyIdentity | null;

  /**
   * The workspace within the company. A company can host many workspaces.
   * Modules that are workspace-scoped (most are) require this; modules that
   * are company-scoped (e.g. Billing) do not.
   */
  workspace: WorkspaceIdentity | null;

  /**
   * The operator identity, if the caller is Freshify staff or the buyer's
   * own ops team acting on behalf of a customer. Operator parity is a
   * first-class concept — operators use the same modules as customers,
   * scoped by role.
   */
  operator: OperatorIdentity | null;

  /**
   * Roles the user holds in this context. Multiple roles can be active at once.
   * Role names are namespaced by layer so a "admin" role on Company doesn't
   * collide with "admin" on Workspace.
   */
  roles: RoleAssignment[];

  /**
   * Request-scoped metadata the adapter wants to pass through.
   * Use sparingly. If something belongs here long-term, it probably belongs
   * on one of the identity layers instead.
   */
  meta?: Record<string, string>;
}

export interface UserIdentity {
  userId: string;          // stable, opaque ID
  email: string;
  displayName: string;
  locale?: string;         // BCP 47, e.g. "en-US"
  timezone?: string;       // IANA, e.g. "America/Chicago"
}

export interface CompanyIdentity {
  companyId: string;
  name: string;
  /** Optional buyer-controlled tier label. The Companies module owns this. */
  tier?: string;
}

export interface WorkspaceIdentity {
  workspaceId: string;
  companyId: string;       // must match IdentityContext.company.companyId
  name: string;
}

export interface OperatorIdentity {
  operatorId: string;
  /** Why the operator is in this context. Audit-logged on every action. */
  reason: OperatorReason;
}

export type OperatorReason =
  | "support"        // responding to a customer support ticket
  | "incident"       // active incident response
  | "audit"          // compliance or internal audit
  | "migration"      // data migration on customer's behalf
  | "impersonation"; // explicit "act as user" with customer consent

export interface RoleAssignment {
  /** Which identity layer this role applies to. */
  layer: "company" | "workspace" | "module";
  /** The role name. Namespaced informally by convention: e.g. "billing:viewer". */
  role: string;
  /**
   * Optional scope. For module-layer roles, this is the module name. For
   * workspace-layer roles, this is the workspace ID. For company-layer roles,
   * this is the company ID. Lets the framework verify the role is being used
   * in the context where it was granted.
   */
  scope?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// §2 — AUTHORIZATION
// ─────────────────────────────────────────────────────────────────────────────
//
// Three layers of permission granularity, all expressed against IdentityContext:
//
//   1. Module access  — can this caller use this module at all?
//   2. Function access — can they call this specific function (view vs. edit)?
//   3. Data access    — of the data the function returns, what can they see?
//
// Modules MUST implement (1) and (2). Data access (3) is implemented inside
// the module's query layer and is verified by the conformance suite.

export interface PermissionPolicy {
  /** Module-level gate. Called once per request, before any function dispatch. */
  canAccessModule(ctx: IdentityContext): PermissionDecision;

  /** Function-level gate. Called per function invocation. */
  canCallFunction(
    ctx: IdentityContext,
    functionName: string,
    input: unknown,
  ): PermissionDecision;

  /**
   * Data filter. Wraps the module's query layer. Returns a predicate (or a
   * query-language fragment) that scopes results to what the caller is
   * allowed to see. Modules that don't return scoped data return null.
   */
  dataScope(
    ctx: IdentityContext,
    resource: string,
  ): DataScopeDecision | null;
}

export type PermissionDecision =
  | { allow: true }
  | { allow: false; reason: string; code: PermissionDenyCode };

export type PermissionDenyCode =
  | "no_identity"          // missing IdentityContext fields
  | "module_disabled"      // module isn't enabled for this company/workspace
  | "insufficient_role"    // caller lacks the required role
  | "wrong_scope"          // role is valid but scoped to a different entity
  | "license_tier"         // feature requires a higher license tier
  | "policy_custom";       // module-defined custom deny

export interface DataScopeDecision {
  /**
   * The framework-neutral representation of a scope filter. Each storage
   * adapter (Mongo, Postgres, etc.) translates this to its native query
   * shape. Keeps modules portable across databases.
   */
  filter: ScopeFilter;
}

export type ScopeFilter =
  | { kind: "all" }
  | { kind: "none" }
  | { kind: "workspace"; workspaceId: string }
  | { kind: "company"; companyId: string }
  | { kind: "user"; userId: string }
  | { kind: "and"; filters: ScopeFilter[] }
  | { kind: "or"; filters: ScopeFilter[] };

// ─────────────────────────────────────────────────────────────────────────────
// §3 — LIFECYCLE
// ─────────────────────────────────────────────────────────────────────────────
//
// A module is a software unit with its own version, schema, and lifecycle.
// The framework calls these hooks. The module owns the implementation.

export interface ModuleLifecycle {
  /** Called once when the module is installed in a company. Idempotent. */
  onInstall(ctx: ModuleLifecycleContext): Promise<void>;

  /** Called when the module is upgraded from one version to another. */
  onUpgrade(
    ctx: ModuleLifecycleContext,
    fromVersion: string,
    toVersion: string,
  ): Promise<void>;

  /** Called when a new workspace is created in a company that has this module. */
  onWorkspaceCreated(ctx: ModuleLifecycleContext): Promise<void>;

  /**
   * Called before the module is uninstalled from a company. The module
   * exports its data (for the customer to keep) and then deletes it.
   * MUST NOT throw — uninstall must always succeed.
   */
  onUninstall(ctx: ModuleLifecycleContext): Promise<UninstallReport>;

  /** Health probe. Framework polls this; failure marks the module degraded. */
  health(): Promise<HealthStatus>;
}

export interface ModuleLifecycleContext {
  moduleName: string;
  companyId: string;
  workspaceId?: string;
  /** A storage handle the module uses to read/write its OWN data only. */
  storage: ModuleStorage;
  /** The framework's logger, pre-tagged with module + company + workspace. */
  logger: Logger;
  /** Other modules the framework has resolved as dependencies. */
  peers: ModulePeerRegistry;
}

export interface UninstallReport {
  /** A URL or path where the exported data lives. Customer keeps this. */
  exportLocation: string;
  /** Number of records exported, for the audit log. */
  recordCount: number;
}

export type HealthStatus =
  | { state: "healthy" }
  | { state: "degraded"; reason: string }
  | { state: "down"; reason: string };

// ─────────────────────────────────────────────────────────────────────────────
// §4 — MODULE DESCRIPTOR
// ─────────────────────────────────────────────────────────────────────────────
//
// Every module exports exactly one default ModuleDescriptor. The framework
// reads this to know how to load, mount, route, and verify the module.

export interface ModuleDescriptor {
  /** Stable identifier. Used in URLs, role scopes, peer lookups. */
  name: string;

  /** Semver. Drives onUpgrade dispatch. */
  version: string;

  /**
   * Which identity layer the module is scoped to. Workspace is the
   * default for business modules; Users/Companies/Workspaces ship as
   * "company"-scoped themselves.
   */
  scope: "company" | "workspace";

  /** Modules this one calls. Framework validates these are installed. */
  dependsOn: ModuleDependency[];

  /** The module's lifecycle hooks. */
  lifecycle: ModuleLifecycle;

  /** The module's permission policy. */
  permissions: PermissionPolicy;

  /** HTTP/RPC functions the module exposes. */
  api: ApiSurface;

  /** Events the module emits and subscribes to. */
  events: EventSurface;

  /** Schemas the module owns. Used by the framework's data-scope verifier. */
  schemas: SchemaDescriptor[];

  /** Optional license tier requirements for individual features. */
  featureFlags?: Record<string, LicenseTier>;
}

export interface ModuleDependency {
  name: string;
  /** Semver range, e.g. "^1.0.0". */
  versionRange: string;
  /** "hard" means installation fails without it. "soft" means degraded mode. */
  kind: "hard" | "soft";
}

export type LicenseTier = "starter" | "team" | "enterprise";

// ─────────────────────────────────────────────────────────────────────────────
// §5 — API SURFACE
// ─────────────────────────────────────────────────────────────────────────────
//
// Modules expose functions. The framework decides whether to route them as
// HTTP, RPC, or in-process calls. Modules don't care.

export interface ApiSurface {
  /** Named functions. Each is type-checked at registration. */
  functions: Record<string, ModuleFunction>;
}

export interface ModuleFunction<TInput = unknown, TOutput = unknown> {
  /** Brief description. Surfaced in the AI Co-Architect Pack. */
  description: string;
  /** Zod (or compatible) schema for input. */
  inputSchema: SchemaRef;
  /** Zod (or compatible) schema for output. */
  outputSchema: SchemaRef;
  /** Whether the function mutates state. Drives idempotency + retry behavior. */
  mutation: boolean;
  /** The implementation. */
  handler: (input: TInput, ctx: ModuleCallContext) => Promise<TOutput>;
}

export interface ModuleCallContext {
  identity: IdentityContext;
  storage: ModuleStorage;
  logger: Logger;
  peers: ModulePeerRegistry;
  /** Emit an event. The framework handles fan-out. */
  emit: <T>(event: ModuleEvent<T>) => Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// §6 — EVENTS
// ─────────────────────────────────────────────────────────────────────────────
//
// Events are how modules talk to each other without direct coupling. The
// framework routes them; subscribers don't know who published.

export interface EventSurface {
  /** Events this module publishes. The framework type-checks payloads. */
  publishes: EventDescriptor[];
  /** Events this module subscribes to. */
  subscribes: EventSubscription[];
}

export interface EventDescriptor {
  /** Namespaced: e.g. "users.created", "orders.fulfilled". */
  name: string;
  /** Zod (or compatible) schema for the payload. */
  payloadSchema: SchemaRef;
}

export interface EventSubscription {
  name: string;
  /**
   * Handler signature mirrors a function: receives the event payload + a
   * scoped context. Errors are retried with exponential backoff; after the
   * retry budget is exhausted the event lands in a dead-letter queue.
   */
  handler: <T>(event: ModuleEvent<T>, ctx: ModuleCallContext) => Promise<void>;
}

export interface ModuleEvent<T> {
  name: string;
  payload: T;
  /** Identity context at the time of emission. May be a system identity. */
  emittedBy: IdentityContext;
  /** ISO 8601. */
  emittedAt: string;
  /** Unique per event, for idempotent handlers. */
  eventId: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// §7 — DATA OWNERSHIP
// ─────────────────────────────────────────────────────────────────────────────
//
// Sovereignty rule: a module's data is owned by that module. Other modules
// MUST NOT read it directly — they call the owning module's API. The
// framework can detect cross-module reads via the schema registry and fail
// the conformance suite if it sees them.

export interface SchemaDescriptor {
  /** Collection / table name. */
  name: string;
  /** Owning module name. The framework verifies this matches the registrant. */
  owner: string;
  /** A short description, surfaced in the AI Co-Architect Pack. */
  description: string;
}

export interface ModuleStorage {
  /**
   * Get a typed collection handle. Only this module's own schemas are
   * resolvable here — passing another module's schema name throws.
   */
  collection<T>(name: string): Collection<T>;
}

/**
 * Storage-engine-neutral collection interface. Each storage adapter
 * (Mongo, Postgres, SQLite) implements this. v0.1 ships with a Mongo
 * adapter; Postgres adapter is v0.2.
 */
export interface Collection<T> {
  findOne(filter: Partial<T>): Promise<T | null>;
  findMany(filter: Partial<T>, opts?: { limit?: number }): Promise<T[]>;
  insert(doc: T): Promise<T>;
  update(filter: Partial<T>, patch: Partial<T>): Promise<number>;
  delete(filter: Partial<T>): Promise<number>;
}

// ─────────────────────────────────────────────────────────────────────────────
// §8 — AUTH ADAPTER
// ─────────────────────────────────────────────────────────────────────────────
//
// The auth adapter is the only thing in the framework that knows about the
// outside world's identity system. It produces an IdentityContext from an
// inbound request; everything downstream works against that context.
//
// v0.1 ships a Twilio OTP reference adapter. Buyers swap in Auth0, Okta,
// Cognito, Clerk, Firebase Auth, etc. by implementing this interface.

export interface AuthAdapter {
  /** Adapter name, e.g. "twilio-otp", "auth0", "okta". */
  name: string;

  /**
   * Resolve an IdentityContext from a raw inbound request. The adapter
   * decides how to read tokens, sessions, headers, subdomains, etc.
   * Throw AuthError if the request is unauthenticated when it must not be.
   */
  resolve(request: InboundRequest): Promise<IdentityContext>;

  /**
   * Start a sign-in flow. The reference Twilio OTP adapter sends an SMS;
   * an Auth0 adapter redirects to Auth0; a Clerk adapter delegates to Clerk's
   * SDK. Return shape is adapter-defined.
   */
  startSignIn(input: SignInStartInput): Promise<SignInStartResult>;

  /**
   * Complete a sign-in flow. Returns a session token the adapter can later
   * resolve back into an IdentityContext via `resolve()`.
   */
  completeSignIn(input: SignInCompleteInput): Promise<SignInCompleteResult>;

  /** End a session. */
  signOut(sessionToken: string): Promise<void>;
}

export interface InboundRequest {
  headers: Record<string, string>;
  cookies: Record<string, string>;
  path: string;
  method: string;
}

export interface SignInStartInput {
  /** Adapter-specific. The Twilio OTP adapter expects { phone: string }. */
  payload: Record<string, unknown>;
}

export interface SignInStartResult {
  /** A handle the client returns to completeSignIn. */
  challengeId: string;
  /** Optional adapter-specific data, e.g. an Auth0 redirect URL. */
  data?: Record<string, unknown>;
}

export interface SignInCompleteInput {
  challengeId: string;
  /** Adapter-specific. The Twilio OTP adapter expects { code: string }. */
  payload: Record<string, unknown>;
}

export interface SignInCompleteResult {
  sessionToken: string;
  identity: IdentityContext;
}

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "unauthenticated"
      | "expired"
      | "invalid_token"
      | "missing_context",
  ) {
    super(message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// §9 — SUPPORTING TYPES
// ─────────────────────────────────────────────────────────────────────────────

/** Opaque reference to a Zod (or compatible) schema. */
export interface SchemaRef {
  /** Human-readable name, used in error messages and AI Co-Architect Pack. */
  name: string;
  /** Parse a value or throw. */
  parse(value: unknown): unknown;
}

export interface Logger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
}

/**
 * Look up a peer module by name. Returns a typed API surface or null if the
 * dependency was declared "soft" and isn't installed. Throws if the name
 * isn't in this module's dependsOn list — modules can only call modules
 * they explicitly depend on.
 */
export interface ModulePeerRegistry {
  get<T extends ApiSurface = ApiSurface>(name: string): T | null;
}
