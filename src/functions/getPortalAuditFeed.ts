/**
 * getPortalAuditFeed — operator-only, portal-wide audit aggregator.
 *
 * Deploy 5 / Portal v3. Unions three append-only collections:
 *   - freshify_users.portal_audit_log         (source: "portal")
 *   - freshify_companies.company_audit_log    (source: "company")
 *   - freshify_workspaces.workspace_audit_log (source: "workspace")
 *
 * Each row is normalized to a single wire shape with a `source` discriminator.
 * Sorted by `at` desc. Cursor pagination uses the ISO `at` timestamp of the
 * last seen row across all sources — we fetch (limit+1) per source filtered
 * by `at < cursor`, then sort-merge in memory and trim to `limit+1`.
 *
 * Filters:
 *   - source: optional one of "portal" | "company" | "workspace"
 *   - actorUserId: optional, applied to every source
 *   - since: optional ISO datetime — only rows with at >= since
 *   - until: optional ISO datetime — only rows with at < until (exclusive end
 *     so a date-only "to" picker can be turned into next-day-midnight without
 *     double-counting boundary rows)
 *   - eventPrefix: optional string. Matched against `event` with a
 *     start-anchored regex. The dot is regex-special but acceptable here
 *     because event keys use dot-segments and we want literal-prefix
 *     semantics; we escape regex metachars defensively.
 *
 * The dashboard Recent Activity card calls this with limit=20 and no cursor.
 * Module Settings audit tabs continue to call their per-module endpoints
 * (getAuditLog on companies-be / workspaces-be) which are scoped to a single
 * entity. This aggregator is intentionally portal-wide.
 */
import type { Db } from "mongodb";
import { z } from "zod";
import { collections } from "../mongo";
import { getCompaniesDb, getWorkspacesDb } from "../mongo";
import type { IdentityContext } from "../vendor/authz";
import type { Logger } from "pino";
import {
  loadUserNames,
  loadCompanyNames,
  loadWorkspaceNames,
} from "./_displayNameHelpers";

export const GetPortalAuditFeedInput = z.object({
  cursor: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(200).default(20),
  source: z.enum(["portal", "company", "workspace"]).optional(),
  actorUserId: z.string().optional(),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  eventPrefix: z.string().min(1).max(120).optional(),
});
export type GetPortalAuditFeedInput = z.infer<typeof GetPortalAuditFeedInput>;

export type AuditSource = "portal" | "company" | "workspace";

export interface PortalAuditEntryWire {
  at: string; // ISO
  source: AuditSource;
  actorUserId: string | null;
  // Deploy 5.15 — name hydration so the operator UI can render names instead
  // of opaque `usr_*` / `cmp_*` / `wsp_*` IDs. Optional + nullable so the
  // FE can fall back to the ID if the join missed.
  actorName?: string | null;
  event: string;
  payload: Record<string, unknown>;
  // Optional entity refs — set when source ∈ {company, workspace}
  companyId?: string | null;
  companyName?: string | null;
  workspaceId?: string | null;
  workspaceName?: string | null;
}

export interface GetPortalAuditFeedOutput {
  entries: PortalAuditEntryWire[];
  nextCursor: string | null;
}

