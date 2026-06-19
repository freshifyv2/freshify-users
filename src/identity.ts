/**
 * Identity resolution — JWT issuance, verification, and Express middleware
 * that produces an IdentityContext on every request.
 *
 * The JWT carries: userId, companyId (the currently-acting company), an
 * array of role assignments, and optionally an operator claim.
 * The framework's loader will use the same pattern: read a session token
 * from a header, resolve to IdentityContext, pass to every module function.
 */
import { createHash, randomBytes } from "node:crypto";
import jwt, { type JwtPayload } from "jsonwebtoken";
import type { Request, Response, NextFunction, RequestHandler } from "express";
import type {
  IdentityContext,
  UserIdentity,
  CompanyIdentity,
  WorkspaceIdentity,
  RoleAssignment,
  OperatorReason,
} from "./vendor/authz";

const JWT_ALG = "HS256";
const SESSION_TTL_SEC = 60 * 60 * 24 * 30; // 30 days

interface SessionClaims extends JwtPayload {
  userId: string;
  email: string;
  displayName: string;
  companyId: string | null;
  companyName: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
  roles: RoleAssignment[];
  /** Operator identity — present when the caller is a Freshify operator. */
  operator?: { operatorId: string; reason: OperatorReason } | null;
}

function getSecret(): string {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error("JWT_SECRET not set — service is not configured");
  if (s.length < 32) throw new Error("JWT_SECRET must be at least 32 chars");
  return s;
}

export function issueSessionToken(input: {
  userId: string;
  email: string;
  displayName: string;
  companyId: string | null;
  companyName: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
  roles: RoleAssignment[];
  /** Optional operator claim. Pass null or omit when the user is not an operator. */
  operator?: { operatorId: string; reason: OperatorReason } | null;
}): { token: string; tokenHash: string; expiresAt: Date } {
  const payload: SessionClaims = {
    userId: input.userId,
    email: input.email,
    displayName: input.displayName,
    companyId: input.companyId,
    companyName: input.companyName,
    workspaceId: input.workspaceId,
    workspaceName: input.workspaceName,
    roles: input.roles,
    operator: input.operator ?? null,
  };

  const token = jwt.sign(payload, getSecret(), {
    algorithm: JWT_ALG,
    expiresIn: SESSION_TTL_SEC,
    issuer: "freshify-users",
    audience: "sovereign-portal",
  });
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_SEC * 1000);
  return { token, tokenHash, expiresAt };
}

export function verifySessionToken(token: string): SessionClaims {
  return jwt.verify(token, getSecret(), {
    algorithms: [JWT_ALG],
    issuer: "freshify-users",
    audience: "sovereign-portal",
  }) as SessionClaims;
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("base64url")}`;
}

declare module "express-serve-static-core" {
  interface Request {
    identity?: IdentityContext;
  }
}

/**
 * Middleware that resolves an IdentityContext from the Authorization header.
 *
 * If no token is present, the request continues without identity (handlers
 * decide whether to require it). If a token is present but invalid, the
 * request is rejected with 401.
 */
export function identityMiddleware(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const auth = req.header("authorization");
    if (!auth) return next();

    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (!m) {
      res.status(401).json({ error: "invalid_authorization_header" });
      return;
    }

    try {
      const claims = verifySessionToken(m[1]);
      const user: UserIdentity = {
        userId: claims.userId,
        email: claims.email,
        displayName: claims.displayName,
      };
      const company: CompanyIdentity | null = claims.companyId
        ? { companyId: claims.companyId, name: claims.companyName ?? "" }
        : null;
      const workspace: WorkspaceIdentity | null = claims.workspaceId
        ? {
            workspaceId: claims.workspaceId,
            companyId: claims.companyId ?? "",
            name: claims.workspaceName ?? "",
          }
        : null;

      // Hydrate operator identity from JWT claims
      const operatorClaim = claims.operator;
      const operator = operatorClaim
        ? { operatorId: operatorClaim.operatorId, reason: operatorClaim.reason }
        : null;

      req.identity = {
        user,
        company,
        workspace,
        operator,
        roles: claims.roles,
      };
      next();
    } catch (err) {
      res.status(401).json({ error: "invalid_token", reason: (err as Error).message });
    }
  };
}

/** Require an authenticated user. Use as middleware on protected routes. */
export function requireUser(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.identity?.user) {
      res.status(401).json({ error: "authentication_required" });
      return;
    }
    next();
  };
}

/** Require the caller to be a Freshify operator. Returns 403 otherwise. */
export function requireOperator(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.identity?.user) {
      res.status(401).json({ error: "authentication_required" });
      return;
    }
    if (!req.identity.operator) {
      res.status(403).json({ error: "operator_required" });
      return;
    }
    next();
  };
}

/** Returns true if the given identity carries a valid operator claim. */
export function isOperator(identity: IdentityContext): boolean {
  return identity.operator !== null && identity.operator !== undefined;
}

/** Require a specific role at a layer. */
export function requireRole(
  layer: RoleAssignment["layer"],
  role: string,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.identity?.user) {
      res.status(401).json({ error: "authentication_required" });
      return;
    }
    const has = req.identity.roles.some((r) => r.layer === layer && r.role === role);
    if (!has) {
      res.status(403).json({ error: "forbidden", required: `${layer}:${role}` });
      return;
    }
    next();
  };
}
