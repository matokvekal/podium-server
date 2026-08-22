# Client ↔ server audit — the whole user story, one step at a time

**Written:** 2026-08-20 · **Method:** every screen in `podium-client/src` read against every
route in `podium-server/src`, then both read against the product story as told by the owner.

> **Path convention:** paths are relative to the workspace root (`C:\dev2026\podiom`).

**Verdict key**

| | meaning |
|---|---|
| ✅ | client need is fully met by the server today |
| ⚠ | server has it, but the shape/filter/behaviour doesn't fit what the UI does |
| ❌ | no server support at all — the client is running on mock data or localStorage |

**Headline:** the client is roughly two milestones ahead of the server. Auth, event CRUD,
the status workflow, the start list, approve/reject, pause and the live map are **real**.
Everything about **routes/tracks, results, history lines, ride groups, teams and plan
limits is client-only** — localStorage or `lib/mock-*.ts`. On top of that were four small,
cheap server bugs that broke the core story outright; **those are fixed** (see the next
section). Everything still marked ⚠ or ❌ below is outstanding.

**Frozen contract:** none of the fixes touched `GET /events/by-code/:code`,
`POST /events/join` or `POST /events/:id/locations/batch`, and every response change is an
added field. The live Android transmitter is unaffected.

---

## The four things to fix first (P0) — ✅ DONE 2026-08-20

These were small, they were in code that already existed, and each one broke a step described
as central to the app. **All four are now fixed and covered by tests** (105 passing) — kept
here because the walkthrough below still describes the reasoning, and because the ⚠/❌ marks
elsewhere in this file are still accurate.

| # | What broke | Fixed in |
|---|---|---|
| **1** | **A rider who joins showed up with no name.** Waiting list, start list and live map all showed blank / `"Rider"`. | `PARTICIPANT_DISPLAY_COLUMNS` in `event.queries.ts`; both participant selects + both updates now join `users` |
| **2** | **An approved rider still couldn't open a private ride.** The "send a QR to a closed ride, approve them, then they see it" flow dead-ended. | `getEventForViewer` in `event.service.ts` — now returns a `ViewerTier` |
| **3** | **A pending rider saw everything or nothing.** No "you're waiting, so no track/time/place yet" tier. | `canViewEventInfo()` + redaction in `toEventDetail` |
| **4** | **"Riders list visible" was silently thrown away on create.** zod stripped `showParticipants` from `POST /events`. | all six `show_*` flags added to `createEventSchema` and `insertEvent` |

Two more shipped in the same pass: **W3** (a rejected rider no longer keeps the ride in their
list) and **L2** (a rider always sees their own dot on the live map, whatever
`show_live_locations` says).

Details and reasoning for each are in the walkthrough below (R4, C3, C4, E2, W3, L2).

---

# Stage 0 — Guest, no account (PWA)

> *"user can get the app as pwa without login, he can search and see many old rides just to
> see track maps"*

| # | Client needs | Server today | |
|---|---|---|---|
| **G1** | Public ride list, searchable, filter Live/Upcoming/Finished (`EventsListPage.tsx`, `eventsStore.ts:106`) | `q` / `type` / `bucket` / `activityType` / `level` / `sort` / `total` — **client not wired up yet** | ✅ server / ⚠ client |
| **G2** | Open one public ride without signing in (`EventDetailPage.tsx`) | `GET /events/:eventId` with `optionalAuth` | ✅ |
| **G3** | **See the track map of an old ride** | `GET /routes/public`, `GET /routes/:id`, and the route on the event detail — all unauthenticated | ✅ *fixed* |
| **G4** | Rider list stays hidden from a guest | `participantsRouter` is `requireAuth` throughout | ✅ |

**G1 comment.** The endpoint works, but it takes only `limit`/`offset`
(`event.schemas.ts:71`) and the client never sends either — so every search box, every
Live/Upcoming/Finished pill and every sort runs **in memory over the first 20 rows**.
"Finished" can render empty while finished rides exist at row 21. Also `ORDER BY starts_at
ASC` puts the oldest ride first, which is the wrong end for a discovery list.
*Fix:* add `q`, `type`, `status`, `sort` to `publicEventsQuerySchema`, return
`{ data, total }`, and default the order to `starts_at DESC` for finished / `ASC` for upcoming.

**G3 comment — was the headline gap of Stage 0, now built.** The whole reason a guest opens
the app is to look at old tracks, and the server could not serve a single coordinate: the
tables were designed and created (`sql/004-routes.sql`) but there was no routes module at
all. `src/modules/routes/` now exists — see F1 for the shipped endpoints. The client still
draws `lib/mock-results.ts` until it is pointed at them; that is client work, and the shapes
were chosen to make it a swap rather than a rewrite.

---

# Stage 1 — Sign in with Google

| # | Client needs | Server today | |
|---|---|---|---|
| **A1** | Google ID token → account | `POST /auth/google`, verifies + creates user, stores `first_name`/`last_name`/`avatar_url` from the token | ✅ |
| **A2** | Avatar to show next to the rider | `GET /users/me` returns `avatarUrl` | ⚠ |
| **A3** | "Finish your profile" gate on first login | `requiresProfile` from `needsProfile()` — nickname stays NULL after Google, so setup still runs | ✅ |

**A2 comment.** Server-side this is done. The **client** `Profile` interface
(`podium-client/src/auth/AuthContext.tsx:27`) doesn't declare `avatarUrl`, so the value
arrives and is dropped. One-line client fix, no server work.

---

# Stage 2 — Signed-in rider: browse and join open rides

