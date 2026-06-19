/**
 * getUser — fetch a single user by id, scoped to the caller's company.
 *
 * Authenticated. The target user must share a company-membership with the
 * caller — otherwise return 404 (not 403, to avoid leaking that the user exists).
 */
import type { Db } from "mongodb";
import { GetUserInput, GetUserOutput } from "../schemas";
import { collections } from "../mongo";
import type { IdentityContext } from "../vendor/authz";

export async function getUser(
  rawInput: unknown,
  ctx: { db: Db; identity: IdentityContext },
): Promise<GetUserOutput> {
  const input = GetUserInput.parse(rawInput);

  if (!ctx.identity.company) {
    const err = new Error("company_context_required");
    (err as Error & { status?: number }).status = 400;
    throw err;
  }

  // A caller asking about themselves is always allowed.
  const isSelf = ctx.identity.user.userId === input.userId;

  if (!isSelf) {
    const membership = await collections.memberships(ctx.db).findOne({
      userId: input.userId,
      companyId: ctx.identity.company.companyId,
    });
    if (!membership) {
      const err = new Error("user_not_found");
      (err as Error & { status?: number }).status = 404;
      throw err;
    }
  }

  const user = await collections.users(ctx.db).findOne({ userId: input.userId });
  if (!user) {
    const err = new Error("user_not_found");
    (err as Error & { status?: number }).status = 404;
    throw err;
  }

  return GetUserOutput.parse({
    userId: user.userId,
    email: user.email,
    displayName: user.displayName,
    phoneE164: user.phoneE164,
    status: user.status,
  });
}
