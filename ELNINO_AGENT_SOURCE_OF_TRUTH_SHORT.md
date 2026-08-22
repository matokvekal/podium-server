# ElNino / Bike Podium — Agent Source of Truth

> Concise engineering reference for coding agents.
> Use this file first. It intentionally removes historical audit narration, duplicate rules,
> completed task history, and repeated rationale.

## 1. Non-Negotiable Rules

1. **The live Android API contract is frozen.**
   Do not break paths, request/response field names, timestamp semantics, or `participantId`.

```text
GET  /api/v1/events/by-code/:code
POST /api/v1/events/join
POST /api/v1/events/:eventId/locations/batch
```

- `participantId` = `event_participants.id`.
- Android offline replay must preserve the device's original `recordedAt`.
- SOS must persist `emergency = true`.

2. **Server is authoritative.**
   - Client validation = UX.
   - Server validation/business rules/authz/limits = final authority.
   - Server/DB data wins over local mocks/cache after sync.

3. **Authorization is capability-based.**
   - Client must not recreate premium/role/visibility rules.
   - Routes/services ask for capabilities.
   - Billing concepts/prices do not belong in authz policy.

4. **Database rules.**
   - PostgreSQL, no ORM.
   - SQL only in `*.queries.ts`.
   - Always parameterize SQL (`$1`, `$2`, ...).
   - DB = `snake_case`; API = `camelCase`.
   - Timestamps = `TIMESTAMPTZ`, UTC.
   - Schema is hand-owned; production migrations are explicit/manual.
   - Do not assume foreign keys will clean up related rows.

5. **Completion gate.**

```bash
npm test
npm run typecheck
npm run lint
```

For auth/location changes also verify with the real Android app:
join → transmit → offline/reconnect replay → original timestamps → SOS.

6. **Temporary dev auth must not ship.**
   Remove `POST /api/v1/auth/dev-login` and corresponding client support before production.

---

## 2. Architecture

```text
React/Vite/Zustand Client
        ↓ /api/v1
Express 5 + TypeScript
        ↓
Zod validation
        ↓
Services / business rules / authorization
        ↓
*.queries.ts
        ↓
PostgreSQL
```

Server module pattern:

```text
<name>.routes.ts       route + middleware
<name>.controller.ts   parse / validate / respond
<name>.service.ts      business logic / permission checks
<name>.queries.ts      SQL only
<name>.schemas.ts      Zod
```

Main modules:

```text
auth          Google/SMS sign-in, sessions, token rotation
users         profile/account
events        CRUD, by-code, join, lifecycle, live
participants  start list, approve/reject, attendance/results writes
routes        route library + event attachment
results       results, saved rider tracks, finish hook
groups        event riding groups
teams         clubs/membership/follow organizer
sms           OTP lifecycle/provider
authz         capabilities, roles, entitlements, visibility
```

---

## 3. Identity, Roles and Authorization

Keep these layers separate:

```text
1. Identity       users + auth_identities; guest = no identity
2. Global role    RIDER | COMMISSAIRE
3. Event role     event_members: owner | operator | viewer
4. Participation event_participants registration state
5. Entitlements   plan/features/limits from entitlement_grants
6. Visibility     events.visibility + show_* flags
                   ↓
             capability(action)
```

Important distinctions:

- **Organizer is not a global role.**
  Any registered user may create events within plan limits.
- Event ownership/admin rights apply only to that event.
- Organizing and riding are independent; a person can have both an `event_members`
  row and an `event_participants` row.
- `registered` and `approved` both count as approved access tier where approval is not required.
- Private resource with no relationship returns **404**, not 403, to avoid confirming existence.

### Account capabilities

```text
event:create
event:create_private
team:create
route:create
route:publish
```

### Event capabilities

```text
event:view
event:view_details
event:view_route
event:view_participants
event:view_live
event:view_results
event:view_history
event:join
event:edit
event:change_status
event:delete
event:manage_participants
event:manage_groups
event:manage_route
event:manage_members
```

### HTTP refusal semantics

```text
401 = not signed in
403 = authenticated but not permitted
404 = hidden/private resource with no relationship
409 = conflict / plan limit / offline replay duplicate
429 = rate limit
```

---

## 4. Plans and Entitlements

Plans define **features and limits**, not prices.

`entitlement_grants` represents active access from:

```text
subscription
coupon
purchase
trial
manual
```

A grant may provide:
- a whole plan, or
- one feature,
- optionally scoped to one event,
- optionally expiring,
- optionally consumable.

Resolution rules:
- highest-ranked active plan wins;
- feature set = winning plan features + active feature grants;
- each limit uses the most generous active value;
- expired/revoked/consumed grants do not apply.

Current free-tier enforcement includes limits such as:
- events per rolling week;
- participants per event;
- groups per event;
- teams per owner.

The server enforces limits and normally returns `409` when exceeded.

Billing/subscriptions are separate future concerns; they should only create/update grants.

---

## 5. Event Visibility and Viewer Rules

