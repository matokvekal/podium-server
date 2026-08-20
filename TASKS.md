# TASKS — lead agent running list

Every task the user gives me gets written here **before** work starts, and is worked
**one at a time**. Durable knowledge that outlives a task goes in [CONTEXT.md](CONTEXT.md),
never here.

**Status key:** `TODO` · `IN PROGRESS` · `BLOCKED` · `DONE` · `DROPPED`

**Last updated:** 2026-08-20

> **Path convention:** this file lives in `podium-server/`, but every path below is
> relative to the **workspace root** (`C:\dev2026\podiom`) — the parent directory that
> holds `podium-client/`, `podium-server/`, and `examples/`. So `podium-server/src/...`
> means the sibling path from that root, not a nested one.


---

## Active

### T-005 — Client↔server connectivity audit, and the server work it implies
**Status:** DONE · 2026-08-20 — audit plus all six waves shipped
**Given:** 2026-08-20

Owner walked through the full product story (guest PWA browsing → Google sign-in → join open
rides → closed rides by QR + approval → live → history → creator: create/track/riders/groups/
teams/limits). Asked for a file that goes through it **one by one**, says whether the server
matches, and comments.

Result: **[CLIENT-SERVER-AUDIT.md](CLIENT-SERVER-AUDIT.md)** — 10 stages, ~45 numbered items,
each ✅/⚠/❌ with the file:line and the fix. Read that, not this entry, for detail.

- [x] Map every client page/store against every server route
- [x] Walk the story stage by stage, verdict + comment per item
- [x] Write DB fix instructions (four new additive SQL files, 009–012)
- [x] Wave 1 — P0 bug fixes (R4, C3, C4, E2, W3, L2) — no schema change, no SQL to run
- [x] Wave 2 — routes/tracks module (F1) — no schema change, no SQL to run
- [x] Wave 3 — results + history, incl. the finish hook (F3) — ⚠ **run `sql/009-results.sql`**
- [x] Wave 4 — ride profile fields, offline de-dup, bulk import, real organizer, browse
      filters (F2, F6, E7, T4, X3/X5) — ⚠ **run `sql/010` and `sql/011`**
- [x] Wave 5 — ride groups, teams, follow (F4, F5) — ⚠ **run `sql/012` and `sql/013`**
- [x] Wave 6 — plan limits (`lib/plan-limits.ts`) — no schema change

**The four P0s** (small, existing code, each dead-ends a step the owner described):
1. Joined riders have **no name** anywhere — `upsertParticipant` never writes one and no
   query resolves it from `users` (`event.queries.ts:318`).
2. An **approved rider still gets 403** on a private event — `getEventForViewer` is
   owner-only (`event.service.ts:222`). The whole QR→approve→see-it flow dead-ends.
3. **No viewer tiering** — `show_event_info`/`show_route`/`show_results`/
   `show_history_locations` are stored, echoed back, and never enforced.
4. `POST /events` **silently drops `showParticipants`** — zod strips it, it's not in
   `createEventSchema` (`event.schemas.ts:12`).

Also confirmed stale: `EventCreatePage.tsx`'s comment saying approval-on-join isn't built.
The server does it correctly (`event.service.ts:86`).

**Wave 1, as shipped** — 105/105 tests pass, typecheck clean, no schema change, frozen
Android endpoints untouched:

- `event.queries.ts` — `PARTICIPANT_DISPLAY_COLUMNS`: participant name resolved from `users`
  at read time (never copied at join time, so fixing a profile fixes every past ride). Both
  participant SELECTs join it; both UPDATEs re-join through a CTE, or approving a rider would
  blank the name the client had just rendered.
- `event.service.ts` — `getEventForViewer` now returns `{ event, tier }` with
  `ViewerTier = owner | approved | pending | public | stranger`. A participant row is a key in
  its own right, so an approved rider can finally open a private ride. A stranger on a private
  ride gets **404, not 403** — the id is the shared secret.
- `event.controller.ts` — `canViewEventInfo()` redacts `startsAt`/`endsAt`/`location`/
  `description` for a pending rider on a **private** ride; `viewerTier` and `canViewEventInfo`
  are new response fields. Public + pending still sees whatever a stranger sees (keying on
  visibility, not tier alone — `show_event_info` defaults TRUE and is a *browsing* switch).
- `event.schemas.ts` / `insertEvent` — all six `show_*` flags accepted on create; null means
  "keep the column default", spelled out as COALESCEs.
