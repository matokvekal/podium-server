import { z } from "zod";

export const participantsEventIdParamSchema = z.object({
  eventId: z.string().uuid(),
});

export const participantIdParamSchema = z.object({
  eventId: z.string().uuid(),
  participantId: z.coerce.number().int().positive(),
});

export const addParticipantSchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email().max(255).optional(),
  phone: z.string().max(100).optional(),
  category: z.string().max(80).optional(),
  bib: z.string().max(16).optional(),
});

export const updateParticipantSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  email: z.string().email().max(255).optional(),
  phone: z.string().max(100).optional(),
  category: z.string().max(80).optional(),
  bib: z.string().max(16).optional(),
});
