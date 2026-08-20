# NOTES — every comment, decision and caveat, in one place

Running log of the commentary behind the server work: **why** things are the way they are,
what will bite later, and what is deliberately left undone. Written so nothing important
lives only in a chat scrollback.

**Last updated:** 2026-08-20

> **Path convention:** paths are relative to the workspace root (`C:\dev2026\podiom`).

## Where things live

| File | Holds |
|---|---|
| [CLIENT-SERVER-AUDIT.md](CLIENT-SERVER-AUDIT.md) | the full client↔server walkthrough, stage by stage, ✅/⚠/❌ per item |
| [TASKS.md](TASKS.md) | the running task list, one task at a time |
| [CONTEXT.md](CONTEXT.md) | durable knowledge for a cold session |
| **NOTES.md** (this file) | decisions + reasoning, caveats, client-side follow-ups, stale docs |

---

# 1. Decisions, and what was rejected

Each of these had a plausible alternative. The alternative is written down too, so nobody
re-litigates it from scratch or "fixes" it back.

## 1.1 Participant names are resolved on read, never copied on write

`PARTICIPANT_DISPLAY_COLUMNS` (`event.queries.ts`) resolves
`event_participants.name` → the linked user's first+last → their nickname, in SQL, on every
read.

**Rejected:** writing the name into `event_participants.name` at join time. It is one fewer
join, but the name then goes stale the moment a rider corrects their profile, and it would go
stale *per event* — you would be fixing the same typo in every ride they had ever entered.
`sql/003-participants.sql` already stated this intent; it had simply never been implemented.

**Consequence to remember:** any new query that returns participants for display must join
`users AS u` and include those columns, or the name silently falls back to the raw (usually
NULL) column. The constant is exported for exactly that reason.

## 1.2 Participant UPDATEs re-join through a CTE

`updateParticipant` and `updateRegistrationStatus` wrap the UPDATE in `WITH updated AS (...)`
and join `users` on the way out.

**Why:** the client swaps the response row straight into its list. A bare `RETURNING *` sends
back a NULL name, so approving a rider would blank out the name the organizer was looking at
at the exact moment they clicked. The bug would look like "approve broke the list".

## 1.3 A private event 404s a stranger — it does not 403

`getEventForViewer` throws 404, not 403, for a private event the caller has no participant row
on.

**Why:** the event id is what gets shared as a link or QR. It *is* the secret. A 403 confirms
the id is real, which is exactly the thing the secret is protecting. Same rule applied to
unpublished routes.

**Consequence:** this is a behaviour change for the client — two tests that asserted 403 were
updated. Any client code branching on 403 for "private" needs to handle 404.

## 1.4 `registered` counts as the "approved" tier

An event that requires no approval leaves self-joiners at `registration_status = 'registered'`
and never moves them on. If only `'approved'` counted, every rider on every open ride would be
treated as an outsider. Both statuses map to tier `approved`.

## 1.5 Pending redaction keys on **visibility**, not on the tier alone

`canViewEventInfo()`: owner and approved always see the details; everyone else sees them only
when the event is **public** and `show_event_info` is on.

**Rejected — gate pending on `show_event_info` alone:** that column defaults to `TRUE`, so a
waiting rider would have seen everything and the approval gate would have been decorative.

**Rejected — hide details from `pending` unconditionally:** on a *public* ride that leaves a
rider who asked to join worse off than a stranger who did not, which is absurd.

So: private + pending → redacted. Public + pending → whatever any browser gets.

## 1.6 `canViewRoute` is stricter than `canViewEventInfo`

A `pending` rider gets **no route, ever**, even on a public ride — it does not fall back to the
public rule the way the info fields do.

**Why:** the track is named explicitly in the product story as the thing an unapproved rider
must not have ("still will not see details like track time and place"). A closed ride's route
is the organizer's to hand out, and asking to join is not being handed it.

## 1.7 The rejected-rider filter sits in the JOIN, not the WHERE

`selectEventsForUser`. In the WHERE it would also drop events the user **owns** but was
rejected from. That cannot happen today — you cannot be a rejected participant on your own
ride — but it becomes possible the moment co-organizers land, and it would be a silent
disappearance rather than an error.