`events.visibility`:

```text
public      everyone, including guests
registered  signed-in users
private     participant/event-role relationship only; strangers get 404
```

`show_*` flags control how much an allowed viewer can see:
- event info
- participants
- route
- live locations
- history locations
- results

Key rules:
- owner/approved users see allowed event details;
- private + pending is redacted;
- public + pending gets public-level info;
- **pending never gets the route**, even on a public event;
- a rider always sees their own live position;
- their own position does not consume one of the 5 “other rider” live slots;
- a rider may always fetch their own saved history track.

---

## 6. Event Lifecycle

```text
draft
  → published
  → registration_open
  → ready
  → live
  → finished

draft/published/registration_open/ready/live → cancelled where allowed
```

Server service layer validates transitions.

After an event is live:
- core ride details such as name/date/place/description are locked;
- sharing `show_*` flags may still be changed so results/history can be opened after the ride.

---

## 7. Join and Participants

Join endpoint:

```text
POST /api/v1/events/join
```

Server must validate:
- event exists;
- event is joinable;
- bib if required;
- participant plan limit;
- approval requirement;
- duplicate/retry behavior.

Join must be **idempotent**: retries must not create duplicate memberships.

Participant display identity is resolved on **read**, not copied at join time.
New participant queries must join the user identity chain so profile changes appear everywhere.

Participant status includes:

```text
registered
waiting_approval
approved
rejected
```

Approve/reject:
- server-authorized;
- valid status transition only;
- returned row must include resolved display identity so UI does not blank the rider after update.

Rejected riders:
- do not count as joined;
- do not appear in results.

Owner/creator:
- is an event owner via `event_members`;
- must not require self-approval merely to administer their own event;
- riding participation remains a separate relation.

---

## 8. Routes

Routes are server-backed. Do not fabricate route data from client mocks.

Rules:
- GPX/TCX/CSV parsing stays client-side.
- Server receives normalized points.
- Derived route data is computed once on upload:
  - distance
  - climb
  - bbox
  - start/end
  - preview
- Route list responses never include full `track_points`.
- Preview target: ~300 points.
- Unknown climb = `null`, not zero.
- Full geometry is fetched only from route detail.
- “Copy another ride's track” = attach the same route, not duplicate geometry.
- Attaching a route replaces the current event-route attachment.
- Route upload endpoint has a larger body limit than the global API.
- Event detail/mutation responses keep the route summary so client state does not lose the map after an update.
- Deleting a route must detach it from events first because schema cleanup cannot be assumed.
- Prefer unpublishing over deleting a route that may still be used.

Key endpoints:

```text
POST   /api/v1/routes
GET    /api/v1/routes
GET    /api/v1/routes/public
GET    /api/v1/routes/:routeId
PATCH  /api/v1/routes/:routeId
DELETE /api/v1/routes/:routeId

POST   /api/v1/events/:eventId/route
DELETE /api/v1/events/:eventId/route
```

---

## 9. Live Location Ingest

Frozen Android endpoint:

```text
POST /api/v1/events/:eventId/locations/batch
```

Requirements:
- up to 200 points/request;
- preserve `recordedAt`;
- offline replay must retain original timestamps;
- de-duplicate safely;
- SOS persists emergency state;
- do not redesign this contract for web-client convenience.

A rider's own live position is always visible to that rider.
Visibility flags gate other riders.

---

## 10. Results and Ride History

At `live → finished`, finish hook:
- reads raw location points;
- groups them by participant;
- writes one simplified saved track per rider;
- target saved history line: ~2000 points;
- is idempotent;
- never prevents the event from finishing if track writing fails.

Results rules:
- ranks are computed at read time, not stored;
- manual `finish_position` outranks timestamp;
- elapsed time starts at event `starts_at`;
- leader gap = `null`;
- correcting a finisher to non-finished clears finish time/position;
- `stopped` is exposed as `dnf`;
- rejected riders are omitted;
- history visibility is stricter than results visibility;
- rider can always fetch their own saved track.

---

## 11. API / Data Shape Rules

- API uses `camelCase`.
- DB uses `snake_case`.
- Map in query files.
- Keep frozen Android response shapes byte-compatible where required.
- Non-frozen API changes should be additive when possible.
- Do not silently rename/remove response fields used by the client.

Important API surfaces include:

```text
POST /api/v1/auth/google
GET  /api/v1/users/me

POST /api/v1/events
GET  /api/v1/events/:eventId
GET  /api/v1/events/by-code/:code
POST /api/v1/events/join

GET/POST/PATCH/DELETE
/api/v1/events/:eventId/participants

PATCH /api/v1/events/:id/participants/:pid/attendance
PATCH /api/v1/events/:id/participants/:pid/result

GET /api/v1/events/:id/results
GET /api/v1/events/:id/tracks
GET /api/v1/events/:id/tracks/:participantId
```

---

## 12. Database and Local Development

Local DB:

```bash
docker compose up -d db
docker compose down -v
docker exec -it podium-db psql -U podium -d podium
```