- `selectEventsForUser` — a rejected participation no longer counts as a join. Filter is in
  the JOIN, not the WHERE, so it can't drop an event the user owns.
- `getLiveRiders` — a rider's own dot always shows and does not spend one of the 5 viewer
  slots; `show_live_locations` now gates only *other* riders.
- `EventParticipant.avatarUrl` added, surfaced on the participants list and on `LiveRider`.
- `tests/support/fake-db.ts` taught the new joined SQL (`withUserDisplay`), plus 12 new tests
  covering the closed-ride flow end to end.

**Wave 2, as shipped** — 129/129 tests pass, typecheck clean, **no schema change** (the tables
were already in `sql/004-routes.sql`, unused):

New `src/modules/routes/` — endpoints exactly as `plan/07-api-contract.md` specifies:
`POST /routes`, `GET /routes`, `GET /routes/public`, `GET /routes/:routeId`,
`PATCH|DELETE /routes/:routeId`, plus `POST|DELETE /events/:eventId/route`.

- **A list never selects `track_points`.** `ROUTE_SUMMARY_COLUMNS` names every other column
  explicitly, so geometry cannot leak into a list by accident; a test asserts it on each one.
  Full geometry is only `GET /routes/:routeId`.
- Distance, climb, bbox, start/end and a 300-point preview are computed **once at upload**
  via `lib/geo.ts`, never on read.
- **Unknown climb stays `null`, never `0`** — and the elevation filters deliberately do not
  match NULL rows, so "under 200 m of climb" cannot return a route of unknown profile.
- Parsing stays client-side (`lib/track-gpx.ts`, `lib/track-csv.ts` already do it); the server
  takes points, so uploaded / drawn / copied routes all arrive through one door.
- **"Copy another ride's track" is an attach, not a copy** — one `event_routes` row pointing
  at the same route. Attaching replaces the previous row rather than stacking.
- `app.ts` gives `/api/v1/routes` its own **4 MB body limit**; the global 100 kb would have
  413'd every real GPX. Mounted before the global parser, which no-ops on a parsed body.
- Event detail now carries `route` (preview only), gated by `canViewRoute()`: owner/approved
  always, **pending never**, public browsers by `show_route`. Present on mutation replies too
  — EventDetailPage swaps a PATCH response into state, so dropping it would blank the map on
  rename.
- An unpublished route 404s for anyone but its owner; deleting one detaches it from every
  event first (no foreign keys in this schema).
- `tests/routes.test.ts` — 24 tests; `fake-db.ts` gained the `routes` / `event_routes` tables.

**Client work this unblocks** (not done, `podium-client`): point `eventRouteStore.ts` /
`resultsStore.ts` at the real endpoints, and POST the already-parsed points from
`EventCreatePage.tsx` to `/routes`, then `/events/:id/route`.

**Wave 3, as shipped** — 146/146 tests pass, typecheck clean, lint clean.

⚠ **This is the first wave with SQL to run: `sql/009-results.sql`** (additive, safe on live
data — `event_participants.team`, `country_code`, and a partial index on finishers).

New `src/modules/results/`, plus two write endpoints on the participants module:

```
PATCH /events/:id/participants/:pid/attendance   { status }
PATCH /events/:id/participants/:pid/result       { status, finishedAt?, finishPosition? }
GET   /events/:id/results
GET   /events/:id/tracks
GET   /events/:id/tracks/:participantId
```

- **The finish hook** (`results/track-writer.ts`) runs at `live → finished`: reads every raw
  point, groups by rider, writes one simplified 2000-point line per rider into
  `participant_tracks`. Idempotent on (event, participant); **never throws into the caller**,
  since finishing a ride must succeed even if track-building fails. Its own file so `events`
  and `results` do not import each other.
- **Place and category place are computed at read time, never stored** — a stored rank drifts
  the moment a finish time is corrected. A hand-set `finish_position` beats the clock.
- Elapsed time runs from the event's `starts_at`, not the rider's first fix. The leader's gap
  is `null`, never "+0:00". Correcting a finisher to DNF clears time and position.
- Rejected riders are absent from results entirely — not listed as DNS.
- `show_history_locations` (default FALSE) is stricter than `show_results` (default TRUE), and
  a rider may always fetch their own line regardless.
