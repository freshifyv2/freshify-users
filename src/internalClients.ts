/**
 * Service-to-service clients for sibling sovereign modules.
 *
 * All calls send `x-internal-secret: ${INTERNAL_S2S_SECRET}` to the target
 * service's /v1/internal/* routes. Targets refuse the call unless the
 * shared secret matches their own INTERNAL_S2S_SECRET env var.
 *
 * Failures are swallowed to empty arrays so that an account/user page never
 * crashes due to a sibling outage — names just appear blank.
 */
import type { Logger } from "pino";

const COMPANIES_URL =
  process.env.COMPANIES_SERVICE_URL ||
  "https://freshify-companies-sbzaekoo4q-uc.a.run.app";

const WORKSPACES_URL =
  process.env.WORKSPACES_SERVICE_URL ||
  "https://freshify-workspaces-sbzaekoo4q-uc.a.run.app";

function secret(): string | null {
  return process.env.INTERNAL_S2S_SECRET || null;
}

async function post<T>(
  url: string,
  body: unknown,
  logger: Logger,
  fallback: T,
): Promise<T> {
  const s = secret();
  if (!s) {
    logger.warn({ url }, "internal_s2s_secret_missing_returning_fallback");
    return fallback;
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": s,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      logger.warn({ url, status: res.status }, "internal_s2s_call_failed");
      return fallback;
    }
    return (await res.json()) as T;
  } catch (err) {
    logger.warn({ err, url }, "internal_s2s_call_threw");
    return fallback;
  }
}

export interface CompanyMembership {
  companyId: string;
  name: string;
  role: "admin" | "member";
}

export async function fetchCompanyMembershipsForUser(
  userId: string,
  logger: Logger,
): Promise<CompanyMembership[]> {
  const out = await post<{ companies: CompanyMembership[] }>(
    `${COMPANIES_URL}/v1/internal/memberships-for-user`,
    { userId },
    logger,
    { companies: [] },
  );
  return out.companies ?? [];
}

export async function resolveCompanyNames(
  companyIds: string[],
  logger: Logger,
): Promise<Map<string, string>> {
  if (companyIds.length === 0) return new Map();
  const out = await post<{ companies: Array<{ companyId: string; name: string }> }>(
    `${COMPANIES_URL}/v1/internal/resolve-companies`,
    { companyIds },
    logger,
    { companies: [] },
  );
  return new Map((out.companies ?? []).map((c) => [c.companyId, c.name]));
}

export interface WorkspaceMembership {
  workspaceId: string;
  name: string;
  companyId: string;
  role: "admin" | "member";
}

export async function fetchWorkspaceMembershipsForUser(
  userId: string,
  logger: Logger,
): Promise<WorkspaceMembership[]> {
  const out = await post<{ workspaces: WorkspaceMembership[] }>(
    `${WORKSPACES_URL}/v1/internal/memberships-for-user`,
    { userId },
    logger,
    { workspaces: [] },
  );
  return out.workspaces ?? [];
}

export async function upsertCompanyMembership(
  input: { userId: string; companyId: string; role?: "admin" | "member" },
  logger: Logger,
): Promise<boolean> {
  const out = await post<{ ok?: true; error?: string }>(
    `${COMPANIES_URL}/v1/internal/memberships`,
    input,
    logger,
    { error: "fallback" },
  );
  return out.ok === true;
}

export async function upsertWorkspaceMembership(
  input: {
    userId: string;
    workspaceId: string;
    companyId?: string;
    role?: "admin" | "member";
  },
  logger: Logger,
): Promise<boolean> {
  const out = await post<{ ok?: true; error?: string }>(
    `${WORKSPACES_URL}/v1/internal/memberships`,
    input,
    logger,
    { error: "fallback" },
  );
  return out.ok === true;
}
