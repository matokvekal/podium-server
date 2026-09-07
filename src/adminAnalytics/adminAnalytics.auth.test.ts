import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api-error.js";

const selectUserEmails = vi.fn();
vi.mock("../queries/user.queries.js", () => ({
  selectUserEmails: (...a: unknown[]) => selectUserEmails(...a),
}));
vi.mock("../lib/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
// env.ADMIN_ANALYTICS_EMAILS defaults to ["mictavim@gmail.com"] (env.ts).

const { isAdminEmail, requireAdminAnalytics } = await import("./adminAnalytics.auth.js");

beforeEach(() => selectUserEmails.mockReset());

describe("isAdminEmail", () => {
  it("matches the configured admin, case- and whitespace-insensitively", () => {
    expect(isAdminEmail(["MicTavim@Gmail.com"])).toBe(true);
    expect(isAdminEmail(["  mictavim@gmail.com "])).toBe(true);
    expect(isAdminEmail(["someone@else.com", "mictavim@gmail.com"])).toBe(true);
  });

  it("rejects anyone else, and an account with no email at all", () => {
    expect(isAdminEmail(["someone@else.com"])).toBe(false);
    expect(isAdminEmail([])).toBe(false);
  });
});

describe("requireAdminAnalytics middleware", () => {
  function run(auth: { userId: number } | undefined) {
    const next = vi.fn();
    return requireAdminAnalytics({ auth } as never, {} as never, next).then(() => next);
  }

  it("passes the admin through with no error", async () => {
    selectUserEmails.mockResolvedValue(["mictavim@gmail.com"]);
    const next = await run({ userId: 1 });
    expect(next).toHaveBeenCalledWith();
  });

  it("403s an authenticated non-admin — and never a partial response", async () => {
    selectUserEmails.mockResolvedValue(["rider@example.com"]);
    const next = await run({ userId: 2 });
    const err = next.mock.calls[0][0] as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(403);
  });

  it("403s an account with no email", async () => {
    selectUserEmails.mockResolvedValue([]);
    const next = await run({ userId: 3 });
    expect((next.mock.calls[0][0] as ApiError).status).toBe(403);
  });

  it("401s if it somehow runs without an authenticated user", async () => {
    const next = await run(undefined);
    expect((next.mock.calls[0][0] as ApiError).status).toBe(401);
    expect(selectUserEmails).not.toHaveBeenCalled();
  });
});
