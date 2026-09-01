// The per-ride contact fields are the only place in the event schemas where the input is
// normalised rather than just validated, so the normalisation is pinned here: an organizer who
// clears a field must end up with NULL in the column, not an empty string that makes the ride
// page render an empty "Contact organizer" block.

import { describe, expect, it } from "vitest";
import { createEventSchema, updateEventSchema } from "./event.schemas.js";

const base = {
  name: "Saturday ride",
  type: "RIDE" as const,
};

function parseCreate(extra: Record<string, unknown>) {
  return createEventSchema.parse({ ...base, ...extra });
}

describe("event contact fields", () => {
  it("keeps what the organizer typed", () => {
    const out = parseCreate({ contactPhone: "050-1234567", contactEmail: "ride@example.com" });
    expect(out.contactPhone).toBe("050-1234567");
    expect(out.contactEmail).toBe("ride@example.com");
  });

  it("normalises a cleared field to null, not an empty string", () => {
    const out = parseCreate({ contactPhone: "", contactEmail: "" });
    expect(out.contactPhone).toBeNull();
    expect(out.contactEmail).toBeNull();
  });

  it("treats whitespace-only as cleared", () => {
    const out = parseCreate({ contactPhone: "   ", contactEmail: "  " });
    expect(out.contactPhone).toBeNull();
    expect(out.contactEmail).toBeNull();
  });

  it("trims surrounding space and lowercases the address", () => {
    const out = parseCreate({ contactPhone: "  050 123 4567 ", contactEmail: " Ride@Example.COM " });
    expect(out.contactPhone).toBe("050 123 4567");
    expect(out.contactEmail).toBe("ride@example.com");
  });

  it("accepts an explicit null — the organizer stopping publication", () => {
    const out = parseCreate({ contactPhone: null, contactEmail: null });
    expect(out.contactPhone).toBeNull();
    expect(out.contactEmail).toBeNull();
  });

  it("leaves the stored value alone when the field is omitted", () => {
    const out = parseCreate({});
    expect(out.contactPhone).toBeUndefined();
    expect(out.contactEmail).toBeUndefined();
  });

  it("rejects an address that is not an address", () => {
    expect(() => parseCreate({ contactEmail: "not-an-email" })).toThrow();
    expect(() => parseCreate({ contactEmail: "a@b" })).toThrow();
  });

  it("leaves the phone free-form — international, a second number, 'WhatsApp only'", () => {
    // Deliberately NOT validated as a phone number: every rule that looks reasonable rejects a
    // real number somebody actually uses.
    expect(parseCreate({ contactPhone: "+972 50-123-4567 (WhatsApp only)" }).contactPhone).toBe(
      "+972 50-123-4567 (WhatsApp only)",
    );
  });

  it("applies the same rules on edit", () => {
    expect(updateEventSchema.parse({ contactPhone: "" }).contactPhone).toBeNull();
    expect(updateEventSchema.parse({ contactEmail: " A@B.com " }).contactEmail).toBe("a@b.com");
    expect(() => updateEventSchema.parse({ contactEmail: "nope" })).toThrow();
  });

  it("enforces the column widths", () => {
    expect(() => parseCreate({ contactPhone: "9".repeat(101) })).toThrow();
    expect(() => parseCreate({ contactEmail: `${"a".repeat(250)}@example.com` })).toThrow();
  });
});