- **Behaviour change:** the six `show_*` flags may now be PATCHed on a **live or finished**
  ride. Previously every edit was locked once live, which made it impossible to open the
  tracks or results after a ride — the only moment anyone would want to. Name/date/place/
  description stay locked.
- **Bug found and fixed on the side:** `docker/postgres/Dockerfile` had never been updated for
  `008-registration-and-live.sql`, so every locally-built dev database was missing
  `requires_approval` and `is_paused`. Added, along with `009`.
- `tests/results.test.ts` — 16 tests; `fake-db.ts` gained `participant_tracks` and the two new
  status writes.

**Client work this unblocks:** swap `resultsStore.ts` off `lib/mock-results.ts`; replace the
localStorage attendance/finished overlay in `participantsStore.ts` with the two PATCH
endpoints. Two shape notes: `countryCode` is nullable, and `route` uses the API-wide
`previewPoints: {lat,lng}[]` rather than the mock's tuple form. See NOTES.md §3 (C9–C12).

**Wave 4, as shipped** — 164/164 tests pass, typecheck clean, lint clean.

⚠ **Run `sql/010-event-profile.sql` and `sql/011-client-action-results.sql`** (both additive).

- **Ride profile fields** — `events.activity_type` / `level` / `organizer_group`, accepted on
  create and update, returned on the **list summary** as well as the detail so a card can show
  a difficulty badge without a detail call each. Kills `eventExtrasStore.ts` client-side.
- **The real organizer** — `owner: { id, name, avatarUrl }` on the event detail. Every ride in
  the app currently displays a fake name invented from the event id (`mockOrganizerName`).
- **Public browse, server-side** — `q`, `type`, `bucket`, `activityType`, `level`, `sort`,
  `limit`, `offset`, returning `{ data, total, limit, offset }`. `bucket` is the pill as a
  question, not a status: "finished" includes a ride whose end time passed but whose status
  nobody flipped. Sort default follows the bucket — soonest-first upcoming, latest-first
  finished. **The client still filters in memory, so the M1 bug is live until it is wired up.**
- **Bulk import** — `POST …/participants/import`, up to 500 rows in one transaction. A
  spreadsheet failing on row 41 leaves the list exactly as it was.
- **Offline de-duplication** — `middleware/clientActions.ts` on every mutating route except the
  frozen Android three. A replay is answered 409 **carrying the original result**, because
  `sql/006` promised that and the client's `apiMutate` reads `body.data` from the 409; a
  bodyless 409 would have handed the rider `undefined`. Needed two new columns (`sql/011`).
  A failed action releases its claim so it stays retryable; a malformed header is ignored; the
  middleware fails open if the table is unreachable.
- `tests/event-browse.test.ts` — 18 tests.

**Client work this unblocks:** NOTES.md §3, C13–C17. Note C17 — `apiMutate` has **no call
sites** in the client today, so nothing actually exercises the de-dup path yet.

**Waves 5 and 6, as shipped** — 184/184 tests pass, typecheck clean, lint clean.

⚠ **Run `sql/012-ride-groups.sql` and `sql/013-teams-and-follows.sql`** (both additive).

- **Ride groups** — `event_groups` + `event_participants.group_id`, with bulk assign. A group
  is *not* a category (who you ride with vs. which class you are scored in). `null` start time
  and route are instructions ("rides with the event", "uses the event's track"), so the UPDATE
  uses `CASE WHEN ... THEN NULL`, not COALESCE. Deleting a group **un-assigns** its riders
  rather than removing them.
- **Teams** — `teams`, `team_members`, `events.team_id`. "My teams" now includes teams you are
  an approved member of, which the localStorage store could never express because a membership
  row had no account link. Not a browse surface: a stranger gets 404. Deleting a team unlinks
  its rides rather than orphaning them.
- **Following** — `user_follows`, plus `GET /events?filter=following` for their upcoming
  **public** rides. Following someone is not an invitation to their private rides.
- **Plan limits** — `lib/plan-limits.ts`: rides per rolling week, riders per ride, groups per
  event, teams per owner. **409 with a `PLAN_LIMIT_*` code**, not 403 — the caller is
  permitted, they are out of allowance. A self-joiner counts against the organizer's rider cap.
  ⚠ **No billing exists**, so every account is on the free tier with nothing to upgrade to.
- `tests/groups-teams.test.ts` — 20 tests.

**Client work:** NOTES.md §3, C18–C21. C21 is new UI — no follow control exists client-side.