export async function getPortalAuditFeed(
  rawInput: unknown,
  ctx: { db: Db; logger: Logger; identity: IdentityContext },
): Promise<GetPortalAuditFeedOutput> {
  if (!ctx.identity.operator) {
    const err = new Error("operator_required");
    (err as Error & { status?: number }).status = 403;
    throw err;
  }
  const input = GetPortalAuditFeedInput.parse(rawInput);

  const cursorDate = input.cursor ? new Date(input.cursor) : null;
  const sinceDate = input.since ? new Date(input.since) : null;
  const untilDate = input.until ? new Date(input.until) : null;
  const fetchN = input.limit + 1;

  // Build the per-source filter. `at` carries the cursor (newest-first
  // pagination boundary) plus optional since/until window; `actorUserId`
  // and `event` add narrowing predicates.
  const baseFilter: Record<string, unknown> = {};
  const atCond: Record<string, Date> = {};
  if (cursorDate) atCond.$lt = cursorDate;
  if (untilDate && (!cursorDate || untilDate < cursorDate)) atCond.$lt = untilDate;
  if (sinceDate) atCond.$gte = sinceDate;
  if (Object.keys(atCond).length > 0) baseFilter.at = atCond;
  if (input.actorUserId) baseFilter.actorUserId = input.actorUserId;
  if (input.eventPrefix) {
    const escaped = input.eventPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    baseFilter.event = { $regex: `^${escaped}` };
  }

  const wantPortal = !input.source || input.source === "portal";
  const wantCompany = !input.source || input.source === "company";
  const wantWorkspace = !input.source || input.source === "workspace";

  // Each collection lives in a different DB on the same Mongo client.
  const companiesDb = wantCompany ? await getCompaniesDb(ctx.logger) : null;
  const workspacesDb = wantWorkspace ? await getWorkspacesDb(ctx.logger) : null;

  const portalP = wantPortal
    ? collections
        .portalAuditLog(ctx.db)
        .find(baseFilter)
        .sort({ at: -1 })
        .limit(fetchN)
        .toArray()
    : Promise.resolve([]);

  const companyP = companiesDb
    ? companiesDb
        .collection("company_audit_log")
        .find(baseFilter)
        .sort({ at: -1 })
        .limit(fetchN)
        .toArray()
    : Promise.resolve([]);

  const workspaceP = workspacesDb
    ? workspacesDb
        .collection("workspace_audit_log")
        .find(baseFilter)
        .sort({ at: -1 })
        .limit(fetchN)
        .toArray()
    : Promise.resolve([]);

  const [portalRows, companyRows, workspaceRows] = await Promise.all([
    portalP,
    companyP,
    workspaceP,
  ]);

  const normalized: PortalAuditEntryWire[] = [
    ...portalRows.map((r) => normalizeRow(r as unknown as RawAuditRow, "portal")),
    ...companyRows.map((r) => normalizeRow(r as unknown as RawAuditRow, "company")),
    ...workspaceRows.map((r) => normalizeRow(r as unknown as RawAuditRow, "workspace")),
  ];

  normalized.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

  const hasMore = normalized.length > input.limit;
  const trimmed = hasMore ? normalized.slice(0, input.limit) : normalized;

  // Deploy 5.15 — hydrate actor/company/workspace names in parallel so the
  // operator UI can render "Alex Morgan" instead of "usr_KV1im21A_b8OotEV".
  const [userMap, companyMap, workspaceMap] = await Promise.all([
    loadUserNames(
      ctx.db,
      trimmed.map((e) => e.actorUserId),
      ctx.logger,
    ),
    loadCompanyNames(
      trimmed.map((e) => e.companyId ?? null),
      ctx.logger,
    ),
    loadWorkspaceNames(
      trimmed.map((e) => e.workspaceId ?? null),
      ctx.logger,
    ),
  ]);
  for (const e of trimmed) {
    if (e.actorUserId) e.actorName = userMap.get(e.actorUserId) ?? null;
    if (e.companyId) e.companyName = companyMap.get(e.companyId) ?? null;
    if (e.workspaceId) e.workspaceName = workspaceMap.get(e.workspaceId) ?? null;
  }

  const nextCursor =
    hasMore && trimmed.length > 0 ? trimmed[trimmed.length - 1].at : null;

  return { entries: trimmed, nextCursor };
}

// ─── helpers ───────────────────────────────────────────────────────────────

interface RawAuditRow {
  at: Date | string;
  actorUserId: string | null;
  event: string;
  payload?: Record<string, unknown>;
  companyId?: string | null;
  workspaceId?: string | null;
}

function normalizeRow(r: RawAuditRow, source: AuditSource): PortalAuditEntryWire {
  const atIso = r.at instanceof Date ? r.at.toISOString() : String(r.at);
  const out: PortalAuditEntryWire = {
    at: atIso,
    source,
    actorUserId: r.actorUserId ?? null,
    event: r.event,
    payload: r.payload ?? {},
  };
  if (r.companyId !== undefined) out.companyId = r.companyId ?? null;
  if (r.workspaceId !== undefined) out.workspaceId = r.workspaceId ?? null;
  return out;
}
