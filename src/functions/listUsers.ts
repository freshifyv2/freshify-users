/**
 * listUsers — paginated list of users in the caller's current company.
 *
 * Authenticated; restricted to the active company (req.identity.company).
 * Joins users + memberships so the caller sees each user's role within
 * the company.
 */
import type { Db } from "mongodb";
import { ListUsersInput, ListUsersOutput } from "../schemas";
import { collections } from "../mongo";
import type { IdentityContext } from "../vendor/authz";

export async function listUsers(
  rawInput: unknown,
  ctx: { db: Db; identity: IdentityContext },
): Promise<ListUsersOutput> {
  const input = ListUsersInput.parse(rawInput);

  if (!ctx.identity.company) {
    const err = new Error("company_context_required");
    (err as Error & { status?: number }).status = 400;
    throw err;
  }

  const companyId = ctx.identity.company.companyId;

  const filter: Record<string, unknown> = { companyId };
  if (input.cursor) {
    filter.userId = { $gt: input.cursor };
  }

  const memberships = await collections
    .memberships(ctx.db)
    .find(filter)
    .sort({ userId: 1 })
    .limit(input.limit + 1)
    .toArray();

  const hasMore = memberships.length > input.limit;
  const page = hasMore ? memberships.slice(0, input.limit) : memberships;
  const userIds = page.map((m) => m.userId);

  const users = await collections
    .users(ctx.db)
    .find({ userId: { $in: userIds } })
    .toArray();
  const byId = new Map(users.map((u) => [u.userId, u]));

  return ListUsersOutput.parse({
    users: page
      .map((m) => {
        const u = byId.get(m.userId);
        if (!u) return null;
        return {
          userId: u.userId,
          email: u.email,
          displayName: u.displayName,
          status: u.status,
          role: m.role,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null),
    nextCursor: hasMore ? page[page.length - 1].userId : null,
  });
}
