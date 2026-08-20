// Offline de-duplication. The PWA queues mutating actions while offline and replays them on
// reconnect; a retry the server already applied must not apply twice — a rider added twice,
// an approval re-fired, a finisher recorded twice.
//
// The client has been sending `X-Client-Action-Id` on every mutation since long before this
// existed (podium-client/src/lib/api-client.ts), and its apiMutate already treats a 409 as
// success and reads `body.data` out of it as the action's result. This is the missing server
// half; the table it uses has been sitting unread since sql/006-client-actions.sql.
//
// Deliberately NOT applied to the three frozen Android endpoints: joining is already
// idempotent by upsert, and location ingest is idempotent by nature — replaying a batch
// rewrites the same points rather than creating anything.

import type { NextFunction, Request, Response } from "express";
import { execute, queryOne } from "../db/pool.js";
import { logger } from "../lib/logger.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface StoredAction {
  response_status: number | null;
  response_body: unknown;
}

/**
 * Claims the action id before the handler runs, then records what the handler answered so a
 * later replay can be given the same thing.
 *
 * The header is optional. A request without one behaves exactly as it did before — this is a
 * safety net the client opts into, not a requirement, and the Android app sends none.
 */
export async function deduplicateClientAction(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const clientActionId = req.header("X-Client-Action-Id");
  if (!clientActionId) {
    next();
    return;
  }

  // A malformed id is ignored rather than rejected: it cannot collide with a real one (the
  // column is UUID), and failing an otherwise-valid mutation over a bad header would turn a
  // client-side bug into a rider's lost action.
  if (!UUID_RE.test(clientActionId)) {
    logger.warn({ clientActionId }, "ignoring malformed X-Client-Action-Id");
    next();
    return;
  }

  let claimed: boolean;
  try {
    claimed =
      (await execute(
        `INSERT INTO client_actions (client_action_id, user_id, event_id, action_type)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (client_action_id) DO NOTHING`,
        [
          clientActionId,
          req.auth?.userId ?? null,
          typeof req.params.eventId === "string" ? req.params.eventId : null,
          `${req.method} ${req.route?.path ?? req.path}`.slice(0, 50),
        ],
      )) > 0;
  } catch (err) {
    // The de-dup table being unavailable must not take the API down with it. Losing
    // de-duplication degrades to the behaviour that shipped for months; failing the request
    // loses the rider's action outright.
    logger.error({ err, clientActionId }, "client action de-dup failed — allowing through");
    next();
    return;
  }

  if (!claimed) {
    const stored = await queryOne<StoredAction>(
      "SELECT response_status, response_body FROM client_actions WHERE client_action_id = $1",
      [clientActionId],
    ).catch(() => null);

    logger.info({ clientActionId, userId: req.auth?.userId }, "duplicate client action");
    // 409 either way. `data: null` covers the race where the original request is still in
    // flight and has not recorded its answer yet — the client treats 409 as success and can
    // refetch; it must not be told the action failed.
    res.status(409).json({
      error: "This action has already been applied",
      message: "This action has already been applied",
      code: "DUPLICATE_CLIENT_ACTION",
      data: (stored?.response_body as { data?: unknown } | null)?.data ?? null,
    });
    return;
  }

  // Capture whatever the handler answers, so a replay can be given the same body.
  let capturedBody: unknown;
  const originalJson = res.json.bind(res);
  res.json = (body: unknown) => {
    capturedBody = body;
    return originalJson(body);
  };

  res.on("finish", () => {
    // A failed action must be retryable, so the claim is released rather than kept — holding
    // it would make a transient 500 permanent for that action id.
    const settle =
      res.statusCode >= 400
        ? execute("DELETE FROM client_actions WHERE client_action_id = $1", [clientActionId])
        : execute(
            `UPDATE client_actions
                SET response_status = $2, response_body = $3::jsonb
              WHERE client_action_id = $1`,
            [
              clientActionId,
              res.statusCode,
              capturedBody === undefined ? null : JSON.stringify(capturedBody),
            ],
          );

    settle.catch((err: unknown) => {
      logger.error({ err, clientActionId }, "failed to record client action result");
    });
  });

  next();
}