| # | Client needs | Server today | |
|---|---|---|---|
| **R1** | "My Rides" = owned + joined | `GET /events?filter=mine` / `?filter=joined` | ✅ |
| **R2** | Join an open ride | `POST /events/join` by event code — idempotent | ✅ |
| **R3** | Join a ride that needs approval → land as *waiting* | `joinEvent` sets `waiting_approval` when `requires_approval` (`event.service.ts:86`) | ✅ |
| **R4** | **The joined rider's name in every list** | resolved from `users` at read time | ✅ *fixed* |
| **R5** | "Am I registered / waiting / approved?" on the ride page | `myParticipant: { id, registrationStatus, attendanceStatus }` in the detail payload | ✅ |

**R3 comment.** The client's own doc comment (`EventCreatePage.tsx`, "Require my approval")
says this doesn't work server-side. **That comment is stale** — the server does it correctly
now. Worth deleting so nobody re-builds it.

**R4 comment — P0 #1.** `upsertParticipant` inserts `(event_id, user_id, bib,
registration_status)` and nothing else (`event.queries.ts:318`). `mapParticipant` returns the
raw `event_participants.name` column (`event.queries.ts:104`), which is **NULL for everyone
who joined through the app** — that column only gets filled by the organizer's manual-add
path. `sql/003-participants.sql` even states the intent: *"Display name resolution is the
application's job: `event_participants.name` when set, otherwise the linked user's name"* —
**that resolution was never implemented.** Result: the organizer's waiting list is a column
of blanks, and `getLiveRiders` falls back to the literal string `"Rider"`
(`event.service.ts:378`).

*Fix:* resolve the name in SQL, don't copy it at join time (a rider who later fixes their
profile should fix it everywhere):

```sql
-- selectParticipantsForEvent / selectParticipantByIdForEvent / selectLastLocationsForEvent
SELECT ep.*,
       COALESCE(
         ep.name,
         NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), ''),
         u.nickname
       ) AS display_name,
       u.avatar_url
  FROM event_participants ep
  LEFT JOIN users u ON u.id = ep.user_id
 WHERE ep.event_id = $1
```

Then map `display_name` → `name` and add `avatarUrl` to `toParticipantSummary`. No schema
change needed. Additive to the response, so the frozen Android contract is untouched.

---

# Stage 3 — A closed ride, shared by link or QR

> *"sometimes rides are close but creator can send link or QR — in that case user will ask to
> join but still will not see details like track time and place; if he been approved he then
> will see the data"*

| # | Client needs | Server today | |
|---|---|---|---|
| **C1** | Look the ride up from a QR **before** signing in | `GET /events/by-code/:code` — unauthenticated, filters on `is_active` only, so private rides *are* reachable by code | ✅ |
| **C2** | Ask to join a private ride | `POST /events/join` has no visibility check — works | ✅ |
| **C3** | **After approval, actually see the ride** | a participant row is now a key in its own right | ✅ *fixed* |
| **C4** | **While waiting, see a teaser only — no track, no time, no place** | `viewerTier` + redaction | ✅ *fixed* |

**C3 comment — P0 #2, the single biggest break in the app.**

```ts
// event.service.ts:222
if (event.visibility === "private" && (viewerId === null || event.ownerId !== viewerId)) {
  throw new ApiError(403, "This event is private");
}
```

Private means **owner only**. A rider can scan the QR, ask to join, and be approved by the
organizer — and `GET /events/:eventId` still 403s them forever. Because
`listParticipantsForViewer` and `getLiveRiders` both call `getEventForViewer` first, they are
locked out of the roster and the live map too. The entire closed-ride story dead-ends one
step after approval.

*Fix:* widen the rule from "owner" to "owner **or someone with a participant row**", and
carry the viewer's tier through instead of throwing:

```ts
export type ViewerTier = "owner" | "approved" | "pending" | "public" | "stranger";