## 1.8 Seeing yourself on the live map is not one of your 5 slots

`show_live_locations` gates seeing **other** riders — the product story says "see other riders
if creator allows that". It was never meant to hide a rider from themselves; before this, a
participant on a ride with sharing off got a 403 and a blank map.

**Consequence, stated plainly:** a rider who is *in* the event can now see 6 markers (their own
plus 5 chosen others), where a pure spectator sees 5. The cap is about how many other people
one screen may follow; making a rider choose between watching a friend and seeing where they
are is not what it was for.

## 1.9 `show_*` flags on create use COALESCE, not zod defaults

`createEventSchema` marks all six `.optional()` with no default, and `insertEvent` wraps each
in `COALESCE($n, <the column default>)`.

**Why:** an explicit INSERT column list cannot fall back to `DEFAULT` per row. `undefined` from
the client has to mean "leave the column default alone", not "set it to false" — otherwise
adding a field to the form would silently flip settings for every client that had not been
updated yet. The COALESCE defaults duplicate `sql/002-events-podium.sql`; that duplication is
deliberate and commented at both ends.

## 1.10 A route list never selects `track_points`

`ROUTE_SUMMARY_COLUMNS` names every column *except* the geometry, rather than using `r.*`.

**Why:** `track_points` is the largest column in the database, and the route browser paints a
dozen map previews on one screen. Naming the columns means a list cannot leak geometry by
accident — `r.*` would have, the first time someone added a query. A test asserts
`trackPoints === undefined` on every list endpoint.

## 1.11 Everything derived about a route is computed once, at upload

Distance, climb, bbox, start/end, and the 300-point preview — all in `createRoute`, via
`lib/geo.ts`, never on read. Same rule `computeEffectiveStatus` follows for events.

`PREVIEW_POINT_TARGET = 300`: a route card is a thumbnail a few hundred pixels wide. Past that,
extra points cost bytes and buy no visible detail, and full geometry is one request away.

## 1.12 Unknown climb is `null`, and never matches an elevation filter

`sumClimbMeters` returns null when no point carried elevation. "Flat" and "we have no data"
are different answers. The filters in `selectPublicRoutes` deliberately do **not** match NULL
rows, so `?maxElevation=10` cannot quietly return every route of unknown profile.

## 1.13 Track parsing stays on the client

GPX/TCX/CSV are parsed in `podium-client/src/lib/track-gpx.ts` and `track-csv.ts` — already
working — and the server takes points.

**Why:** it keeps a malformed 20 MB file off the wire, and it means uploaded, drawn and copied
routes all arrive through one endpoint instead of three code paths.

## 1.14 "Copy another ride's track" is an attach, not a copy

`POST /events/:id/route` with the source ride's `routeId`. One `event_routes` row pointing at
the same route.

**Why:** duplicating the geometry would mean a corrected line has to be corrected N times, and
the library would fill with near-identical rows. Attaching also replaces the previous row
rather than stacking — the table permits several rows per event (it was designed with
per-group tracks in mind), but nothing reads more than one yet, and accumulating rows would
make "the event's route" ambiguous the first time someone changed their mind.

## 1.15 `/api/v1/routes` gets its own 4 MB body limit

`app.ts` mounts `express.json({ limit: "4mb" })` scoped to that path, **before** the global
`100kb` parser. body-parser no-ops on an already-parsed request, so everything else keeps the
tight limit.

**Why:** a 100 km GPX is tens of thousands of points, which is megabytes as JSON. The global
limit would have 413'd every real upload — and the failure would have looked like "route
upload is broken", not "the body limit is wrong".

## 1.16 The route is on **every** event-detail response

Including the create/update/status/pause/cancel replies, which costs one small query each.

**Why:** `EventDetailPage.tsx` swaps a PATCH response straight into its state. Returning the
route only on GET would make the map vanish the moment an organizer renamed their ride — one
query saved, one real bug bought.

## 1.17 Deleting a route detaches it from every event first

There are no foreign keys in this schema (`sql/README.md`), so nothing cleans up on its own and
the `event_routes` rows would dangle — every affected ride silently rendering no map.

