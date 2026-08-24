// Audit records for business/security actions — deliberately separate from the technical
// request logging around it, per TODO-install-server.md §13.
//
// Today an audit record is a structured pino line carrying exactly the fields §13 asks for
// (actor, action, entity, entityId, timestamp, requestId, metadata). There is no audit_log
// table yet, and creating one is not this task's job.
//
// The point of routing every call through this one function is that adding that table later
// is a change INSIDE here — one insert alongside the log line — and not a single call site
// moves. That is also why `audit` takes a Request: the requestId that correlates an audit
// record with the technical log is already on it, and no caller should have to remember to
// pass it.
//
// What never goes in: image bytes, tokens, credentials, and absolute filesystem paths. The
// relative "users/12/avatar-….webp" reference is fine — it is already a public URL tail.

import type { Request } from "express";
import { logger } from "./logger.js";

export const AUDIT_ACTIONS = {
  USER_AVATAR_CHANGED: "USER_AVATAR_CHANGED",
  USER_COVER_CHANGED: "USER_COVER_CHANGED",
  USER_AVATAR_RESET: "USER_AVATAR_RESET",
  USER_COVER_RESET: "USER_COVER_RESET",
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export interface AuditDetails {
  /** The kind of thing acted on — "user" here; "event", "participant" later. */
  entity: string;
  entityId: string | number;
  /** Small, non-sensitive facts about what changed. */
  meta?: Record<string, string | number | boolean | null>;
}

export function audit(req: Request, action: AuditAction, details: AuditDetails): void {
  logger.info(
    {
      audit: action,
      actorId: req.auth?.userId ?? null,
      entity: details.entity,
      entityId: String(details.entityId),
      requestId: req.id ? String(req.id) : null,
      ...details.meta,
    },
    action,
  );
}
