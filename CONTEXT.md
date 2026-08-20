# CONTEXT — durable knowledge for the lead agent

Everything a cold session needs that is **not** obvious from the code, plus findings
that cost real work to produce. Running task list lives in [TASKS.md](TASKS.md).

**Last updated:** 2026-08-20

> **Path convention:** this file lives in `podium-server/`, but every path below is
> relative to the **workspace root** (`C:\dev2026\podiom`) — the parent directory that
> holds `podium-client/`, `podium-server/`, and `examples/`. So `podium-server/src/...`
> means the sibling path from that root, not a nested one.


---

## 0. Orientation — read this first

Bike Podium: a cycling app where riders meet up for rides/races and are tracked
live on a map. Not e-commerce. **There is no Inventory, product, or stock domain** —
if a task mentions one, it is a mistake, ask before building.

Server modules: `auth`, `events`, `participants`, `sms`, `users`.

### Folder names — the root AGENT.md is stale
| AGENT.md says | Actually is |
|---|---|
| `server-podium` | `podium-server` |
| `client-podium` | `podium-client` |
| `plan/…` (root) | `podium-client/plan/…` |

Root is **not** a git repo. `podium-client` and `podium-server` are each their own
git repo, so root-level files (this one, TASKS.md, `.claude/agents/`) are untracked
by either.

---

## 1. The two agents

| Agent | Owns | Definition |
|---|---|---|
| frontend-agent | `podium-client` | `.claude/agents/frontend-agent.md` |
| backend-agent | `podium-server` | `.claude/agents/backend-agent.md` |

**Gotcha:** the agent registry loads at session start. Newly written agent `.md`
files are **not** dispatchable in the same session that created them — the Agent
tool 404s. Workaround: dispatch `general-purpose` with the ownership rules inlined
in the prompt. From the next session onward they resolve by name normally.

---

## 2. Rules that override everything

1. **The Android transmitter app is live.** Its endpoints and JSON field names are
   frozen — `podium-client/plan/07-api-contract.md` Part 1.
2. **`examples/` is read-only.** Copy ideas from it, never edit it.
3. **`participantId` = `event_participants.id`.** The spine of tracking. Never
   change its meaning.
4. House contract rules (`07-api-contract.md:219-229`) apply even to non-frozen
   endpoints: new **optional** request fields and new response fields are fine;
   renaming/removing a field, changing a path or method, or making an optional
   field required is not.
5. Response envelope is `{ "data": ... }`; errors are `{ "error": "CODE", "message": "..." }`.

---

## 3. Filtering — current state of the server (verified 2026-08-20)

Four collection endpoints exist. **None is in the frozen Part 1**, so all are free
to extend under rule 4 above.

| Endpoint | Auth | Query params accepted today |
|---|---|---|
| `GET /api/v1/events` | required | `filter` = `mine\|joined\|upcoming\|live\|past`, default `mine`. **That is all.** |
| `GET /api/v1/events/public` | none | `limit` (1–100, default 20), `offset` (≥0, default 0). **No filtering at all.** |
| `GET /api/v1/events/:eventId/live` | optional | `riders` = `"1,2,3"` participant ids |
| `GET /api/v1/events/:eventId/participants` | required | **no query schema exists** — accepts nothing |

### Things that will bite
- **`GET /events` filters in JavaScript, not SQL.** `event.queries.ts:143-152` always
  fetches the user's entire owned+joined set; `event.service.ts:198-214` filters the
  array afterwards. No `limit`/`offset` at all.
- **`upcoming` and `past` are status-based, not date-based.** `upcoming` means
  `status ∈ {published, registration_open, ready}`; it never compares `starts_at`
  to now. `past` means `status === 'finished'`.
- **`filter` is single-valued and mutually exclusive** — "mine AND upcoming" is
  impossible today.
- **No pagination metadata anywhere.** `{ data: [...] }` only — a client cannot tell
  a short page from the last page. Adding `total`/`hasMore` needs a home in the envelope.
- Query schemas are plain `z.object`, so unknown params are **stripped silently**,
  not rejected. Adding a param is non-breaking; a typo'd param fails silently.
- `events.is_active` must stay `= (status NOT IN ('draft','cancelled','finished'))` —
  the frozen by-code lookup depends on it. Do not redefine it via a new status filter.

### `events` columns available for filtering
`id, code, name, type, requires_bib, starts_at, ends_at, is_active, created_at,
updated_at, owner_id, display_mode, status, visibility, description, location,
finished_at, requires_approval, is_paused, show_*`

Indexes: `code` UNIQUE · `(status, starts_at)` · `(owner_id)` · unique
`(owner_id) WHERE status='live'`.
**No index on `visibility`, `type`, `location`, `name`. No `pg_trgm`/`tsvector`/GIN
anywhere** — text search today means `ILIKE` + seq scan.