**Worth surfacing in the UI:** deleting a *published* route takes the map away from organizers
who did not delete it and were not asked. `PATCH { isPublic: false }` is the reversible option
and is what "stop sharing this" should call. Delete is for a route nobody is using.

## 1.18 Ranks are computed at read time, and a hand-set position beats the clock

`rankFinishers` / `rankByCategory` in `results.service.ts`. Nothing about placing is stored.

**Why:** a stored rank drifts the moment one finish time is corrected — and correcting a time
is the single most common thing an organizer does after a ride. Same rule `computeEffectiveStatus`
follows.

`finish_position` set by hand outranks `finished_at`: the organizer was standing at the line
and the timestamps were not. Blanks and ties fall back to the clock.

## 1.19 Elapsed time runs from the event's start, not the rider's first GPS fix

A rider whose phone woke up late would otherwise appear faster than they actually were.
Riders set off together; the event's `starts_at` is the shared zero.

The leader's gap is `null`, never `"+0:00"` — they are not behind anyone.

## 1.20 Correcting a finisher clears their time and position

`setResult` nulls `finished_at` and `finish_position` for any status other than `finished`. A
rider corrected to DNF who kept a finish time would stay in the ranking forever.

## 1.21 The finish hook never throws into the caller

`writeParticipantTracks` catches everything and logs. Finishing a ride is the organizer's
action and must succeed even if track-building fails — and the tracks can still be rebuilt
from the raw points afterwards, which the log line says explicitly.

It is also idempotent on `(event_id, participant_id)`: an event finished twice, or a status
corrected and re-applied, must neither double-write nor fail.

## 1.22 Saved ride lines keep 2000 points, route previews keep 300

The saved line **is** the history — once the raw points are purged there is no fuller copy to
fall back on, so it has to stand alone. A route preview always has full geometry one request
away. Roughly a point every 50 m on a 100 km ride.

## 1.23 The `show_*` flags can be changed on a live or finished ride — details cannot

`updateEventDetails` used to reject *every* edit once an event went live. That made
`show_history_locations` settable only before anyone had ridden anything, so a ride's tracks
could never be shared retroactively — which is the only moment anyone would want to.

Sharing switches are not ride details. Name, date, place and description stay locked once
live: moving those out from under riders already on the road is what the guard is for.

## 1.24 `result_status: "stopped"` reports as `"dnf"`

The client's vocabulary has no separate word, and to a reader of a results list they mean the
same thing — did not complete. The distinction survives in the column for anyone who needs it.

## 1.25 Rejected riders are absent from results entirely

Not listed as DNS. A rejected registration means they were never in the ride, and a DNS line
would imply they were expected at the start.

## 1.26 `show_history_locations` is stricter than `show_results`, and your own line is always yours

Defaults are FALSE and TRUE respectively. Where someone rode is more revealing than whether
they finished — it is their route home. A rider may always fetch their own track regardless,
the same rule the live map follows for a rider's own position.

## 1.27 The finish hook lives in its own file to break an import cycle

`results.service.ts` (the read half) needs `getEventForViewer` from the events module, and the
events module needs the finish hook. Both in one file makes events and results import each
other — which ESM tolerates only as long as nothing runs at module load, exactly the kind of
thing that stops being true later and shows up as `undefined is not a function` at startup.
`track-writer.ts` imports nothing from events.

## 1.28 A replayed action is answered with the ORIGINAL result, not a bare 409

`client_actions` gained `response_status` / `response_body` (`sql/011`), and the middleware
records what the handler answered so a replay can be handed the same thing.

**Rejected — claim-only, 409 with no body:** simpler, and it would have been wrong twice
over. `sql/006-client-actions.sql` says in as many words that the server "answers a repeat
with 409 carrying the original result", and the client's `apiMutate` already reads `body.data`
out of the 409 and returns it as the action's value. A bodyless 409 would have handed the
rider `undefined` and looked like a success.

**Consequence:** a failed action **releases** its claim (`DELETE` on any 4xx/5xx), so a
transient error stays retryable with the same id. Holding the claim would have made one bad
request permanent for that action id.

