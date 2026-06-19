/**
 * Event publisher.
 *
 * v0.1 ships a structured-log publisher: every emit() writes a JSON line
 * with the event name, payload, identity context, and an idempotent eventId.
 * The framework's event bus (v0.2) will subscribe to these logs and fan out
 * to subscribers. For now, sibling modules (Companies, Workspaces) consume
 * via an HTTP webhook the framework wires up at deploy time.
 *
 * This keeps v0.1 portable — no Kafka/PubSub/Redis dependency required to
 * stand the portal up.
 */
import { randomBytes } from "node:crypto";
import type { Logger } from "pino";
import type { IdentityContext, ModuleEvent } from "../vendor/authz";

export function newEventId(): string {
  return `evt_${randomBytes(12).toString("base64url")}`;
}

export interface Publisher {
  emit<T>(input: {
    name: string;
    payload: T;
    identity: IdentityContext;
  }): Promise<void>;
}

export function createPublisher(logger: Logger): Publisher {
  return {
    async emit({ name, payload, identity }) {
      const event: ModuleEvent<unknown> = {
        name,
        payload,
        emittedBy: identity,
        emittedAt: new Date().toISOString(),
        eventId: newEventId(),
      };
      logger.info({ event }, `event ${name}`);
      // v0.2: also POST to subscriber URLs from the framework's registry.
    },
  };
}

/** A system IdentityContext for events emitted without a user (e.g. cron). */
export function systemIdentity(): IdentityContext {
  return {
    user: {
      userId: "system",
      email: "system@freshify.io",
      displayName: "system",
    },
    company: null,
    workspace: null,
    operator: null,
    roles: [{ layer: "company", role: "system" }],
  };
}