### Cheap wins if filtering is extended
`GET /events/public`: `q` text search, `type`, `status`, `from`/`to` on `starts_at`
(covered by the existing index), `location`, `sort`, `total`/`hasMore`.
`GET /events`: `limit`/`offset`, combinable filters, genuinely date-based upcoming/past.
`GET /:eventId/participants`: `registrationStatus`, `attendanceStatus`, `resultStatus`,
`category`, `bib`, `q` — all already columns, endpoint accepts none of them.
Geo-radius on events is **not** cheap: `events` has no lat/lng (only `routes` does).

### Response shapes
- `EventSummary` (11 fields): `id, code, name, type, status, visibility, displayMode,
  startsAt, endsAt, location, ownerId`
- Live rider: `participantId, name, bib, lat, lng, recordedAt, emergency, distanceKm`
  (`name` falls back to the literal `"Rider"`)
- Participant: `id, eventId, userId, name, bib, email, phone, category,
  registrationStatus, attendanceStatus, resultStatus, joinedAt, finishedAt, finishPosition`

Dates serialize as ISO-8601 UTC.

### Not built yet
No `routes` module — `GET /routes` and `/routes/public` are documented in the
contract but do not exist, though the `routes` table does (`sql/004-routes.sql`).

---

## 4. Filtering — current state of the client (verified 2026-08-20)

`podium-client/src/lib/api-client.ts` is the single HTTP layer. **There is no
`params`/`query` option** — query strings are hand-concatenated into the path by
each caller, and `URLSearchParams` is used exactly once in the whole client, for a
third-party weather call. No shared `types/api.ts`; response types are declared ad
hoc per page/store.

### The headline finding
**Almost every filter in the UI is a lie at the API level.** The client fetches a
page of rows and filters them in memory. `EventsListPage.tsx:251-253` says so in a
comment: *"the pill filter and search are both client-side, since the endpoint
itself has neither param."*

The **only** filter UI in the app that actually reaches the server is the rider
multi-select on `LiveEventPage`, which sends `?riders=`.

### Client-side-only filters (UI promises what the API never performs)
| UI control | Where | Server param needed |
|---|---|---|
| Find Rides status pills (Live/Upcoming/Finished) | `EventsListPage.tsx:602` | none exists on `/events/public` |
| Find Rides search | `EventsListPage.tsx:594` | no `q` anywhere |
| `type === "RIDE"` filter on public list | `EventsListPage.tsx:259` | no `type` on `/events/public` |
| My Rides search | `EventsListPage.tsx:388` | no `q` on `/events` |
| My Rides sort (Date/Name/Area) | `EventsListPage.tsx:400` | no `sort`/`order` anywhere |
| Favourites-only toggle | `EventsListPage.tsx:421` | `favorite` is **client-invented**, no DB column |
| Participants search by name/bib | `EventParticipantsPage.tsx:376` | participants has **no query schema at all** |
| Participants name sort | `EventParticipantsPage.tsx:229` | no sort param |
| CopyTrackSheet search / mine-others / paging | `CopyTrackSheet.tsx:364,93,108` | in-memory over already-fetched arrays |

### The compounding bug
`/events/public` defaults to `limit=20` and **the client never sends `limit` or
`offset`**. So every client-side pill and search filters *one page of 20 rows*.
"Finished" can render empty while finished public events exist beyond row 20.
Same for the RACE rows discarded by the `type` filter. This is a correctness bug
today, not just an efficiency one.

### Server capability the client never uses
`filter=upcoming|live|past` on `GET /events` is fully supported server-side but
**never sent** — the client fires `filter=mine` and `filter=joined` (both hardcoded
string literals, `eventsStore.ts:72-73`), merges them, and re-derives the
upcoming/live/past buckets in memory from `figmaStatus()`.

### Type drift
`ServerParticipant` (`participantsStore.ts:39-52`) omits **`finishedAt`** and
**`finishPosition`**, which the server does send (`participants.controller.ts:32-33`).
The client type under-describes the real payload. Two divergent local types exist
for the same endpoint (`ServerParticipant` and `RosterEntry`,
`LiveEventPage.tsx:105-109`), and `LiveEventPage` fetches the roster a second time
independently of `participantsStore`.

### Filter UI pointed at endpoints that do not exist
`TracksPage` has the richest filter suite in the app (country, surface, distance
range, climb range, multi-day, avoid-busy-roads, day-of-week, favourites, location)
— all against `getTracks()` in `src/lib/mock-tracks.ts`. **There is no `/tracks`
route or tracks module on the server.** Same for teams, event groups, and results:
localStorage/mock only. Only `/auth`, `/users`, `/events` are mounted (`app.ts:61-63`).

Two of the eleven track controls do not even reach `loadTracks`: `favoritesOnly`
filters afterwards, and `dayOfWeek` does not filter the list at all — it only
recolours hazard markers.

---

## 5. Open questions

- **Which list should filtering target?** Events/rides, participants, or something
  else. Asked; not yet answered. Blocks T-002.
