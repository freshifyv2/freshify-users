/**
 * Operator assignments — collection helpers for the operator_assignments collection.
 *
 * An operator assignment marks a user as a Freshify operator (staff or buyer
 * ops team). Operator status is checked at JWT issuance time and propagated
 * into the session token so every downstream request carries the operator
 * identity without a DB round-trip.
 *
 * Schema:
 *   { userId: string, reason: OperatorReason, createdAt: Date }
 */
import type { Db, Collection } from "mongodb";
import type { OperatorReason } from "./vendor/authz";

export interface OperatorAssignmentDoc {
  userId: string;
  reason: OperatorReason;
  createdAt: Date;
}

function operatorAssignments(db: Db): Collection<OperatorAssignmentDoc> {
  return db.collection<OperatorAssignmentDoc>("operator_assignments");
}

/**
 * Returns the operator assignment for the given userId, or null if the user
 * is not an operator.
 */
export async function getOperatorAssignment(
  db: Db,
  userId: string,
): Promise<OperatorAssignmentDoc | null> {
  return operatorAssignments(db).findOne({ userId });
}

/**
 * Creates or updates an operator assignment.
 * Idempotent — safe to call repeatedly for the same userId.
 */
export async function upsertOperatorAssignment(
  db: Db,
  userId: string,
  reason: OperatorReason,
): Promise<void> {
  await operatorAssignments(db).updateOne(
    { userId },
    {
      $set: { reason },
      $setOnInsert: { userId, createdAt: new Date() },
    },
    { upsert: true },
  );
}