**Not applied to** the three frozen Android endpoints: join is idempotent by upsert, and
location ingest is idempotent by nature.

## 1.29 The de-dup middleware fails open

If the `client_actions` table is unreachable, the request goes through un-deduplicated rather
than failing. Losing de-duplication degrades to the behaviour that shipped for months; failing
the request loses the rider's action outright. A malformed header is ignored for the same
reason — a client-side bug should not cost a rider their entry.

## 1.30 Ride profile fields are on the SUMMARY, not just the detail

`activityType`, `level` and `organizerGroup` are in `toEventSummary`.

**Why:** they are exactly what a rider scans and filters the "Find Rides" list by. On the
detail only, every card in a list would need its own detail call to render a difficulty badge.

## 1.31 The browse bucket is a question, not a status

`?bucket=live|upcoming|finished` rather than `?status=`. "Upcoming" spans three statuses, and
**"finished" has to include a ride whose end time has passed but whose status nobody flipped**
— nothing does that automatically (see `computeEffectiveStatus`), and a rider looking for last
Saturday's ride does not care which of those two it is.

Sort default follows the bucket: soonest-first for upcoming, most-recent-first for finished.
"First" means opposite things either side of today, and the old unconditional `starts_at ASC`
put the oldest ride in the database at the top of a discovery list.

## 1.32 Bulk import is all-or-nothing

`POST /events/:id/participants/import` runs in one `withTransaction`. A spreadsheet that fails
on row 41 leaves the start list exactly as it was — not 40 riders in, with no way to tell
which 40.

## 1.33 A ride group is not a category

`event_participants.category` is which class you are scored in. A group is who you ride with.
A club running one Saturday ride at two paces has **one event with two groups**, and nobody is
placed against the other group. They are separate columns and must stay so — merging them
would make "Elite group" and "Elite category" the same thing, which they are not.

## 1.34 `null` on a group's start time and route is an instruction, not an omission

"This group rides with the event" and "this group uses the event's track" are real answers. So
the schema is `.nullable().optional()` and the UPDATE uses `CASE WHEN $n THEN NULL` instead of
COALESCE — COALESCE alone cannot distinguish "clear it" from "I did not mention it".

## 1.35 Deleting a ride group un-assigns its riders, never removes them

They are still in the event; they just are not in a group any more. Losing someone from the
start list because the organizer tidied up their groups would be a data-loss bug wearing a
tidy-up's clothes.

## 1.36 Rider assignment is validated as a whole, then applied

An unknown participant id refuses the entire request rather than assigning the valid ones. A
partly-applied assignment leaves the organizer's screen disagreeing with the server about who
is where — worse than a refusal they can act on.

## 1.37 A team is not a browse surface

Public events and the route library have guest views. A club's membership does not: a stranger
gets **404**, same reasoning as a private event. Readable by the owner and by anyone on the
roster — including someone still waiting, who needs to see what they asked to join.

## 1.38 Following is public-only, and both directions are checked

`filter=following` returns only **public** upcoming rides. Following someone is not an
invitation to their private rides. Linking a ride to a team requires owning **both** the ride
and the team, so nobody re-files someone else's event and nobody hangs their ride off a club
they do not run.

## 1.39 Plan limits are 409 with a code, not 403

The caller is permitted to do this — they have run out of allowance. Different thing, different
client message ("upgrade", not "not yours"), and the `PLAN_LIMIT_*` code is what the client
keys an upgrade prompt on rather than parsing English.

The events window is a **rolling 7 days**, not a calendar week: "10 this week" must not reset
to zero every Monday for someone who created 10 on Sunday. A self-joiner counts against the
organizer's rider cap — otherwise a public ride's start list is unlimited while only manual
adds are capped, which is exactly the wrong way round.

## 1.40 Every limit is read through `getPlanLimits(userId)`, which is async today for no reason

There is no billing, so it returns a constant. It is async, and no call site references a limit
value directly, so that adding a real subscription lookup later is one function body rather
than a hunt through every enforcement point.

---

# 2. Caveats — things that will bite

## 2.1 ✅ RESOLVED — ride history is written at finish

