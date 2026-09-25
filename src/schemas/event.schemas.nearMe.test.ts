// "Near me" query params on GET /events/public — nearLat/nearLon/nearRadiusKm and the
// "near_me" sort value. See selectPublicEvents (event.queries.ts) for how they're used.

import { describe, expect, it } from "vitest";
import { publicEventsQuerySchema } from "./event.schemas.js";

describe("publicEventsQuerySchema — near me", () => {
  it("accepts valid lat/lon/radius, coerced from query-string values", () => {
    const parsed = publicEventsQuerySchema.safeParse({
      nearLat: "32.05",
      nearLon: "34.78",
      nearRadiusKm: "10",
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.nearLat).toBe(32.05);
    expect(parsed.data?.nearLon).toBe(34.78);
    expect(parsed.data?.nearRadiusKm).toBe(10);
  });

  it("is optional — a request with none of the three is valid", () => {
    const parsed = publicEventsQuerySchema.safeParse({});
    expect(parsed.success).toBe(true);
    expect(parsed.data?.nearLat).toBeUndefined();
    expect(parsed.data?.nearLon).toBeUndefined();
    expect(parsed.data?.nearRadiusKm).toBeUndefined();
  });

  it("rejects an out-of-range latitude/longitude", () => {
    expect(publicEventsQuerySchema.safeParse({ nearLat: "91" }).success).toBe(false);
    expect(publicEventsQuerySchema.safeParse({ nearLat: "-91" }).success).toBe(false);
    expect(publicEventsQuerySchema.safeParse({ nearLon: "181" }).success).toBe(false);
    expect(publicEventsQuerySchema.safeParse({ nearLon: "-181" }).success).toBe(false);
  });

  it("rejects a non-positive or absurd radius", () => {
    expect(publicEventsQuerySchema.safeParse({ nearRadiusKm: "0" }).success).toBe(false);
    expect(publicEventsQuerySchema.safeParse({ nearRadiusKm: "-5" }).success).toBe(false);
    expect(publicEventsQuerySchema.safeParse({ nearRadiusKm: "501" }).success).toBe(false);
  });

  it('accepts "near_me" as a sort value', () => {
    const parsed = publicEventsQuerySchema.safeParse({ sort: "near_me" });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.sort).toBe("near_me");
  });
});