Local defaults:

```text
database: podium
user:     podium
password: podium
port:     5432
```

Important:
- Docker initialization scripts run only on an empty volume.
- Adding/changing SQL does not update an existing local volume automatically.
- Real databases remain manually migrated.
- Local/fake DB tests are not proof of real PostgreSQL schema correctness.

Before production DB work:
1. backup;
2. inspect actual schema;
3. apply only required additive SQL;
4. verify real data invariants;
5. run API flows against the real DB.

---

## 13. Data Integrity Invariants

Verify against the real DB:

```text
No duplicate participant membership for the same event/user.
Join/approve/reject survives refresh and new login.
Creator ownership does not create bogus self-pending approval.
Participant identity resolves from real user data.
Avatar resolves from auth/profile → users.avatar_url → API avatarUrl.
Route attached to an event persists and is returned to another user.
No mock/fake participant or route data appears in server-backed flows.
Offline location replay does not duplicate points or alter recorded time.
```

Identity race handling must tolerate:
- concurrent Google login;
- duplicate provider identity conflict;
- stale/dangling identity row.

Local-schema fallbacks may prevent development `500`s, but they must not hide production schema mistakes.

---

## 14. Important Engineering Decisions

Keep these decisions unless explicitly redesigning them:

- Participant display names are resolved on read.
- Participant update responses re-join user identity data.
- Private strangers receive 404.
- `registered` counts as approved access when approval is not required.
- Pending route access is always denied.
- Rider's own live marker is always available and is outside the “other riders” cap.
- `show_*` defaults are preserved server-side when omitted.
- Route lists never return full geometry.
- Route derived metrics are computed at upload.
- Unknown climb is `null`.
- Track-file parsing stays in the client.
- Route reuse is attachment, not geometry duplication.
- Route summary is returned with event mutation responses.
- Ranking is computed on read.
- Finish hook is idempotent and non-blocking.
- Saved history track keeps more detail than a route preview.
- Sharing flags can change after live; core event details cannot.
- Own live/history location remains visible to the rider.

---

## 15. Current Release / Stabilization Verification

Before first release, verify on **real PostgreSQL + two real users**:

### Authentication / identity
- Google login.
- `/users/me`.
- nickname / first+last fallback.
- avatar chain.
- refresh/logout/login persistence.

### Join / approval
- User B requests join.
- Owner sees pending status clearly.
- Owner approves.
- User B sees approved after refresh.
- User B still sees approved after logout/login.
- reject path persists.
- duplicate join does not create duplicate rows.
- creator is never presented as needing self-approval.

### Route
- Owner creates/selects route.
- route saved to server/DB.
- event attachment persists.
- second user receives exact same route from API.
- no local/mock fallback.

### Participants
- only real DB riders appear.
- names and avatars are correct.
- participants/event/live views use the same identity source.

### Leave / membership
- leaving updates server state.
- event disappears from joined/My Rides where intended.
- re-entry/invited behavior follows the chosen product rule.
- refresh and new login do not restore stale local membership.

### Android
- QR/by-code lookup.
- join returns correct `participantId`.
- location batch ingest.
- airplane mode/reconnect preserves original timestamps.
- SOS emergency flag.

### Full verification

```bash
npm test
npm run typecheck
npm run lint
```

---

## 16. Known Deliberate Gaps / Future Work

Do not mix these into stabilization unless explicitly requested:

- billing/subscription purchase flow;
- richer race features: splits, categories, waves, laps;
- Find Tracks hazards/POIs/air quality;
- production purge jobs for raw locations/client actions;
- further paid/club product behavior;
- deferred UI/product features such as covers, hearts/gamification, etc.

Before adding purge jobs, confirm saved rider tracks are complete and retention rules are defined.

---

## 17. Agent Working Method

For each task:

```text
1. Read this file.
2. Identify the affected module(s).
3. Inspect only relevant source + tests + schema.
4. Preserve frozen Android contracts.
5. Make the smallest behavior-safe change.
6. Add/update targeted tests.
7. Run targeted verification.
8. Run full test/typecheck/lint before DONE.
9. If DB behavior matters, validate against real PostgreSQL.
10. Report:
    - changed files
    - behavior change
    - DB/API impact
    - tests run
    - remaining risk
```

Do not:
- add new features during stabilization;
- reintroduce mock data into server-backed flows;
- move SQL into services/controllers;
- duplicate authz logic in the client;
- assume fake DB parity proves production correctness;
- “clean up” frozen Android contracts.

---

# Quick Agent Checklist

```text
ANDROID CONTRACT SAFE?
SERVER IS SOURCE OF TRUTH?
AUTHZ VIA CAPABILITIES?
SQL ONLY IN QUERIES?
PARAMETERIZED SQL?
REAL DB VERIFIED IF RELEVANT?
NO MOCK FALLBACK?
TWO-USER FLOW TESTED?
TESTS PASS?
TYPECHECK PASS?
LINT PASS?
```
