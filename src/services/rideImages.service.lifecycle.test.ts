// The ride-image lifecycle end to end at the service layer, against an in-memory stand-in for
// the ride_images table: upload -> replace -> archive, and what each does (and never does) to a
// ride that already stores the key. No test database in this repo, so the queries and the
// file/image modules are faked; the rules under test live in services/rideImages.service.ts.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RideImageRow } from "../queries/rideImages.queries.js";

const table = new Map<string, RideImageRow>();
let fileCounter = 0;

vi.mock("../lib/audit.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/audit.js")>("../lib/audit.js");
  return { ...actual, audit: vi.fn() };
});
vi.mock("../lib/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("../lib/ride-image-process.js", () => ({
  processRideImageUpload: async () => ({ webp: Buffer.from("webp"), width: 1200, height: 675 }),
}));
vi.mock("../lib/ride-image-storage.js", () => ({
  storeRideImageUpload: async () => `file${++fileCounter}.webp`,
  deleteRideImageUpload: vi.fn(),
  rideImagePublicUrl: (f: string) => `http://api.test/api/v1/ride-image-files/${f}`,
}));
vi.mock("../queries/rideImages.queries.js", () => ({
  RideImageLifecycleUnavailableError: class extends Error {},
  selectAllRideImages: async () => [...table.values()],
  selectRideImageByKey: async (k: string) => table.get(k) ?? null,
  insertRideImage: async (i: Partial<RideImageRow> & { key: string }) => {
    const row = { version: 1, archived: false, createdAt: new Date(), ...i } as RideImageRow;
    table.set(i.key, row);
    return row;
  },
  updateRideImageSelectable: async (k: string, selectable: boolean) => {
    const r = table.get(k);
    if (!r) return null;
    r.selectable = selectable;
    return r;
  },
  archiveRideImageRow: async (k: string) => {
    const r = table.get(k);
    if (!r) return null;
    r.archived = true;
    r.selectable = false;
    return r;
  },
  replaceRideImageRow: async (k: string, i: { fileName: string; url: string }) => {
    const r = table.get(k);
    if (!r || r.archived) return null;
    Object.assign(r, {
      source: "upload",
      fileName: i.fileName,
      url: i.url,
      version: r.version + 1,
    });
    return r;
  },
}));

const svc = await import("./rideImages.service.js");
const req = {} as never;

function seedStatic(key: string, selectable: boolean) {
  table.set(key, {
    key,
    source: "static",
    selectable,
    label: key,
    category: "generic",
    url: `/ride-images/${key}.webp`,
    fileName: null,
    createdAt: new Date(),
    version: 1,
    archived: false,
  });
}

let clock = Date.parse("2026-01-01T00:00:00Z");
beforeEach(() => {
  table.clear();
  fileCounter = 0;
  // The service caches the catalog for 30s. Each test starts a minute later than the last so it
  // never reads the previous test's cached rows.
  vi.useFakeTimers({ toFake: ["Date"] });
  clock += 60_000;
  vi.setSystemTime(clock);
  seedStatic("tikva1", true);
  seedStatic("sukkot-01", false);
});

describe("A. upload", () => {
  it("creates an active, selectable image that the catalog and the picker both return", async () => {
    const row = await svc.uploadRideImage(req, {
      bytes: Buffer.from("x"),
      label: "Spring",
      category: "mtb",
    });
    expect(row.selectable).toBe(true);
    expect(row.archived).toBe(false);
    const catalog = await svc.listRideImages();
    const found = catalog.find((r) => r.key === row.key);
    expect(found && svc.isPickable(found)).toBe(true);
    expect((await svc.listRideImagesForAdmin()).some((r) => r.key === row.key)).toBe(true);
    await expect(svc.assertRideImageAssignable(row.key, null)).resolves.toBeUndefined();
  });
});

describe("B. replace", () => {
  it("keeps the key, bumps the version and changes the resolved URL — no ride is touched", async () => {
    const before = svc.resolveRideImageUrl(
      (await svc.listRideImages()).find((r) => r.key === "tikva1")!,
    );
    expect(before).toBe("/ride-images/tikva1.webp"); // unreplaced: exactly the URL that ships today

    const replaced = await svc.replaceRideImage(req, "tikva1", Buffer.from("new"));
    expect(replaced.key).toBe("tikva1");
    expect(replaced.version).toBe(2);

    const after = svc.resolveRideImageUrl(replaced);
    expect(after).not.toBe(before);
    expect(after).toContain("/api/v1/ride-image-files/file1.webp");
    expect(after.endsWith("?v=2")).toBe(true);
    // a ride that stores "tikva1" can still keep it
    await expect(svc.assertRideImageAssignable("tikva1", "tikva1")).resolves.toBeUndefined();

    const again = await svc.replaceRideImage(req, "tikva1", Buffer.from("newer"));
    expect(svc.resolveRideImageUrl(again).endsWith("?v=3")).toBe(true);
  });

  it("404s an unknown or archived key", async () => {
    await expect(svc.replaceRideImage(req, "nope", Buffer.from("x"))).rejects.toMatchObject({
      status: 404,
    });
    await svc.archiveRideImage(req, "tikva1");
    await expect(svc.replaceRideImage(req, "tikva1", Buffer.from("x"))).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe("C. archive", () => {
  it("hides it from admin and the picker and blocks NEW selection, but the key still resolves", async () => {
    await svc.archiveRideImage(req, "tikva1");

    expect((await svc.listRideImagesForAdmin()).some((r) => r.key === "tikva1")).toBe(false);
    const inCatalog = (await svc.listRideImages()).find((r) => r.key === "tikva1");
    expect(inCatalog).toBeDefined(); // still resolvable for existing rides
    expect(svc.isPickable(inCatalog!)).toBe(false);
    expect(svc.resolveRideImageUrl(inCatalog!)).toBe("/ride-images/tikva1.webp"); // not a broken URL

    // new selection refused; an existing ride keeping its key is fine
    await expect(svc.assertRideImageAssignable("tikva1", null)).rejects.toMatchObject({
      status: 400,
    });
    await expect(svc.assertRideImageAssignable("tikva1", "other")).rejects.toMatchObject({
      status: 400,
    });
    await expect(svc.assertRideImageAssignable("tikva1", "tikva1")).resolves.toBeUndefined();
  });

  it("a merely disabled key stays in admin, is not pickable, and still resolves", async () => {
    const sukkot = (await svc.listRideImagesForAdmin()).find((r) => r.key === "sukkot-01");
    expect(sukkot).toBeDefined();
    expect(svc.isPickable(sukkot!)).toBe(false);
    await expect(svc.assertRideImageAssignable("sukkot-01", "sukkot-01")).resolves.toBeUndefined();
    await expect(svc.assertRideImageAssignable("sukkot-01", null)).rejects.toMatchObject({
      status: 400,
    });
  });

  it("rejects a key the server has never heard of", async () => {
    await expect(svc.assertRideImageAssignable("ghost", null)).rejects.toMatchObject({
      status: 400,
    });
  });
});