Was: `participant_tracks` had zero writers while `location_points` was purge-eligible, so
switching on the purge would have destroyed every ride line permanently.

Now: `results/track-writer.ts` runs on the `live → finished` transition. **Still worth knowing
before you enable any purge:** a ride that was never explicitly finished (cancelled, or left
`live` forever) has no saved lines, because the hook only fires on that one transition. A
purge job should skip — or first build tracks for — any event without `participant_tracks`
rows.

## 2.2 ✅ RESOLVED — `X-Client-Action-Id` is honoured

`src/middleware/clientActions.ts`, on every mutating route except the three frozen Android
ones. **Still worth knowing:** `client_actions` rows are meant to be purged on the same
schedule as `location_points`, and nothing purges either yet — so the table grows unbounded
until a cleanup job exists.

## 2.3 ✅ RESOLVED — plan limits are enforced, but there is still no billing

`src/lib/plan-limits.ts`. **What is still missing is the paid side**: no plan record, no
subscription, no per-user override. Every account is on the free tier, and there is nothing to
upgrade to — so the limits are real but currently un-liftable. `getPlanLimits(userId)` is the
one seam that changes when billing arrives.

## 2.4 `event_members` exists and nothing reads it

The co-organizer table has been in the schema since `sql/002`. No code touches it; every
mutating action is owner-only. A ride cannot be co-managed today.

## 2.5 ✅ RESOLVED server-side — the public list filters, sorts and counts

`GET /events/public` now takes `q`, `type`, `bucket`, `activityType`, `level`, `sort`,
`limit`, `offset` and returns `{ data, total, limit, offset }`.

**The client still does none of this** — `eventsStore.ts` sends no parameters and filters in
memory, so the M1 bug (a "Finished" pill rendering empty while finished rides sit at row 21)
is live until the client is wired up. Server half done, client half is C7 below.

## 2.6 Nothing ever starts a ride automatically

`computeEffectiveStatus` reports a ride as *finished* once `ends_at` passes, without writing —
so client and server agree. There is no equivalent for "ride start auto": nothing moves
`ready → live`. Either a scheduled job, or extend `computeEffectiveStatus` the same way and let
the first location batch or the organizer's tap do the real write.

## 2.8 Nothing purges anything yet — KNOWN AND ACCEPTED

`location_points` and `client_actions` are both documented as purge-eligible and **neither has
a purge job**. The raw-GPS table grows for every ride forever, and the de-dup table grows for
every mutation forever.

**Status: acknowledged by the product owner (2026-08-20), deliberately deferred.** Retention
and purge will be designed as their own piece of work. Do not bolt a cleanup job onto
something else in the meantime.

Two things to carry into that work when it happens:

1. ⚠ §2.1 — a purge must never run for an event that has no `participant_tracks` rows, or that
   ride's history is destroyed. Events that were cancelled or left `live` forever never fired
   the finish hook and therefore have none.
2. `client_actions` rows are only useful for as long as an offline client might still replay
   them. That window is short (hours, not months), so it can be purged far more aggressively
   than `location_points`.

## 2.7 The local dev database image was missing two schema files

`docker/postgres/Dockerfile` copied `001`–`006` only. `008-registration-and-live.sql` shipped
before this work and was never added, so **every local database built from that image lacked
`requires_approval` and `is_paused`** — anything touching them would have failed against a
fresh local container while passing in tests (which use the in-memory fake). Fixed, with `009`
added at the same time.

**The general trap:** a new `sql/` file needs a `COPY` line in that Dockerfile *and* a
`docker compose down -v`, or the local database silently drifts from the schema. Nothing
enforces it.

---

# 3. Client-side work this creates

None of this is done — it is all `podium-client`, outside the server scope, listed so it is not
discovered by accident.