export async function getEventForViewer(eventId, viewerId): Promise<{ event: Event; tier: ViewerTier }> {
  const event = await selectEventById(eventId);
  if (!event) throw new ApiError(404, "Event not found");
  if (event.ownerId === viewerId) return { event, tier: "owner" };

  const me = viewerId ? await selectParticipantByEventAndUser(eventId, viewerId) : null;
  if (me?.registrationStatus === "approved" || me?.registrationStatus === "registered")
    return { event, tier: "approved" };
  if (me?.registrationStatus === "waiting_approval") return { event, tier: "pending" };

  if (event.visibility === "private") throw new ApiError(404, "Event not found");
  return { event, tier: viewerId ? "public" : "stranger" };
}
```

Note the **404 instead of 403** for a stranger hitting a private event: a 403 confirms the id
exists, which is a small leak on a URL that is meant to be secret.

**C4 comment — P0 #3.** Right now `toEventDetail` (`event.controller.ts:52`) returns
`description`, `location`, `startsAt`, `endsAt` and the six `show_*` flags to **every** caller
who passes the visibility gate. The flags are decoration: only `show_live_locations`
(`event.service.ts:356`) and `show_participants` (`participants.service.ts:43`) are ever
enforced. `show_event_info`, `show_route`, `show_results`, `show_history_locations` are
stored, accepted in `PATCH`, echoed back — and do nothing.

*Fix:* make `toEventDetail` take the tier and redact:

| field | owner | approved | pending | public viewer |
|---|---|---|---|---|
| `name`, `type`, `status`, `code` | ✓ | ✓ | ✓ | ✓ |
| `startsAt`, `endsAt`, `location`, `description` | ✓ | ✓ | private ride: **null**; public ride: `show_event_info` | `show_event_info` |
| route (once F1 exists) | ✓ | ✓ | **never** | `show_route` |
| participants | ✓ | `show_participants` | ✗ | `show_participants` |
| live | ✓ | `show_live_locations` | ✗ | `show_live_locations` |
| results | ✓ | ✓ | ✗ | `show_results` |

The pending row keys on **visibility**, not on the tier alone. `show_event_info` is a
*public browsing* switch, and it defaults to TRUE — so gating pending on it alone would have
shown a waiting rider everything. Gating pending on nothing would have made them worse off
than a passing stranger on a public ride. Private + pending → redacted; public + pending →
whatever any browser gets. That is `canViewEventInfo()` in `event.service.ts`.

Add `viewerTier` to the payload so the client can say *"waiting for approval — details will
appear once the organizer approves you"* instead of guessing.

---

# Stage 4 — Ride day: live

| # | Client needs | Server today | |
|---|---|---|---|
| **L1** | Poll everyone's position; non-owner picks specific riders | `GET /events/:id/live` — owner sees all, viewer picks ≤5 (`MAX_LIVE_RIDERS_FOR_VIEWER`) | ✅ |
| **L2** | **A rider always sees their own dot** | own position always allowed; the flag gates others | ✅ *fixed* |
| **L3** | GPS ingest | `POST /events/:id/locations/batch` (frozen, Android) — the PWA deliberately never transmits | ✅ |
| **L4** | Per-rider speed | not a server field; client derives it from consecutive fixes | ✅ (by design) |
| **L5** | The route line under the live map | on the event detail the live page already loads | ✅ *fixed* |
| **L6** | Rider names + avatars in the live list | real names, and `avatarUrl` added to the payload | ✅ *fixed* |

**L2 comment.** `getLiveRiders` (`event.service.ts:356`) throws 403 for any non-owner when
`show_live_locations` is false. But the story is *"each can see himself at map and see list of
other riders **if creator allows that**"* — the creator's switch is about seeing **others**,
never about seeing **yourself**. Today a participant on a ride with sharing off cannot see
their own position.
*Fix:* before the flag check, if the viewer has a participant row, always allow their own
`participantId` through; apply `show_live_locations` only to the *other* ids they requested.

---

# Stage 5 — After the ride: history

> *"after ride end user that was participant will see it in his my ride history"*

| # | Client needs | Server today | |
|---|---|---|---|
| **H1** | Finished rides listed under My Rides / Track | client filters `status === "finished"` off `GET /events` | ✅ |
| **H2** | **The line I actually rode, drawn on the history map** | written at `live → finished`; `GET /events/:id/tracks` | ✅ *fixed* |
| **H3** | **Results: time, place, category** | `GET /events/:id/results` — places computed at read time | ✅ *fixed* |
| **H4** | Organizer marks attendance / finishers | `PATCH …/attendance` and `PATCH …/result` | ✅ *fixed* |

**H2 comment.** `sql/005-tracking.sql` is explicit: *"Written once, when the event finishes:
each rider's ride reduced to a simplified line. This is what the History screen draws, and it
is NEVER purged."* `changeEventStatus` (`event.service.ts:256`) has a comment pointing at
exactly this — *"Callers that need to react to a specific transition (e.g. writing
`participant_tracks` when an event finishes)"* — but no caller exists. A grep for
`participant_tracks` across `src/` returns **only comments**. And `env.ts:71` warns the raw
`location_points` purge must not run before those rows exist — so if the purge is ever turned
on, **every ride line is lost permanently.** The simplifier is already written and waiting:
`src/lib/geo.ts:78`.
*Fix:* on the `live → finished` transition, for each participant read `location_points`,
simplify via `lib/geo.ts`, insert `participant_tracks`. Then `GET /events/:id/tracks` and
`GET /events/:id/participants/:pid/track`, gated on `show_history_locations`.

**H3/H4 comment.** The client's results page is entirely `lib/mock-results.ts`
(`resultsStore.ts:1`), and attendance/finished are a **localStorage overlay merged on top of
the server list on every read** (`participantsStore.ts:1-20`) — so two organizers on two
phones see two different start lists, and clearing browser data erases the ride's attendance.
*Fix:* F3.

---

# Stage 6 — Teams, ride groups, following

| # | Client needs | Server today | |
|---|---|---|---|
| **T1** | Teams/clubs with members, invite + approve (`TeamsPage.tsx`, `TeamDetailPage.tsx`) | `teams` + `team_members`, owner-managed, with a real join-request flow | ✅ *fixed* |
| **T2** | Ride groups (Beginner / Elite) inside one ride, own start time, own track (`EventGroupsPage.tsx`) | `event_groups` + `event_participants.group_id`, with bulk assign | ✅ *fixed* |
| **T3** | Follow a creator, see their next rides | `user_follows`, and `GET /events?filter=following` | ✅ *fixed* |
| **T4** | Show who organized a ride | `owner: { id, name, avatarUrl }` on the event detail and the results | ✅ *fixed* |

**T1/T2 comment.** Both stores are pure localStorage (`teamsStore.ts`, `eventGroupsStore.ts`).
Everything a team or group "knows" lives in one browser: a member added on the organizer's
phone does not exist on anyone else's. `EventGroupsPage.tsx` is a fully built screen —
paging between groups, bulk-assigning riders, per-group start times and tracks — with **zero**
persistence beyond the device.

**T4 comment.** `EventDetailPage.tsx` prints an organizer name from
`event-visuals.ts:132 mockOrganizerName(eventId)` — a **deterministic fake name derived from
the event id**. Every ride in the app currently displays an invented organizer. Following a
creator (T3) is impossible until the real one is returned. Cheap fix: join `users` in
`selectEventById` and add `owner: { id, name, avatarUrl }` to the detail payload.

---

# Stage 7 — Creator: create a ride

| # | Client needs | Server today | |
|---|---|---|---|
| **E1** | Create a ride | `POST /events` | ✅ |
| **E2** | **"Riders list visible" set at create time** | all six `show_*` flags accepted on create | ✅ *fixed* |
| **E3** | Activity type — road / MTB / gravel / running / hiking | `events.activity_type`, on create, update and the list summary | ✅ *fixed* |
| **E4** | Level — beginner … world tour | `events.level` | ✅ *fixed* |
| **E5** | Organizing club / team on the ride | `events.organizer_group` (free text; real teams supersede it later) | ✅ *fixed* |
| **E6** | **Find a track, upload GPX/CSV, or copy another ride's track** | `POST /routes` + `POST /events/:id/route`; copy is an attach | ✅ *fixed* |
| **E7** | Add riders by hand / from a file / from phone contacts | `POST …/participants/import` — one request, one transaction | ✅ *fixed* |
| **E8** | Public / private + require approval | both real, both stored | ✅ |
| **E9** | Share link + QR | client generates the QR over the real event code | ✅ |
| **E10** | Edit a ride | `PATCH /events/:eventId`, locked once live/finished | ✅ |

**E2 comment — P0 #4, and the cheapest fix in this document.**
`EventCreatePage.tsx` sends `showParticipants: ridersListVisible` in the `POST /events` body.
`createEventSchema` (`event.schemas.ts:12`) doesn't list it, and zod objects **strip unknown
keys silently** — no error, no log. The organizer ticks "riders can see the list", the ride is
created with the `FALSE` default, and the setting only takes effect if they later open Edit
(where `updateEventSchema` *does* accept it). *Fix:* add the six `show_*` flags to
`createEventSchema` — they already exist on the update schema, the columns already exist, and
new optional request fields are explicitly allowed by the house contract rules.

**E3/E4/E5 comment.** Persisted to localStorage keyed by event id
(`eventExtrasStore.ts`) — so a ride's difficulty and club name are visible **only in the
browser that created it**. Every other rider browsing that ride sees nothing, which defeats
the stated purpose ("so a browsing rider can see the hardness before joining"). Three nullable
columns and three lines in the schemas closes it — F2.

**E6 comment — was the biggest single build in this document, now shipped.** All three paths
land on the same endpoint: the client keeps parsing GPX (`lib/track-gpx.ts`) and
CSV/spreadsheet points (`lib/track-csv.ts`) and now POSTs the parsed points to `POST /routes`,
which computes distance/climb/bbox/preview once and stores them. Drawing on the map and
copying another ride's track arrive through the same door — copying is
`POST /events/:id/route` with the source ride's `routeId`, so it is one row, not a duplicated
line, and a later fix to the geometry reaches every ride using it.

**E7 comment.** Works, but a 60-rider spreadsheet import is 60 sequential HTTP requests with
no transaction — a mid-way failure leaves the list half-imported. Add
`POST /events/:id/participants/bulk` taking an array, in one `withTransaction`.

---

# Stage 8 — Creator: the waiting list

| # | Client needs | Server today | |
|---|---|---|---|
| **W1** | See who's waiting, approve / reject | `POST …/:participantId/approve` \| `/reject`, owner-only | ✅ |
| **W2** | **Their names** | resolved | ✅ *fixed* |
| **W3** | A rejected rider shouldn't keep the ride in their list | rejected rows no longer count as a join | ✅ *fixed* |
| **W4** | Let a co-organizer manage the list | `event_members` table exists; **no code reads it** — every mutation is owner-only | ❌ |

**W3 fix:** `AND (ep.user_id IS NULL OR ep.registration_status <> 'rejected')` in the join at
`event.queries.ts:143`.

---

# Stage 9 — Creator: running the ride

| # | Client needs | Server today | |
|---|---|---|---|
| **S1** | Publish → open registration → ready → start → finish | full transition graph, validated | ✅ |
| **S2** | Pause / resume a live ride | `PATCH /:eventId/pause` | ✅ |
| **S3** | Only one ride live at a time per organizer | app check + unique partial index | ✅ |
| **S4** | Ride starts automatically at its start time | no scheduler; client computes a display-only "effective" status | ⚠ |
| **S5** | Finish → freeze results and store the ride lines | the finish hook writes every rider's line | ✅ *fixed* |

**S4 comment.** `computeEffectiveStatus` (`event.service.ts:315`) reports a ride as finished
once `ends_at` passes without writing anything, and both sides agree on that. But *"ride start
auto"* has no equivalent — nothing ever moves `ready → live`. Either add a scheduled job, or
(cheaper, and consistent with what's already there) extend `computeEffectiveStatus` to report
`live` once `starts_at` has passed on a `ready` event, and let the first location batch or the
organizer's own tap do the real write.

---

# Stage 10 — Plan limits

> *"i will limit how many rides per week and how many participants and how many groups"*

✅ **Enforced server-side** in `src/lib/plan-limits.ts`: rides per rolling week, riders per
ride, groups per event, teams per owner. Refusals are **409 with a `PLAN_LIMIT_*` code**, not
403 — the caller is permitted, they have run out of allowance, and the client shows an upgrade
prompt rather than "not yours".

Notes: the window is a **rolling 7 days**, not a calendar week, so "10 this week" does not
reset every Monday for someone who created 10 on Sunday. A self-joiner counts against the
organizer's rider cap, or a public ride's start list would be unlimited while only manual adds
were capped. The import check is for the whole file at once — taking the first 200 rows of a
201-row spreadsheet is worse than refusing.

⚠ **There is still no billing.** No paid plan, no subscription record, no per-user override:
every account is on the free plan. `getPlanLimits(userId)` is the single async seam a real plan
lookup slots into, which is why no call site references a limit constant directly.

---

# Cross-cutting

| # | Issue | |
|---|---|---|
| **X1** | `X-Client-Action-Id` is honoured on every mutating route (not the frozen Android three). A replay is answered 409 **carrying the original result**, which is what the client's `apiMutate` already expects. | ✅ *fixed* |
| **X2** | Response envelopes are mixed: `{ data: … }` on the newer routes, bare objects on the three frozen Android ones. The client handles both (`api-client.ts:142`). Correct as-is — documented so nobody "tidies" it. | ✅ |
| **X3** | `GET /events/public` and `GET /routes/public` both filter, sort and page server-side now. The **client still filters in memory** — M1 is live until `eventsStore.ts` sends the parameters. | ✅ server / ⚠ client |
| **X4** | Client's `ServerParticipant` type omits `finishedAt` / `finishPosition`, which the server does send. Client-side fix. | ⚠ |
| **X5** | `GET /events/public` returns `{ data, total, limit, offset }`. | ✅ *fixed* |

---

# What to build, grouped

## F1 — Routes & tracks — ✅ SHIPPED 2026-08-20

`src/modules/routes/`, against the tables that already existed in `sql/004-routes.sql`. **No
schema change; nothing to run.** Endpoints follow `plan/07-api-contract.md` exactly:

```
POST   /api/v1/routes                 upload / drawn / copied — takes { name, routeType,
                                      source, placeName, isPublic, points, markers }
