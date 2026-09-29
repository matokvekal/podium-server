// The ride-image catalog is PUBLIC: an anonymous visitor sees public rides, and each card resolves
// its rideImageKey through GET /api/v1/ride-images. Before this was public, an uploaded cover
// (which has no compiled fallback) silently fell back to the default image for logged-out users.
//
// Flow pinned here, all without a token:
//   public event carries an uploaded rideImageKey  ->  anonymous catalog lists that key
//   -> its url is fetchable anonymously  (and an ARCHIVED / disabled key still resolves)
// and the admin write endpoints stay closed.
// The catalog service is stubbed (this repo has no test DB); the router, controller DTO and the
// static file mount are the real ones.

import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { beforeAll, describe, expect, it, vi } from "vitest";

const uploadDir = vi.hoisted(() => {
  const nodeFs = require("node:fs") as typeof import("node:fs");
  const nodeOs = require("node:os") as typeof import("node:os");
  const nodePath = require("node:path") as typeof import("node:path");
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "ride-images-"));
  process.env.RIDE_IMAGES_DIR = dir;
  return dir;
});

const rows = [
  {
    key: "tikva1",
    source: "static",
    selectable: true,
    label: "Tikva",
    category: "generic",
    url: "/ride-images/tikva1.jpg",
    fileName: null,
    createdAt: new Date("2026-09-01"),
    version: 1,
    archived: false,
  },
  {
    key: "upload-1a2b3c4d5e6f7890",
    source: "upload",
    selectable: true,
    label: "Uploaded",
    category: "generic",
    url: "",
    fileName: "0123456789abcdef.webp",
    createdAt: new Date("2026-09-20"),
    version: 3,
    archived: false,
  },
  {
    key: "upload-archived0000000",
    source: "upload",
    selectable: false,
    label: "Retired",
    category: "generic",
    url: "",
    fileName: "fedcba9876543210.webp",
    createdAt: new Date("2026-09-10"),
    version: 1,
    archived: true,
  },
];

vi.mock("../queries/rideImages.queries.js", async () => {
  const actual = await vi.importActual<typeof import("../queries/rideImages.queries.js")>(
    "../queries/rideImages.queries.js",
  );
  return { ...actual, selectAllRideImages: async () => rows };
});

const { createApp } = await import("../app.js");
const { toEventSummary } = await import("../controllers/event.controller.js");
const app = createApp();

beforeAll(() => {
  fs.writeFileSync(path.join(uploadDir, "0123456789abcdef.webp"), "webp-bytes");
  fs.writeFileSync(path.join(uploadDir, "fedcba9876543210.webp"), "old-webp-bytes");
});

describe("anonymous visitor: public ride -> image", () => {
  it("public event summary carries the uploaded rideImageKey; the catalog resolves it; the file loads — no token anywhere", async () => {
    // 1. what GET /events/public sends for a ride that uses an uploaded cover
    const summary = toEventSummary({
      id: "e1",
      rideImageKey: "upload-1a2b3c4d5e6f7890",
      promoteOnly: false,
    } as never);
    expect(summary.rideImageKey).toBe("upload-1a2b3c4d5e6f7890");

    // 2. the anonymous client asks for the catalog
    const catalog = await request(app).get("/api/v1/ride-images");
    expect(catalog.status).toBe(200);
    const image = catalog.body.data.find((i: { key: string }) => i.key === summary.rideImageKey);
    expect(image).toBeDefined();
    // replaced/versioned: the URL carries the version so a cached old picture is not reused
    expect(image.url).toBe("/api/v1/ride-image-files/0123456789abcdef.webp?v=3");

    // 3. the image itself is fetchable without authentication
    const file = await request(app).get(image.url);
    expect(file.status).toBe(200);
    expect(file.headers["cross-origin-resource-policy"]).toBe("cross-origin");
  });

  it("lists legacy static images and archived/disabled ones (existing rides keep their picture), never selectable", async () => {
    const res = await request(app).get("/api/v1/ride-images");
    const byKey = Object.fromEntries(res.body.data.map((i: { key: string }) => [i.key, i]));
    expect(byKey.tikva1.url).toBe("/ride-images/tikva1.jpg");
    expect(byKey["upload-archived0000000"]).toBeDefined();
    expect(byKey["upload-archived0000000"].selectable).toBe(false);
    const archivedFile = await request(app).get(byKey["upload-archived0000000"].url);
    expect(archivedFile.status).toBe(200);
  });

  it("exposes display metadata only — no file names, paths, source or admin fields", async () => {
    const res = await request(app).get("/api/v1/ride-images");
    for (const item of res.body.data) {
      expect(Object.keys(item).sort()).toEqual(
        ["category", "key", "label", "selectable", "url", "version"].sort(),
      );
    }
    expect(JSON.stringify(res.body)).not.toContain(uploadDir);
  });
});

describe("the admin endpoints stay closed", () => {
  it.each([
    ["get", "/api/v1/admin/ride-images"],
    ["post", "/api/v1/admin/ride-images"],
    ["post", "/api/v1/admin/ride-images/tikva1/replace"],
    ["patch", "/api/v1/admin/ride-images/tikva1"],
    ["delete", "/api/v1/admin/ride-images/tikva1"],
  ] as const)("%s %s 401s anonymously", async (method, url) => {
    expect((await request(app)[method](url)).status).toBe(401);
  });
});