| # | What | Where |
|---|---|---|
| C1 | `Profile` doesn't declare `avatarUrl`, so the value arrives and is dropped | `auth/AuthContext.tsx:27` |
| C2 | `ServerParticipant` is missing `avatarUrl` (new), `finishedAt`, `finishPosition` — all sent by the server | `store/participantsStore.ts` |
| C3 | Handle the new `viewerTier` / `canViewEventInfo` fields — show "waiting for approval, details appear once the organizer approves you" instead of blank fields | `pages/EventDetailPage.tsx` |
| C4 | A private event now 404s where it used to 403 — check any error branching | wherever `ApiError.status === 403` is special-cased |
| C5 | Point the route stores at the real endpoints instead of `lib/mock-results.ts` | `store/eventRouteStore.ts`, `store/resultsStore.ts` |
| C6 | POST the already-parsed GPX/CSV points to `/routes`, then `/events/:id/route` | `pages/EventCreatePage.tsx` |
| C7 | Send `limit`/`offset` (and the filters, once they exist) rather than filtering 20 rows in memory | `store/eventsStore.ts` |
| C8 | `eventExtrasStore` / `eventGroupsStore` / `teamsStore` are still localStorage-only — nothing to do until Waves 4–5 land | `store/` |
| C9 | Swap results off the mock and onto `GET /events/:id/results` | `store/resultsStore.ts` |
| C10 | Replace the localStorage attendance/finished overlay with `PATCH …/attendance` and `PATCH …/result` — the overlay means two organizers on two phones see two different start lists | `store/participantsStore.ts` |
| C11 | Two shape differences from `mock-results.ts`: `countryCode` is **nullable** (nothing fabricates a country), and `route` uses the API-wide shape (`previewPoints: {lat,lng}[]`) rather than the mock's `points: [lat,lng][]` tuples | `lib/mock-results.ts` types |
| C12 | Draw the saved ride lines from `GET /events/:id/tracks` (or `/tracks/:participantId` for "my ride") | history / `EventDetailPage.tsx` |
| C13 | **Delete `eventExtrasStore.ts`** — activity type, level and organizing club are real server fields now, on the list summary as well as the detail | `store/eventExtrasStore.ts` |
| C14 | **Delete `mockOrganizerName`** — the event detail carries `owner: { id, name, avatarUrl }`. Every ride currently shows an invented organizer | `app/event-visuals.ts` |
| C15 | Send `q` / `bucket` / `activityType` / `level` / `sort` / `limit` / `offset` and read `total`, instead of filtering 20 rows in memory. **This is the live M1 bug** — supersedes C7 | `store/eventsStore.ts` |
| C16 | Use `POST …/participants/import` for file and contacts imports rather than N sequential POSTs | `store/participantsStore.ts` |
| C17 | Switch mutations to `apiMutate` so the offline replay guard actually engages — it has **no call sites today**, so nothing sends through the de-dup path yet | `store/*` |
| C18 | **Delete `eventGroupsStore.ts`** — ride groups are real now, with bulk assign | `store/eventGroupsStore.ts` |
| C19 | **Delete `teamsStore.ts`** — teams, membership and join-requests are real. Note "my teams" now includes teams you are an approved member of, which the local store could never express | `store/teamsStore.ts` |
| C20 | Drop `FREE_TEAM_LIMIT` and read the server's 409 + `PLAN_LIMIT_*` code instead, so the cap cannot be bypassed and the message can say why | `pages/TeamsPage.tsx` |
| C21 | Wire "follow this creator" — `PUT/DELETE /users/:id/follow`, and `GET /events?filter=following` for their next rides. **No client UI for this exists at all yet** | new |

---

# 4. Stale documentation found along the way

Worth correcting so nobody builds against them.

- **`podium-client/src/pages/EventCreatePage.tsx`** — the "Require my approval" doc comment says
  joining a flagged event always registers immediately and the checkbox does nothing. **False
  since before this work started:** `joinEvent` sets `waiting_approval` correctly
  (`event.service.ts:86`). Delete the comment.
- **`podium-client/plan/server-tasks.md`** — says `users.avatar_url` "does not exist anywhere
  today". It exists (`sql/001-init.sql:19`, `sql/007-users-avatar.sql`) and is populated from
  the Google token at sign-up.
- **This file's own ancestor:** the first draft of CLIENT-SERVER-AUDIT.md sketched the routes
  API as `GET /routes?public=1`. The real contract — and what shipped — is
  `GET /routes/public`, per `plan/07-api-contract.md`. The audit has been corrected.
