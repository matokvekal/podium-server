// Organizer display name (events.organizer_group, sql/010) and the PROMOTE registration text
// (events.promote_registration_message, sql/055) at the request boundary.
//
//   - a blank value is normalised to null, so "cleared" and "never set" are the same thing
//   - null CLEARS, ABSENT KEEPS (undefined survives as undefined)
//   - neither field can ever carry ownership: there is no ownerId key to send

import { describe, expect, it } from "vitest";
import { createEventSchema, updateEventSchema } from "./event.schemas.js";

const base = { name: "Ride", startsAt: "2026-10-01T04:00:00.000Z" };

describe("organizerGroup (Organizer display name)", () => {
  it("is trimmed and kept", () => {
    const parsed = updateEventSchema.parse({
      organizerGroup: "  רוכבים בתקווה - עיריית פתח תקווה ",
    });
    expect(parsed.organizerGroup).toBe("רוכבים בתקווה - עיריית פתח תקווה");
  });

  it("blank / whitespace becomes null (= show the creator's own name)", () => {
    expect(updateEventSchema.parse({ organizerGroup: "" }).organizerGroup).toBeNull();
    expect(updateEventSchema.parse({ organizerGroup: "   " }).organizerGroup).toBeNull();
    expect(updateEventSchema.parse({ organizerGroup: null }).organizerGroup).toBeNull();
  });

  it("absent stays undefined so an edit that never mentions it keeps the stored value", () => {
    expect(updateEventSchema.parse({ name: "x" }).organizerGroup).toBeUndefined();
    expect(createEventSchema.parse(base).organizerGroup).toBeUndefined();
  });

  it("is bounded to the column width", () => {
    expect(updateEventSchema.safeParse({ organizerGroup: "x".repeat(201) }).success).toBe(false);
  });

  it("cannot transfer ownership: an ownerId in the body is stripped", () => {
    const parsed = updateEventSchema.parse({ organizerGroup: "Club", ownerId: 5 });
    expect("ownerId" in parsed).toBe(false);
  });
});

describe("promoteRegistrationMessage", () => {
  const text = "Registration is through Petah Tikva Municipality:\nhttps://example.com/register";

  it("accepts multi-line text on create and update", () => {
    expect(createEventSchema.parse({ ...base, promoteRegistrationMessage: text })).toMatchObject({
      promoteRegistrationMessage: text,
    });
    expect(updateEventSchema.parse({ promoteRegistrationMessage: text })).toMatchObject({
      promoteRegistrationMessage: text,
    });
  });

  it("blank becomes null (= default message); absent stays undefined", () => {
    const blank = updateEventSchema.parse({ promoteRegistrationMessage: "  " });
    expect(blank.promoteRegistrationMessage).toBeNull();
    const nulled = updateEventSchema.parse({ promoteRegistrationMessage: null });
    expect(nulled.promoteRegistrationMessage).toBeNull();
    expect(updateEventSchema.parse({}).promoteRegistrationMessage).toBeUndefined();
  });

  it("is bounded", () => {
    const tooLong = updateEventSchema.safeParse({ promoteRegistrationMessage: "x".repeat(1001) });
    expect(tooLong.success).toBe(false);
  });
});
