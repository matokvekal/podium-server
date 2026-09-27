// resolveProfileImagesDir is the exact function that used to call process.exit(1) in production
// when PROFILE_IMAGES_DIR was unset — the cause of the outage this file guards against. It is a
// plain function of its two inputs (config/env.ts exports it for exactly this reason), so every
// combination is directly testable with no module reload and no real process.env mutation.

import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveProfileImagesDir } from "./env.js";

describe("resolveProfileImagesDir", () => {
  it("never throws and never calls process.exit, for any input", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit was called");
    });
    try {
      expect(() => resolveProfileImagesDir(undefined, "production")).not.toThrow();
      expect(() => resolveProfileImagesDir("", "production")).not.toThrow();
      expect(() => resolveProfileImagesDir("   ", "production")).not.toThrow();
      expect(() =>
        resolveProfileImagesDir("/var/lib/podium/profile-images", "production"),
      ).not.toThrow();
      expect(() => resolveProfileImagesDir(undefined, "development")).not.toThrow();
      expect(() => resolveProfileImagesDir(undefined, "test")).not.toThrow();
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("production + unset → disabled (null), not fatal", () => {
    expect(resolveProfileImagesDir(undefined, "production")).toBeNull();
    expect(resolveProfileImagesDir("", "production")).toBeNull();
    expect(resolveProfileImagesDir("   ", "production")).toBeNull();
  });

  it("production + unset → logs one clear warning, not an error", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      resolveProfileImagesDir(undefined, "production");
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain("PROFILE_IMAGES_DIR");
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("production + a configured value → resolved, absolute, and used", () => {
    const resolved = resolveProfileImagesDir("/var/lib/podium/profile-images", "production");
    expect(resolved).toBe(path.resolve("/var/lib/podium/profile-images"));
  });

  it("production + a RELATIVE configured value still resolves, does not reject it", () => {
    // Not the recommended shape (an operator should use an absolute path), but a relative one
    // must still start the server — the whole point of this fix is "never fatal for this var".
    const resolved = resolveProfileImagesDir("some/relative/path", "production");
    expect(resolved).toBe(path.resolve("some/relative/path"));
  });

  it("development + unset → the repo-adjacent default (unchanged behavior)", () => {
    const resolved = resolveProfileImagesDir(undefined, "development");
    expect(resolved).toBe(path.resolve(process.cwd(), "../images/PUBLIC-APP-IMAGES"));
  });

  it("test + unset → the same repo-adjacent default as development", () => {
    const resolved = resolveProfileImagesDir(undefined, "test");
    expect(resolved).toBe(path.resolve(process.cwd(), "../images/PUBLIC-APP-IMAGES"));
  });

  it("a configured value wins in every NODE_ENV, dev/test included", () => {
    expect(resolveProfileImagesDir("/custom/dir", "development")).toBe(path.resolve("/custom/dir"));
    expect(resolveProfileImagesDir("/custom/dir", "test")).toBe(path.resolve("/custom/dir"));
  });
});