- **Root `AGENT.md`** folder names are stale (`server-podium` / `client-podium`). Already
  recorded in CONTEXT.md §0.

---

# 5. Repo hygiene

## 5.1 `npm run lint` reports ~48 errors and none of them are real

Every one is a Biome **format** diagnostic: the repo's existing files are CRLF, and Biome's
`lineEnding` default is `lf`. There are **zero** lint-rule violations. Files created during
this work are LF, which is why the count moves around as files are touched.

Two ways to end it, neither done here because it would touch nearly every file in the repo and
bury a real diff:

1. `npm run lint:fix` once, as its own commit that changes nothing but line endings; plus a
   `.gitattributes` with `* text=auto eol=lf` so editors stop reintroducing CRLF.
2. Or set `"formatter": { "lineEnding": "crlf" }` in `biome.json` and keep the repo CRLF.

Until then: lint the files you touched, not the whole repo —
`npx biome check <paths>` and read only `lint/` and `assist/` diagnostics.

## 5.2 The test suite is slow to start, not flaky

First run in a cold session can take ~170 s just to import, and vitest's 5 s per-test timeout
can fire during that. A second run passes. If tests fail on the very first invocation with
`Test timed out in 5000ms`, re-run before investigating.

---

# 5b. Gaps and blind spots — what this work does NOT prove

Written deliberately, because everything above reads as confident and some of it should not.

## 5b.1 ✅ The schema and the risky queries HAVE now been checked against real Postgres

Every `sql/` file applies cleanly to a fresh `postgres:17-alpine`, all 14 hand-written
parameterised queries `PREPARE` successfully (which is what forces type inference), and eight
behaviours that only exist in SQL were verified by hand: the `CASE WHEN $n THEN NULL` clear,
the elevation filter refusing NULL rows, NULL `user_id` staying distinct in the team_members
unique index, the participant-name COALESCE chain, the `participant_tracks` upsert, the
de-dup claim's atomicity, the rejected-rider JOIN filter, and the one-live-event-per-owner
index.

**What that still does not cover:** query plans and index usage (nothing has been EXPLAINed),
behaviour at real data volume, and the migrations running against the **live Prisma-created
database**, which differs from `001-init.sql` (SERIAL ids, ENUM types, `TEXT` event ids). The
new files are all `ADD COLUMN IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS`, so they should be
safe there, but "should be" is the operative phrase.

## 5b.2 The tests run against an in-memory fake, not a database

All 184 tests mock `db/pool.js` with `tests/support/fake-db.ts`, which dispatches on SQL
**string prefixes** and re-implements the semantics in TypeScript. That means:

- A test can pass while the real SQL is wrong, because the fake's hand-written filter is what
  actually ran. Twice during this work a query was silently swallowed by an earlier branch with
  a shorter prefix (`SELECT DISTINCT e.* FROM events e`, `SELECT COUNT(*)::text FROM events`),
  and only a failing assertion elsewhere revealed it.
- Transactions are not real. `withTransaction` in the fake does not roll back, so
  "imports nothing when one row is invalid" passes because validation happens **before** the
  insert loop, not because a rollback was proved.
- Concurrency cannot be tested at all.

## 5b.3 Check-then-act races in the plan limits

`assertWithinEventsPerWeek`, `assertWithinParticipantLimit`, `assertWithinGroupLimit` and
`assertWithinTeamLimit` all count, then insert, without a transaction or a lock. Two concurrent
requests can both pass the check and both write. The overshoot is bounded and small, and the
only limit with a database-level backstop is the pre-existing one-live-event-per-owner index.

Acceptable for a free tier; **not** acceptable if a limit ever becomes the thing someone pays
to lift. The fix then is `SELECT ... FOR UPDATE` on the owner row, or a counter with a
constraint — not more application checks.

## 5b.4 The de-dup middleware has a crash window

`deduplicateClientAction` claims the action id, then records the result on `res.on("finish")`.
If the process dies in between, the claim survives with no stored result: the replay gets a 409
with `data: null`, which the client treats as success for an action that never happened. The
window is milliseconds and the alternative (claim after the fact) reintroduces the double-apply
it exists to prevent — but it is a real hole, not a theoretical one.

