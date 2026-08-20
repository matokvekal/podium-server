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
