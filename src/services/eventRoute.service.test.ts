// Cover for "copy the track from another ride" and the copy counter it feeds.
//
// The two properties worth protecting here, both of them promises made to the organizer:
//
//   1. COPYING IS AN ATTACH, NOT A FORK. The source ride's own routes row is linked to the new
//      ride. If this ever silently goes back to writing a second row, the counter stops meaning
//      anything and a fix to a track stops reaching the rides built on it.
//   2. A COUNTER MAY NEVER COST SOMEONE THEIR RIDE. Every ledger and lineage write is non-fatal.
//      A database without sql/025 applied, a dropped connection, a lost race — the track still
//      attaches and the request still succeeds.
//
// No test database in this repo, so the queries layer is stubbed and the assertions are on what
// this service asks it to do.

import { beforeEach, describe, expect, it, vi } from "vitest";

const selectEventById = vi.fn();
const updateEventCopiedFrom = vi.fn();
const attachRouteToEvent = vi.fn();
const selectEventRouteSummary = vi.fn();
const selectEventRouteId = vi.fn();
const selectEventRouteGeometry = vi.fn();
const insertDrawnRouteRow = vi.fn();
const deleteEventRoute = vi.fn();
const insertRouteCopy = vi.fn();
const selectRouteCopyCount = vi.fn();
const getEventForViewer = vi.fn();
const getRouteForViewer = vi.fn();

vi.mock("../queries/event.queries.js", () => ({
  selectEventById: (...a: unknown[]) => selectEventById(...a),
  updateEventCopiedFrom: (...a: unknown[]) => updateEventCopiedFrom(...a),
}));
vi.mock("../queries/eventRoute.queries.js", () => ({
  attachRouteToEvent: (...a: unknown[]) => attachRouteToEvent(...a),
  deleteEventRoute: (...a: unknown[]) => deleteEventRoute(...a),
  insertDrawnRouteRow: (...a: unknown[]) => insertDrawnRouteRow(...a),
  selectEventRouteGeometry: (...a: unknown[]) => selectEventRouteGeometry(...a),
  selectEventRouteId: (...a: unknown[]) => selectEventRouteId(...a),
  selectEventRouteSummary: (...a: unknown[]) => selectEventRouteSummary(...a),
}));
vi.mock("../queries/routeCopy.queries.js", () => ({
  insertRouteCopy: (...a: unknown[]) => insertRouteCopy(...a),
  selectRouteCopyCount: (...a: unknown[]) => selectRouteCopyCount(...a),
}));
vi.mock("./event.service.js", () => ({
  assertOwner: (event: { ownerId: number }, userId: number) => {
    if (event.ownerId !== userId) throw new Error("not owner");
  },
  getEventForViewer: (...a: unknown[]) => getEventForViewer(...a),
}));
vi.mock("./routeLibrary.service.js", () => ({
  getRouteForViewer: (...a: unknown[]) => getRouteForViewer(...a),
}));

const { attachLibraryRouteToEvent, copyTrackFromEvent, getEventRouteWithUsage } = await import(
  "./eventRoute.service.js"
);

const TARGET = "11111111-1111-1111-1111-111111111111";
const SOURCE = "22222222-2222-2222-2222-222222222222";
const OWNER = 7;
const COPIER = 9;

function route(overrides: Record<string, unknown> = {}) {
  return { id: 42, ownerId: OWNER, distanceKm: 40, elevationM: 300, ...overrides };
}

beforeEach(() => {
  for (const fn of [
    selectEventById,
    updateEventCopiedFrom,
    attachRouteToEvent,
    selectEventRouteSummary,
    selectEventRouteId,
    selectEventRouteGeometry,
    insertDrawnRouteRow,
    deleteEventRoute,
    insertRouteCopy,
    selectRouteCopyCount,
    getEventForViewer,
    getRouteForViewer,
  ]) {
    fn.mockReset();
  }
  selectEventById.mockResolvedValue({ id: TARGET, ownerId: COPIER, status: "published" });
  getEventForViewer.mockResolvedValue({ id: SOURCE });
  selectEventRouteSummary.mockResolvedValue(route());
  insertRouteCopy.mockResolvedValue(true);
  updateEventCopiedFrom.mockResolvedValue(undefined);
  attachRouteToEvent.mockResolvedValue(undefined);
});