The `res.json` override also only captures handlers that use `res.json`. A handler answering
with `res.send` or a raw stream would record `null`. Every current handler uses `res.json`.

## 5b.5 The finish hook loads an entire event's GPS into memory

`writeParticipantTracks` does `SELECT ... FROM location_points WHERE event_id = $1` with no
chunking, then groups it in JS. A 200-rider event transmitting every second for four hours is
~2.9M rows in one array. That will not fail in testing and might fail in production.

If ridership grows, this needs to iterate per participant (the index is already there) or
stream a cursor. Nothing warns you before it OOMs.

## 5b.6 New endpoints carry no route-specific rate limits

`POST /routes` accepts a 4 MB body and up to 50 000 points, and is covered only by the global
300-requests-per-15-minutes-per-IP limiter. That is ~1.2 GB of accepted upload per IP per
window. Location ingest and the live map got bespoke limiters for good reasons; the route,
import and team endpoints got none.

## 5b.7 Personal data goes further than it used to

The participants list returns `email` and `phone` for every rider to **any approved rider**
when `show_participants` is on — including the phone numbers an organizer typed in for people
who never signed up and never agreed to anything. `avatarUrl` (a Google URL) is now on the
participants list, the live map and the results. None of this was reviewed against a privacy
requirement, because there is no privacy requirement written down.

## 5b.8 Whole modules were never audited

The client↔server walkthrough covered the product story. It did **not** look at:

- **`modules/sms`** — the OTP lifecycle, its rate limits, code generation, or the mock provider
- **`modules/auth`** session/token/refresh internals — explicitly excluded from the first task
  and never revisited
- **`middleware/requireAuth`** and the JWT verification path

None of these were touched by this work, but "not touched" is not "known good".

## 5b.9 The Android transmitter is unverified by the repo's own standard

Every response change is additive and the three frozen endpoints are untouched — verified by
reading. AGENT.md requires four manual checks against the **real Android app** for anything
near auth or ingest (join by code, timestamps, airplane-mode replay, SOS). None have been run.
The finish hook is new code on the same data path.

## 5b.10 Design calls nobody confirmed

These were judgement calls made mid-task and are the most likely things to be simply *wrong*
about what the owner wanted:

- pending riders on a **public** ride see time and place (§1.5) — they could equally be meant
  to see nothing until approved
- `show_*` flags editable on a finished ride (§1.23)
- a rider seeing 6 live markers rather than 5 (§1.8)
- `"stopped"` collapsing to `"dnf"` in results (§1.24)
- deleting a route silently removing the map from other organizers' rides (§1.17)
- the free-plan **numbers** (10/200/4/2) — invented, never specified

## 5b.11 Nothing has been run

Not the server, not the client, not the two together. No request has been made to a running
instance of this API. Correctness rests entirely on types, the fake DB, and the SQL checks in
§5b.1. **The app is not more usable than it was** — the server moved, the client did not, and
until C1–C21 are done a rider sees exactly what they saw before.

---

# 6. Deliberately not done

- **Races.** Splits, categories, waves, laps. The client hides every race field on purpose;
  `event_splits` / `participant_split_results` stay unbuilt and results will return
  `splits: []`.
- **Find Tracks** (`TracksPage.tsx`) — hazards, POIs, air quality, multi-day, day-of-week. Needs
  columns the routes work does not add. Specced in `plan/server-tasks.md` Part B.
- **Douglas–Peucker simplification.** `simplifyByStride` keeps evenly-spaced points instead.
  Neither consumer needs geometric fidelity, only "roughly this shape, few points". Noted as a
  future improvement in `lib/geo.ts` itself.
- **Websockets/SSE for live.** Polling, deliberately; the contract is shaped so it can be
  served by SSE later without a redesign.
- **Touching the frozen Android endpoints.** `GET /events/by-code/:code`, `POST /events/join`,
  `POST /events/:id/locations/batch` are unchanged, and every response change made anywhere is
  an *added* field. The live transmitter is unaffected.
