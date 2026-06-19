/**
 * revokeInvitesBatchV3 — operator bulk-revokes pending portal invites
 * (Deploy 5.4).
 *
 * Mirrors the workspaces-fe batch-approve / batch-decline shape: takes
 * { inviteIds: string[] }, iterates, returns per-invite results so the UI
 * can surface partial failures rather than aborting on the first error.
 *
 * Each successful revoke emits portal.invite_revoked (via the single-
 * invite path). Already-revoked invites are treated as success
 * (idempotent). Accepted invites are reported as failed.
 */
import type { Db } from "mongodb";
import type { Logger } from "pino";
import type { IdentityContext } from "../vendor/authz";
import { revokeInviteV3 } from "./revokeInviteV3";

interface BatchInput {
  inviteIds: string[];
}

export interface BatchResultEntry {
  inviteId: string;
  ok: boolean;
  status?: "revoked" | "already_revoked";
  error?: string;
}

export interface BatchOutput {
  requested: number;
  revoked: number;
  alreadyRevoked: number;
  failed: number;
  results: BatchResultEntry[];
}

const MAX_BATCH = 100;

export async function revokeInvitesBatchV3(
  rawInput: unknown,
  ctx: { db: Db; logger: Logger; identity: IdentityContext },
): Promise<BatchOutput> {
  if (!ctx.identity.operator) {
    const err = new Error("operator_only");
    (err as Error & { status?: number }).status = 403;
    throw err;
  }

  const input = (rawInput ?? {}) as BatchInput;
  const ids = Array.isArray(input.inviteIds)
    ? input.inviteIds.filter((x): x is string => typeof x === "string" && x.length > 0)
    : [];

  if (ids.length === 0) {
    const err = new Error("inviteIds required");
    (err as Error & { status?: number }).status = 400;
    throw err;
  }
  if (ids.length > MAX_BATCH) {
    const err = new Error(`batch size exceeds ${MAX_BATCH}`);
    (err as Error & { status?: number }).status = 400;
    throw err;
  }

  const results: BatchResultEntry[] = [];
  let revoked = 0;
  let alreadyRevoked = 0;
  let failed = 0;
  for (const inviteId of ids) {
    try {
      const out = await revokeInviteV3({ inviteId }, ctx);
      results.push({ inviteId, ok: true, status: out.status });
      if (out.status === "revoked") revoked++;
      else alreadyRevoked++;
    } catch (err) {
      results.push({ inviteId, ok: false, error: (err as Error).message });
      failed++;
    }
  }

  return {
    requested: ids.length,
    revoked,
    alreadyRevoked,
    failed,
    results,
  };
}