GET    /api/v1/routes                 my library                       (auth)
GET    /api/v1/routes/public          the shared library               (no auth)
GET    /api/v1/routes/:routeId        full geometry                    (optional auth)
PATCH  /api/v1/routes/:routeId        rename, publish/unpublish        (owner)
DELETE /api/v1/routes/:routeId                                         (owner)
POST   /api/v1/events/:eventId/route  attach — this is also "copy"     (event owner)
DELETE /api/v1/events/:eventId/route  detach                           (event owner)
```

`GET /routes/public` supports `?place=&minDistance=&maxDistance=&minElevation=&maxElevation=&type=&page=&pageSize=`
and returns `{ data, total, page, pageSize }` — `total` is what lets the browser render its
page numbers.

Decisions worth knowing:

- **A list never carries `trackPoints`.** `ROUTE_SUMMARY_COLUMNS` spells out every column
  except the geometry, so a list cannot leak it by accident; full geometry is only ever
  `GET /routes/:routeId`. A test asserts this on every list endpoint.
- **Derived values are computed once, at upload** — distance, climb, bbox, start/end, and a
  300-point preview via `lib/geo.ts`. Never on read.
- **Unknown climb is `null`, not `0`.** "Flat" and "we have no elevation data" are different
  answers, and `?maxElevation=10` must not quietly return every route of unknown profile.
- **Parsing stays on the client.** GPX/TCX/CSV are already parsed there
  (`lib/track-gpx.ts`, `lib/track-csv.ts`); the server takes points. That keeps a malformed
  20 MB file off the wire and means drawn, uploaded and copied routes all arrive the same way.
- **The body limit is raised to 4 MB for `/api/v1/routes` only** (`app.ts`). The global
  100 kb limit would have 413'd every real GPX; everything else still gets the tight one.
- **An unpublished route 404s** for anyone but its owner — same reasoning as a private event.
- **Deleting a route detaches it from every event first**, since there are no foreign keys.
  Unpublish is the reversible option and is what the UI should offer.

The event detail payload now carries `route` (preview geometry only), gated by
`canViewRoute()`: owner and approved always; **pending never** — a closed ride's track is the
organizer's to hand out, and asking to join is not being handed it; public browsers by
`show_route`. Every detail response includes it, mutation replies included — the client swaps
a PATCH response straight into its state, so omitting it there would make the map vanish on
rename.

Still outstanding: "Find Tracks" (`TracksPage.tsx` — hazards, POIs, air quality, multi-day,
day-of-week) needs columns none of this adds. Separate feature, specced in
`podium-client/plan/server-tasks.md` Part B.

**Client work to pick this up:** point `eventRouteStore.ts` / `resultsStore.ts` at the real
endpoints, and send the parsed points from `EventCreatePage.tsx` to `POST /routes` followed by
`POST /events/:id/route`.

## F2 — Ride profile fields — ✅ SHIPPED 2026-08-20

`sql/010-event-profile.sql` (additive): `events.activity_type`, `level`, `organizer_group`,
plus a partial browse index.

Accepted on create and update, and returned on **both** the detail and the list summary — a
list of cards must not need a detail call each to show a difficulty badge. `activityType` is
its own enum, deliberately distinct from `events.type` (RIDE | RACE), which is the frozen
Android field.

This kills `podium-client/src/store/eventExtrasStore.ts`: a ride's difficulty and club were
previously visible only in the browser that created it.

## F6 — Offline de-duplication — ✅ SHIPPED 2026-08-20

`src/middleware/clientActions.ts`, plus `sql/011-client-action-results.sql`.

`sql/006` had described the behaviour since the beginning but gave the table nowhere to keep
the original result — and the client's `apiMutate` reads `body.data` out of the 409 and
returns it as the action's value, so a bodyless 409 would have handed the rider `undefined`
and called it success. The two new columns fix that.

- A failed action **releases** its claim, so a transient error stays retryable with the same id.
- A missing or malformed header is ignored, never rejected — a client bug must not cost a
  rider their entry.
- The middleware fails open if the table is unreachable.
- Not applied to the three frozen Android endpoints: both are already idempotent.

## E7 — Bulk participant import — ✅ SHIPPED 2026-08-20

`POST /events/:eventId/participants/import` takes up to 500 rows in one `withTransaction`.
A spreadsheet that fails on row 41 leaves the start list exactly as it was.

## X3/X5 — Public browse — ✅ SHIPPED (server side)

`GET /events/public?q=&type=&bucket=&activityType=&level=&sort=&limit=&offset=` returning
`{ data, total, limit, offset }`. `bucket` is the Live/Upcoming/Finished pill expressed as the
question a rider asks: "finished" includes a ride whose end time passed but whose status
nobody flipped. Sort defaults follow the bucket.

**The client is not wired up**, so M1 is still live in the app — see C7.

## F3 — Results & history — ✅ SHIPPED 2026-08-20

**This is the first wave that needs SQL run: `sql/009-results.sql`** (additive, safe on live
data — `event_participants.team`, `country_code`, and a partial index on finishers).

```
PATCH /events/:eventId/participants/:participantId/attendance   { status }
PATCH /events/:eventId/participants/:participantId/result       { status, finishedAt?, finishPosition? }
GET   /events/:eventId/results                  optionalAuth, tier-gated
GET   /events/:eventId/tracks                   the saved ride lines
GET   /events/:eventId/tracks/:participantId    one rider's line
```

**The finish hook** (`results/track-writer.ts`) is the important half. At `live → finished` it
reads every raw point of the event, groups by rider, and writes one simplified line per rider
into `participant_tracks`. It is idempotent on `(event_id, participant_id)` and **never throws
into the caller** — finishing a ride is the organizer's action and must succeed even if this
fails; a failure is loud in the log and the lines can still be rebuilt until the raw points
are purged. It lives in its own file so `events` and `results` do not import each other.

Decisions worth knowing:

- **Place and category place are computed at read time, never stored.** A stored rank drifts
  the moment one finish time is corrected — and correcting a time is the most common thing an
  organizer does after a ride. Same rule as `computeEffectiveStatus`.
- **A hand-set `finish_position` beats the clock.** The organizer was standing at the line;
  the timestamps were not. Ties and blanks fall back to `finished_at`.
- **Elapsed time runs from the event's start**, not the rider's first GPS fix — otherwise a
  rider whose phone woke up late looks faster than they were.
- **The leader's gap is `null`, not `"+0:00"`.** They are not behind anyone.
- **Correcting a finisher to DNF clears the time and the position**, or they stay in the
  ranking forever.
- **Rejected riders are not in the results at all** — a rejected registration is not a DNS,
  they were never in the ride.
- `result_status: "stopped"` reports as `"dnf"`: the client's vocabulary has no separate word,
  and to a reader of a results list they mean the same thing. The distinction survives in the
  column.
- **Track density is 2000 points, not the route preview's 300** — this line *is* the history;
  once the raw points are purged there is no fuller copy to fall back on.
- **`show_history_locations` is stricter than `show_results`** (FALSE vs TRUE by default), and
  a rider may always see their own line regardless. Where someone rode is their route home.
- **The `show_*` flags can now be changed on a live or finished ride.** They are sharing
  switches, not ride details — and the natural moment to open the tracks or the results is
  exactly the moment the old blanket lock forbade. Name, date, place and description stay
  locked once live.

`splits` is always `[]`: `event_splits` is the races-later part, deliberately unbuilt.

**Client work to pick this up:** swap `resultsStore.ts` off `lib/mock-results.ts`, and replace
the localStorage attendance/finished overlay in `participantsStore.ts` with the two PATCH
endpoints. Note two shape differences from the mock — `countryCode` is nullable (nothing
fabricates a country), and `route` uses the same shape as everywhere else in the API
(`previewPoints: {lat,lng}[]`) rather than a results-only tuple form.

## F4 — Ride groups — ✅ SHIPPED 2026-08-20

`sql/012-ride-groups.sql`: `event_groups` plus `event_participants.group_id`.

```
GET    /events/:eventId/groups              follows the riders-list rules
POST   /events/:eventId/groups              (owner)
PATCH  /events/:eventId/groups/:groupId     (owner)
DELETE /events/:eventId/groups/:groupId     (owner)
POST   /events/:eventId/groups/assign       bulk assign, or unassign with groupId: null
```

- **A group is not a category.** `event_participants.category` is which class you are scored
  in; a group is who you ride with. One Saturday ride at two paces is one event with two
  groups, and nobody is placed against the other group.
- `startsAt: null` and `routeId: null` are **instructions, not omissions** — "rides with the
  event" and "uses the event's track" are real answers, so the schema is `.nullable()` and the
  UPDATE uses `CASE WHEN ... THEN NULL` rather than COALESCE.
- **Deleting a group un-assigns its riders, never removes them.** Tidying up groups must not
  drop anyone from the start list.
- Assignment is **bulk and validated as a whole**: an unknown participant id refuses the
  entire request, because a partly-applied assignment leaves the organizer's screen
  disagreeing with the server about who is where.

## F5 — Teams & following — ✅ SHIPPED 2026-08-20

`sql/013-teams-and-follows.sql`: `teams`, `team_members`, `user_follows`, `events.team_id`.

```
POST   /teams                               (plan-limited)
GET    /teams                               teams I own OR am an approved member of
GET    /teams/:teamId                       owner or anyone on the roster; 404 otherwise
PATCH  /teams/:teamId                       (owner)
DELETE /teams/:teamId                       (owner)
GET    /teams/:teamId/members
POST   /teams/:teamId/members               bulk; organizer-added members are pre-approved
PATCH  /teams/:teamId/members/:memberId     approve / reject (owner)
DELETE /teams/:teamId/members/:memberId     (owner)
POST   /teams/:teamId/join                  a rider asking — lands as waiting_approval
PATCH  /events/:eventId/team                file a ride under a team (or null to unfile)
PUT    /users/:userId/follow
DELETE /users/:userId/follow
GET    /users/me/following
GET    /events?filter=following             upcoming public rides by people I follow
```

- **"My teams" finally means what it says.** The client could only ever show "teams I
  created", because a localStorage membership row had no account link. It now includes teams
  you are an approved member of.
- **A team is not a browse surface** — unlike public events and the route library there is no
  guest view; a stranger gets 404, same reasoning as a private event.
- **Following is public-only.** Following someone is not an invitation to their private rides.
- **Linking a ride to a team requires owning both**, so nobody re-files someone else's ride
  and nobody hangs their ride off a club they do not run.
- **Deleting a team unlinks its rides** rather than orphaning them — no foreign keys here.
- Member names resolve from the linked account at read time, same rule as the start list, and
  the insert re-joins through a CTE so a rider who just asked to join is not handed a nameless
  row.

## F6 — Offline de-duplication — ✅ SHIPPED 2026-08-20

`src/middleware/clientActions.ts`, plus `sql/011-client-action-results.sql`.

`sql/006` had described the behaviour since the beginning but gave the table nowhere to keep
the original result — and the client's `apiMutate` reads `body.data` out of the 409 and
returns it as the action's value, so a bodyless 409 would have handed the rider `undefined`
and called it success. The two new columns fix that.

- A failed action **releases** its claim, so a transient error stays retryable with the same id.
- A missing or malformed header is ignored, never rejected — a client bug must not cost a
  rider their entry.
- The middleware fails open if the table is unreachable.
- Not applied to the three frozen Android endpoints: both are already idempotent.

## E7 — Bulk participant import — ✅ SHIPPED 2026-08-20

`POST /events/:eventId/participants/import` takes up to 500 rows in one `withTransaction`.
A spreadsheet that fails on row 41 leaves the start list exactly as it was.

## X3/X5 — Public browse — ✅ SHIPPED (server side)

`GET /events/public?q=&type=&bucket=&activityType=&level=&sort=&limit=&offset=` returning
`{ data, total, limit, offset }`. `bucket` is the Live/Upcoming/Finished pill expressed as the
question a rider asks: "finished" includes a ride whose end time passed but whose status
nobody flipped. Sort defaults follow the bucket.

**The client is not wired up**, so M1 is still live in the app — see C7.

## F3 — Results & history — ✅ SHIPPED 2026-08-20

**This is the first wave that needs SQL run: `sql/009-results.sql`** (additive, safe on live
data — `event_participants.team`, `country_code`, and a partial index on finishers).

```
PATCH /events/:eventId/participants/:participantId/attendance   { status }
PATCH /events/:eventId/participants/:participantId/result       { status, finishedAt?, finishPosition? }
GET   /events/:eventId/results                  optionalAuth, tier-gated
GET   /events/:eventId/tracks                   the saved ride lines
GET   /events/:eventId/tracks/:participantId    one rider's line
```

**The finish hook** (`results/track-writer.ts`) is the important half. At `live → finished` it
reads every raw point of the event, groups by rider, and writes one simplified line per rider
into `participant_tracks`. It is idempotent on `(event_id, participant_id)` and **never throws
into the caller** — finishing a ride is the organizer's action and must succeed even if this
fails; a failure is loud in the log and the lines can still be rebuilt until the raw points
are purged. It lives in its own file so `events` and `results` do not import each other.

Decisions worth knowing:

- **Place and category place are computed at read time, never stored.** A stored rank drifts
  the moment one finish time is corrected — and correcting a time is the most common thing an
  organizer does after a ride. Same rule as `computeEffectiveStatus`.
- **A hand-set `finish_position` beats the clock.** The organizer was standing at the line;
  the timestamps were not. Ties and blanks fall back to `finished_at`.
- **Elapsed time runs from the event's start**, not the rider's first GPS fix — otherwise a
  rider whose phone woke up late looks faster than they were.
- **The leader's gap is `null`, not `"+0:00"`.** They are not behind anyone.
- **Correcting a finisher to DNF clears the time and the position**, or they stay in the
  ranking forever.
- **Rejected riders are not in the results at all** — a rejected registration is not a DNS,
  they were never in the ride.
- `result_status: "stopped"` reports as `"dnf"`: the client's vocabulary has no separate word,
  and to a reader of a results list they mean the same thing. The distinction survives in the
  column.
- **Track density is 2000 points, not the route preview's 300** — this line *is* the history;
  once the raw points are purged there is no fuller copy to fall back on.
- **`show_history_locations` is stricter than `show_results`** (FALSE vs TRUE by default), and
  a rider may always see their own line regardless. Where someone rode is their route home.
- **The `show_*` flags can now be changed on a live or finished ride.** They are sharing
  switches, not ride details — and the natural moment to open the tracks or the results is
  exactly the moment the old blanket lock forbade. Name, date, place and description stay
  locked once live.

`splits` is always `[]`: `event_splits` is the races-later part, deliberately unbuilt.

**Client work to pick this up:** swap `resultsStore.ts` off `lib/mock-results.ts`, and replace
the localStorage attendance/finished overlay in `participantsStore.ts` with the two PATCH
endpoints. Note two shape differences from the mock — `countryCode` is nullable (nothing
fabricates a country), and `route` uses the same shape as everywhere else in the API
(`previewPoints: {lat,lng}[]`) rather than a results-only tuple form.

## F4 — Ride groups *(T2)* — new `sql/011-ride-groups.sql`

```sql
-- 011-ride-groups.sql — 2-4 groups riding one event (Beginner / Elite), each with its own
-- start time and optionally its own track. Not a results/category concept.
CREATE TABLE IF NOT EXISTS event_groups (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id   UUID NOT NULL,
    name       VARCHAR(120) NOT NULL,
    starts_at  TIMESTAMPTZ,              -- independent of events.starts_at
    route_id   BIGINT,                   -- optional own track; falls back to the event's route
    sort_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Every group of one event, in display order.
CREATE INDEX IF NOT EXISTS idx_event_groups_event ON event_groups (event_id, sort_order);

ALTER TABLE event_participants
    ADD COLUMN IF NOT EXISTS group_id BIGINT;
-- "Who is in this group" on the groups screen.
CREATE INDEX IF NOT EXISTS idx_event_participants_group ON event_participants (group_id);
```

Endpoints: `GET|POST /events/:id/groups`, `PATCH|DELETE /events/:id/groups/:groupId`, and
`groupId` on the participant update schema (+ a bulk assign — the client's `setGroupIdBulk`
exists because assigning 20 riders one at a time is the actual complaint).

## F5 — Teams & following *(T1, T3, T4)* — new `sql/012-teams-and-follows.sql`

```sql
-- 012-teams-and-follows.sql — clubs with real membership, and following an organizer.
CREATE TABLE IF NOT EXISTS teams (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        VARCHAR(200) NOT NULL,
    owner_id    BIGINT NOT NULL,
    avatar_url  VARCHAR(500),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_teams_owner ON teams (owner_id);

-- Mirrors event_participants: a member may have no account yet (added by hand or from a file).
CREATE TABLE IF NOT EXISTS team_members (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    team_id    BIGINT NOT NULL,
    user_id    BIGINT,                       -- NULL until they sign up
    name       VARCHAR(200),
    email      VARCHAR(255),
    phone      VARCHAR(100),
    status     VARCHAR(30) NOT NULL DEFAULT 'invited',  -- invited | waiting_approval | approved | rejected
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Roster for one team.
CREATE INDEX IF NOT EXISTS idx_team_members_team ON team_members (team_id);
-- "My teams" for a signed-in rider. NULLs are distinct, so account-less members coexist.
CREATE UNIQUE INDEX IF NOT EXISTS team_members_team_user_key ON team_members (team_id, user_id);

ALTER TABLE events ADD COLUMN IF NOT EXISTS team_id BIGINT;
-- A team's schedule.
CREATE INDEX IF NOT EXISTS idx_events_team ON events (team_id);

-- "Follow this creator and see their future rides."
CREATE TABLE IF NOT EXISTS user_follows (
    follower_id BIGINT NOT NULL,
    followee_id BIGINT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (follower_id, followee_id)
);
-- "Who follows me" / follower counts.
CREATE INDEX IF NOT EXISTS idx_user_follows_followee ON user_follows (followee_id);
```

## F6 — Offline de-dup *(X1)*

No schema work — `client_actions` already exists. Add middleware: read `X-Client-Action-Id`
on mutating routes, `INSERT … ON CONFLICT DO NOTHING`, and on conflict return the recorded
result. The client is already sending the header on every mutation and already treats a 409
as success.

---

# Suggested order

| Wave | Items | Why |
|---|---|---|
| ~~**1 — P0 bug fixes**~~ **✅ done** | R4 (names), C3 (private + approved), C4 (tiering), E2 (create flags), W3, L2 | Small, in existing code, each unblocked a step in the core story. No schema change. |
| ~~**2 — Routes**~~ **✅ done** | F1 | Unblocked guest browsing (the app's front door), track upload, copy-a-track, and every map. Tables already existed. |
| ~~**3 — Results & history**~~ **✅ done** | F3 | Was time-sensitive: `participant_tracks` had to exist before any raw-point purge ran. It does now. |
| ~~**4 — Ride profile + de-dup**~~ **✅ done** | F2, F6, E7 bulk, T4 (real organizer), X3/X5 (list params) | Cheap, high visible value — kills `eventExtrasStore` and the fake organizer name. |
| ~~**5 — Groups, teams, follow**~~ **✅ done** | F4, F5 | Fully built screens that had no backend. |
| ~~**6 — Plan limits**~~ **✅ done** | Stage 10 | `lib/plan-limits.ts`. Still no billing to upgrade *to*. |

## SQL run order after this work

Append to `sql/README.md`'s fresh-database list, in order:

```
009-event-profile.sql   010-results.sql   011-ride-groups.sql   012-teams-and-follows.sql
```

All four are additive and safe on the live database. Same rules as the existing files: every
timestamp `TIMESTAMPTZ`, no foreign keys, every index names its query in a comment, and
nothing renames a column the Android transmitter reads.
