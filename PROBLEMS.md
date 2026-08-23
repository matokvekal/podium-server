# Server V1 – Main Issues to Resolve

The overall architecture is good. **Do not redesign it before V1.** Focus on closing the following gaps.

## Critical Before V1

### 1. Participant / Leave / Rejoin State Machine

Define one clear lifecycle:

```text
registered
waiting_approval
approved
rejected
left
```

Clarify:

* What happens when the creator selects **"I'm riding too"**.
* Creator participation must never require self-approval.
* How Leave is stored: `left_at`, status, or another mechanism.
* What happens on Rejoin.
* Whether previous approval is preserved.
* Whether the same `event_participants.id` is reused.

This is especially important because `participantId` is part of the frozen Android contract.

### 2. DB Protection Against Duplicate Join

Join must be idempotent.

Do not rely only on:

```text
SELECT → if missing → INSERT
```

Two concurrent requests can still create duplicates.

Add an appropriate DB-level uniqueness rule based on the final Leave/Rejoin model, such as:

```text
(event_id, user_id)
```

### 3. Explicit Approval Transitions

Define legal transitions centrally.

Examples that must have explicit behavior:

```text
waiting_approval → approved
waiting_approval → rejected
rejected → join again?
approved → rejected?
left → join again?
```

Also define what happens to existing participants if `requiresApproval` changes.

Avoid implementing these rules separately in different services.

### 4. Centralize Participant Access Logic

`registered` and `approved` currently have similar access semantics when approval is not required.

Do not scatter:

```ts
status === "registered" || status === "approved"
```

through the codebase.

Use one centralized rule such as:

```ts
isParticipantApproved(participant, event)
```

### 5. Define Transaction Boundaries

Explicitly identify operations that must be atomic.

Important candidates:

```text
Create Event + create owner membership
Join
Approve / Reject
Leave / Rejoin
Attach Route
Delete / Detach Route
Finish Event
```

A partial operation must not leave inconsistent DB state.

### 6. Central AuthZ + Visibility Resolver

There should be one authority for authorization:

```ts
can(user, capability, resource)
```

And preferably one event-access resolver:

```ts
eventAccess = {
  details,
  route,
  participants,
  live,
  history,
  results
}
```

Do not independently calculate visibility/capabilities inside Events, Routes, Participants and Live services.

## Location / Offline Reliability

### 7. Define Location Deduplication

Offline replay must have an explicit deduplication strategy.

Prefer a stable client-generated identifier:

```text
clientPointId
```

or equivalent stable action/record ID.

Do not assume:

```text
participantId + recordedAt
```

is always sufficient.

Retries after timeout must never create duplicate GPS points.

### 8. Finish Hook Recovery

Keeping the Finish Hook non-blocking is correct:

```text
live → finished
```

should succeed even if saved-track generation fails.

But failed processing needs recovery, for example:

```text
history_processing
history_ready
history_failed
```

plus retry capability.

An event must not remain permanently without history because one background operation failed.

### 9. Raw Location Retention

Define at least the V1 policy for raw GPS data:

* retention period;
* required indexes;
* expected data growth.

At minimum verify indexes around:

```text
event_id
participant_id
recorded_at
```

A full purge system can remain post-V1.

## Database Reliability

### 10. Enforce Critical Invariants in PostgreSQL

Important business invariants should not exist only in TypeScript.

Review DB constraints for:

```text
unique participant membership
provider identity uniqueness
NOT NULL requirements
critical relationships
indexes
idempotency keys
```

Real PostgreSQL must be used for verification.

### 11. Introduce Migration Versioning

Manual SQL is acceptable for V1, but unversioned manual schema changes will become dangerous.

No ORM is required.

A simple approach is enough:

```text
001_initial.sql
002_participant_constraints.sql
003_location_indexes.sql

schema_version
```

The goal is to know exactly which schema version exists in every environment.

## Production Security

### 12. Remove Development Authentication

`dev-login` is a release blocker.

Production must not expose:

```text
POST /api/v1/auth/dev-login
```

Prefer not registering the route at all in production rather than only hiding it from the client.

---

# V1 Priority

Do not redesign the architecture.

Focus on these **six primary fixes**:

```text
1. Participant / Leave / Rejoin state machine
2. DB uniqueness + idempotent Join
3. Clear transaction boundaries
4. Central AuthZ / Visibility resolver
5. Reliable offline/location deduplication
6. Finish Hook retry/recovery
```

The existing core architecture should remain:

```text
Identity
≠
Event Membership
≠
Participation
≠
Entitlements

Server = Source of Truth

Routes = Server-backed

Android Contract = Frozen
```

## Main Risk

The biggest V1 risk is not the architecture.

The risk is that several important rules currently exist as **application expectations**, but it is not always clear whether they are guaranteed by:

```text
Service logic
+
DB constraints
+
Transactions
```

A system can pass unit tests and still fail when **two real users perform concurrent operations against the real PostgreSQL database**.

V1 should therefore be considered stable only after these invariants are enforced and verified with real DB + two-user flows.
