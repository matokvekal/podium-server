// PROMOTE (sql/053) — who may switch it and who may go past the card.
// The regression that matters most: a NORMAL event (promoteOnly false) must never cost a lookup
// or be refused, whoever is asking.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api-error.js";

const selectUserEmails = vi.fn();
vi.mock("../queries/user.queries.js", () => ({
  selectUserEmails: (...a: unknown[]) => selectUserEmails(...a),
}));
vi.mock("../lib/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { assertCanEnterPromoteEvent, canManagePromote } = await import("./promote.js");

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

describe("assertCanEnterPromoteEvent", () => {
  it("never touches a normal event — no lookup, no refusal, for anyone", async () => {
    await expect(assertCanEnterPromoteEvent(normal, 99)).resolves.toBeUndefined();
    await expect(assertCanEnterPromoteEvent(normal, null)).resolves.toBeUndefined();
    expect(selectUserEmails).not.toHaveBeenCalled();
  });

  it("refuses a normal user and a guest on a promoted event with 403 PROMOTE_LOCKED", async () => {
    selectUserEmails.mockResolvedValue(["rider@example.com"]);
    const err = await assertCanEnterPromoteEvent(promoted, 99).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(403);
    expect((err as ApiError).message).toContain("PROMOTE_LOCKED");
    await expect(assertCanEnterPromoteEvent(promoted, null)).rejects.toBeInstanceOf(ApiError);
  });

  it("lets the System Admin and the owner through", async () => {
    selectUserEmails.mockResolvedValue(["mictavim@gmail.com"]);
    await expect(assertCanEnterPromoteEvent(promoted, 1)).resolves.toBeUndefined();
    await expect(assertCanEnterPromoteEvent(promoted, OWNER)).resolves.toBeUndefined();
  });
});