describe("copyTrackFromEvent", () => {
  it("attaches the source ride's own track row — it never forks a second one", async () => {
    await copyTrackFromEvent(TARGET, COPIER, SOURCE);

    expect(attachRouteToEvent).toHaveBeenCalledWith(TARGET, 42);
    // The whole point: no new geometry is written anywhere.
    expect(insertDrawnRouteRow).not.toHaveBeenCalled();
  });

  it("counts the copy against the source track and stamps the ride's lineage", async () => {
    await copyTrackFromEvent(TARGET, COPIER, SOURCE);

    expect(insertRouteCopy).toHaveBeenCalledWith({
      routeId: 42,
      copiedByUserId: COPIER,
      newEventId: TARGET,
      sourceEventId: SOURCE,
    });
    expect(updateEventCopiedFrom).toHaveBeenCalledWith(TARGET, SOURCE, 42);
  });

  it("checks the SOURCE RIDE's visibility, not the track's own is_public flag", async () => {
    await copyTrackFromEvent(TARGET, COPIER, SOURCE);

    expect(getEventForViewer).toHaveBeenCalledWith(SOURCE, COPIER);
    // getRouteForViewer would ask "is this track yours or published?", which rejects a visible
    // ride whose track is unlisted — routes.is_public only goes true for a PUBLIC ride.
    expect(getRouteForViewer).not.toHaveBeenCalled();
  });

  it("does not count a rider copying their own track", async () => {
    selectEventRouteSummary.mockResolvedValue(route({ ownerId: COPIER }));

    await copyTrackFromEvent(TARGET, COPIER, SOURCE);

    expect(attachRouteToEvent).toHaveBeenCalledWith(TARGET, 42);
    expect(insertRouteCopy).not.toHaveBeenCalled();
    // The lineage is still recorded — where the track came from is true either way.
    expect(updateEventCopiedFrom).toHaveBeenCalledWith(TARGET, SOURCE, 42);
  });

  it("still attaches when the ledger write fails — a counter never costs a ride", async () => {
    insertRouteCopy.mockRejectedValue(
      Object.assign(new Error('relation "route_copies" does not exist'), { code: "42P01" }),
    );

    await expect(copyTrackFromEvent(TARGET, COPIER, SOURCE)).resolves.toMatchObject({ id: 42 });
    expect(attachRouteToEvent).toHaveBeenCalledWith(TARGET, 42);
  });

  it("still attaches when the lineage stamp fails", async () => {
    updateEventCopiedFrom.mockRejectedValue(new Error("connection lost"));

    await expect(copyTrackFromEvent(TARGET, COPIER, SOURCE)).resolves.toMatchObject({ id: 42 });
    expect(attachRouteToEvent).toHaveBeenCalledWith(TARGET, 42);
  });

  it("404s a source ride with no track", async () => {
    selectEventRouteSummary.mockResolvedValue(null);
    await expect(copyTrackFromEvent(TARGET, COPIER, SOURCE)).rejects.toMatchObject({ status: 404 });
    expect(attachRouteToEvent).not.toHaveBeenCalled();
  });

  it("rejects a ride copying from itself", async () => {
    await expect(copyTrackFromEvent(TARGET, COPIER, TARGET)).rejects.toMatchObject({ status: 400 });
    expect(attachRouteToEvent).not.toHaveBeenCalled();
  });

  it("refuses to change the track of a finished ride, same as the other attach", async () => {
    selectEventById.mockResolvedValue({ id: TARGET, ownerId: COPIER, status: "finished" });
    await expect(copyTrackFromEvent(TARGET, COPIER, SOURCE)).rejects.toMatchObject({ status: 400 });
    expect(attachRouteToEvent).not.toHaveBeenCalled();
  });
});

describe("attachLibraryRouteToEvent", () => {
  it("counts a Find Tracks pick with no source ride", async () => {
    getRouteForViewer.mockResolvedValue(route());

    await attachLibraryRouteToEvent(TARGET, COPIER, 42);

    expect(attachRouteToEvent).toHaveBeenCalledWith(TARGET, 42);
    expect(insertRouteCopy).toHaveBeenCalledWith({
      routeId: 42,
      copiedByUserId: COPIER,
      newEventId: TARGET,
      sourceEventId: null, // there is no source ride in this flow
    });
    expect(updateEventCopiedFrom).toHaveBeenCalledWith(TARGET, null, 42);
  });

  it("keeps its own-or-public check on the track", async () => {
    getRouteForViewer.mockResolvedValue(route());
    await attachLibraryRouteToEvent(TARGET, COPIER, 42);
    expect(getRouteForViewer).toHaveBeenCalledWith(42, COPIER);
  });
});

describe("getEventRouteWithUsage", () => {
  it("adds the count for ?preview=1", async () => {
    selectEventRouteGeometry.mockResolvedValue({ points: [], distanceKm: 40, elevationM: null });
    selectEventRouteId.mockResolvedValue(42);
    selectRouteCopyCount.mockResolvedValue(3);

    expect(await getEventRouteWithUsage(TARGET, COPIER)).toMatchObject({ usedByRides: 3 });
  });

  it("returns the route without the count when the ledger cannot be read", async () => {
    selectEventRouteGeometry.mockResolvedValue({ points: [], distanceKm: 40, elevationM: null });
    selectEventRouteId.mockRejectedValue(new Error("no such table"));

    const result = await getEventRouteWithUsage(TARGET, COPIER);

    // The client treats usedByRides as optional and drops the stat — a drawable map with no
    // number beats a 500 on the route request.
    expect(result).toMatchObject({ distanceKm: 40 });
    expect(result).not.toHaveProperty("usedByRides");
  });

  it("still answers null for a ride with no track", async () => {
    selectEventRouteGeometry.mockResolvedValue(null);
    expect(await getEventRouteWithUsage(TARGET, COPIER)).toBeNull();
  });
});
