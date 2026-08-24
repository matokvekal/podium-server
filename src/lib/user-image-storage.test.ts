import { describe, expect, it } from "vitest";
import { env } from "../config/env.js";
import { resolveUploadPath, uploadPublicUrl } from "./user-image-storage.js";

describe("resolveUploadPath — nothing escapes the upload root", () => {
  it("resolves a reference we generated", () => {
    const resolved = resolveUploadPath("users/12/avatar-9f3a.webp");
    expect(resolved.startsWith(env.UPLOADS_DIR)).toBe(true);
  });

  // No client string reaches this function today. These are the second lock: if a traversal
  // value ever did land in the column, it must fail here rather than delete or serve a file
  // somewhere else on the disk.
  it.each([
    "../../etc/passwd",
    "users/../../../etc/passwd",
    "users/12/../../../../windows/system32/config/sam",
    "/etc/passwd",
    "..",
  ])("refuses %s", (ref) => {
    expect(() => resolveUploadPath(ref)).toThrow(/escapes the upload root/);
  });
});

describe("uploadPublicUrl", () => {
  it("is absolute, because the client is served from a different host than the API", () => {
    const url = uploadPublicUrl("users/12/avatar-9f3a.webp");
    expect(url).toBe(`${env.PUBLIC_BASE_URL}/uploads/users/12/avatar-9f3a.webp`);
    expect(url.startsWith("http")).toBe(true);
  });
});
