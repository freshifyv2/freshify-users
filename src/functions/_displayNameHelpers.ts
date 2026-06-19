/**
 * Shared helpers for hydrating display names on operator-facing list endpoints
 * (Deploy 5.15). Keeps "show name not ID" logic in one place so audit feed and
 * invites list stay consistent.
 *
 * Each helper:
 *   - takes a list of IDs and returns Map<id, name>
 *   - falls back to the ID when the name is missing/blank, so callers can
 *     always render `nameMap.get(id) ?? id` without an extra null check
 *   - never throws — failures degrade to an empty map so the list still loads
 */
import type { Db } from "mongodb";
import type { Logger } from "pino";
import { collections } from "../mongo";
import { getCompaniesDb, getWorkspacesDb } from "../mongo";

const uniq = (ids: Array<string | null | undefined>): string[] =>
  Array.from(new Set(ids.filter((x): x is string => !!x)));

export async function loadUserNames(
  db: Db,
  ids: Array<string | null | undefined>,
  logger: Logger,
): Promise<Map<string, string>> {
  const list = uniq(ids);
  const out = new Map<string, string>();
  if (list.length === 0) return out;
  try {
    const rows = await collections
      .users(db)
      .find({ userId: { $in: list } })
      .project<{ userId: string; displayName: string | null; email: string }>({
        userId: 1,
        displayName: 1,
        email: 1,
      })
      .toArray();
    for (const r of rows) {
      const name =
        (r.displayName && r.displayName.trim()) || r.email || r.userId;
      out.set(r.userId, name);
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "loadUserNames: lookup failed",
    );
  }
  return out;
}

export async function loadCompanyNames(
  ids: Array<string | null | undefined>,
  logger: Logger,
): Promise<Map<string, string>> {
  const list = uniq(ids);
  const out = new Map<string, string>();
  if (list.length === 0) return out;
  try {
    const cdb = await getCompaniesDb(logger);
    const rows = await cdb
      .collection("companies")
      .find({ companyId: { $in: list } })
      .project<{ companyId: string; name: string | null }>({
        companyId: 1,
        name: 1,
      })
      .toArray();
    for (const r of rows) {
      if (r.name && r.name.trim()) out.set(r.companyId, r.name);
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "loadCompanyNames: lookup failed",
    );
  }
  return out;
}

export async function loadWorkspaceNames(
  ids: Array<string | null | undefined>,
  logger: Logger,
): Promise<Map<string, string>> {
  const list = uniq(ids);
  const out = new Map<string, string>();
  if (list.length === 0) return out;
  try {
    const wdb = await getWorkspacesDb(logger);
    const rows = await wdb
      .collection("workspaces")
      .find({ workspaceId: { $in: list } })
      .project<{ workspaceId: string; name: string | null }>({
        workspaceId: 1,
        name: 1,
      })
      .toArray();
    for (const r of rows) {
      if (r.name && r.name.trim()) out.set(r.workspaceId, r.name);
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "loadWorkspaceNames: lookup failed",
    );
  }
  return out;
}
