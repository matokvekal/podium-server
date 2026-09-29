// PROMOTE (sql/053) — who may switch it, and that it closes registration (only) while on.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api-error.js";

const selectUserEmails = vi.fn();
vi.mock("../queries/user.queries.js", () => ({
  selectUserEmails: (...a: unknown[]) => selectUserEmails(...a),
}));
vi.mock("../lib/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { assertRegistrationOpen, canManagePromote } = await import("./promote.js");

const OWNER = 7;
const promoted = { id: "e1", ownerId: OWNER, promoteOnly: true } as never;
const normal = { id: "e2", ownerId: OWNER, promoteOnly: false } as never;

beforeEach(() => selectUserEmails.mockReset());

describe("canManagePromote", () => {
  it("is true only for the System Admin", async () => {
    selectUserEmails.mockResolvedValue(["mictavim@gmail.com"]);
    expect(await canManagePromote(1)).toBe(true);
    selectUserEmails.mockResolvedValue(["rider@example.com"]);
    expect(await canManagePromote(2)).toBe(false);
  });

  it("is false for a guest without any lookup", async () => {
    expect(await canManagePromote(null)).toBe(false);
    expect(selectUserEmails).not.toHaveBeenCalled();
  });
});

describe("assertRegistrationOpen", () => {
  it("never touches a normal event", () => {
    expect(() => assertRegistrationOpen(normal)).not.toThrow();
  });

  it("refuses registration on a promoted event with 403 PROMOTE_REGISTRATION", () => {
    try {
      assertRegistrationOpen(promoted);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(403);
      expect((err as ApiError).message).toContain("PROMOTE_REGISTRATION");
    }
  });
});
