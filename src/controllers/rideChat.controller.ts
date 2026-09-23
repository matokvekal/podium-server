// Controllers for the RIDE CHAT — /api/v1/events/:eventId/chat and /api/v1/events/chat/unread.
// Thin: parse, hand to rideChat.service.ts (which does the authorization), serialise.

import type { NextFunction, Request, Response } from "express";
import { traceLog } from "../lib/trace-log.js";
import { eventIdParamSchema } from "../schemas/event.schemas.js";
import {
  rideChatListQuerySchema,
  rideChatSendSchema,
  rideChatUnreadQuerySchema,
} from "../schemas/rideChat.schemas.js";
import {
  listRideChat,
  RIDE_CHAT_LIMITS,
  sendRideChat,
  summarizeRideChats,
} from "../services/rideChat.service.js";

// GET /api/v1/events/:eventId/chat[?afterId=N]
export async function listRideChatController(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventId } = eventIdParamSchema.parse(req.params);
    const { afterId } = rideChatListQuerySchema.parse(req.query);
    traceLog("rideChat.controller.listRideChatController", { eventId, afterId });
    const messages = await listRideChat(eventId, req.auth!.userId, afterId ?? null);
    res.status(200).json({ data: { messages, limits: RIDE_CHAT_LIMITS } });
  } catch (err) {
    next(err);
  }
}

// POST /api/v1/events/:eventId/chat   { text }
export async function sendRideChatController(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventId } = eventIdParamSchema.parse(req.params);
    const { text } = rideChatSendSchema.parse(req.body);
    traceLog("rideChat.controller.sendRideChatController", { eventId, length: text.length });
    const message = await sendRideChat(eventId, req.auth!.userId, text);
    res.status(201).json({ data: message });
  } catch (err) {
    next(err);
  }
}

// GET /api/v1/events/chat/unread?rides=<rideId>:<lastReadId>,...
export async function rideChatUnreadController(req: Request, res: Response, next: NextFunction) {
  try {
    const { rides } = rideChatUnreadQuerySchema.parse(req.query);
    traceLog("rideChat.controller.rideChatUnreadController", { rides: rides.length });
    const summaries = await summarizeRideChats(req.auth!.userId, rides);
    res.status(200).json({ data: summaries });
  } catch (err) {
    next(err);
  }
}