---

**T-005 closed.** All six waves of CLIENT-SERVER-AUDIT.md are shipped. Outstanding server work
is now: per-event roles (`event_members` still unread), billing, races, Find Tracks, and the
purge jobs — see AGENT.md's "what this server does not do yet" and NOTES.md §2.

### T-002 — Filtering, end-to-end (client + server)
**Status:** BLOCKED — waiting on the user
**Given:** 2026-08-20

Original wording was "Implement Inventory filtering end-to-end". **There is no
Inventory domain in this codebase** — user confirmed "not inventory", it is a bike
riders meet-up and tracking app. The target list is therefore undecided.

Blocking question: filter **which list**?
- events / rides (most likely — partial server filter already exists)
- participants / riders within one event
- something else

Steps:
1. [x] frontend-agent: inspect how the client sends filters
2. [x] backend-agent: inspect what the server accepts
3. [x] Compare both sides — findings in CONTEXT.md §3/§4, mismatches below
4. [ ] Decide required changes per side — **blocked on target list**
5. [ ] Assign and implement on each side
6. [ ] Verify final API contract
7. [ ] Integration review — report mismatches

**Mismatches found (step 3).** Ranked; all need BOTH sides:
- **M1 (bug)** `/events/public` defaults to `limit=20`; client never sends
  `limit`/`offset`. All client-side pills/search filter one page of 20 rows —
  "Finished" can show empty while finished events exist past row 20.
- **M2** No `q`/search param on any list endpoint; four search boxes filter in memory.
- **M3** No `sort`/`order` param anywhere; My Rides sort and participants sort are in-memory.
- **M4** No `type` or `status` param on `/events/public`; pills and the RIDE-only
  filter are client-side.
- **M5** `/events/:id/participants` has **no query schema at all**; search by
  name/bib is in-memory, though every needed column exists.
- **M6** `filter=upcoming|live|past` works server-side but the client never sends
  it — it re-derives those buckets in memory.
- **M7 (type drift)** `ServerParticipant` omits `finishedAt` and `finishPosition`
  that the server does send. Client-only fix.
- **M8** `favorite` is client-invented with no DB column — cannot become a server
  filter without a schema change.
- **M9** `TracksPage`'s whole filter suite targets a `/tracks` module that does not
  exist. Out of scope for filtering work; it is a build-the-feature task.

---

## Done

### T-004 — Store Google profile data on first sign-in
**Status:** DONE · 2026-08-20

Google's ID token already carries the profile; the server was throwing it away. Now read
and persisted at account creation.

- [x] `podium-server/src/lib/google-auth.ts` — `GoogleIdentity` gains `firstName`,
      `lastName`, `displayName`, `picture` (was a single `name`). Verification untouched.
- [x] `podium-server/src/db/types.ts` + `users/user.queries.ts` — `User.avatarUrl` maps
      the `users.avatar_url` column that already existed but was never read
- [x] `podium-server/src/modules/auth/auth.service.ts` — `resolveUser()` takes an optional
      profile applied **only on the create branch**
- [x] `podium-server/src/modules/users/user.controller.ts` — `/users/me` now returns
      `avatarUrl` (small addition beyond the ask; without it the stored value is
      unreachable and untestable)
- [x] tests: 3 new cases in `tests/auth-google.test.ts` + `fake-db` insert signature
- [x] typecheck clean · 93/93 tests pass · no new lint errors

**No migration needed** — `avatar_url` is in `sql/001-init.sql` and `sql/007-users-avatar.sql`.

Constraints held: identity key is still Google `sub`; token/session/JWT/refresh untouched;
no People API, no extra scopes, no phone; `needsProfile()` unchanged — nickname stays NULL
after a Google sign-in, so profile setup still runs.

### T-001 — Create frontend-agent and backend-agent
**Status:** DONE · 2026-08-20

- `.claude/agents/frontend-agent.md` — owns `podium-client`
- `.claude/agents/backend-agent.md` — owns `podium-server`

Both carry ownership boundaries and contract-safety rules. See CONTEXT.md for the
registry-reload gotcha.

### T-003 — Persist tasks and knowledge across sessions
**Status:** DONE · 2026-08-20

Created `TASKS.md` (this file) and `CONTEXT.md`, and linked both from the root
`AGENT.md` so a cold session finds them.

---

## Dropped

_none_
