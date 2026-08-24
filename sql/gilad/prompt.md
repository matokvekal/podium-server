Create ONE standalone SQL file for manual development/testing only.

This file is NOT part of the application, NOT part of migrations, NOT part of Docker, and NOT automatically executed.

Goal:

```text
PODIUM_TEST_DATA.sql
```

I should be able to open it in DBeaver/psql and run it manually against a clean development DB.

Later I want to give this file to ChatGPT and ask it to expand it from 1 sample event to 10–20 realistic events.

### Your task

First inspect the real PostgreSQL schema and current application behavior.

Use the actual DB structure, constraints, foreign keys, unique indexes, enums/status values, required columns, sequences/identity columns, and relationships.

Do NOT guess column names or IDs.

Prepare a minimal but complete sample dataset.

### Initial dataset

Create at least:

```text
1 creator user
1 additional rider
1 real public event
1 route based on the GPX file I will provide
event ↔ route relationship
creator membership
creator participant if appropriate
second participant if appropriate
all required supporting rows
```

The event should be realistic enough that I can open the real client and test:

```text
My Rides
Find Track
Event Detail
Participants
Route/Map
LIVE-related read flows
```

Use only real schema-supported fields.

### GPX

I will give you one small GPX file.

Convert its real track into the SQL rows required by the CURRENT database schema.

Do not require any importer program later.

The final result must contain the necessary SQL directly, so the file is self-contained.

### IDs and uniqueness

Be very careful with:

```text
UUID primary keys
BIGSERIAL / identity IDs
event codes
user IDs
route IDs
foreign keys
unique constraints
membership uniqueness
participant uniqueness
auth identity uniqueness
any application-specific invariants
```

Use stable deterministic test values where explicit IDs are safe and useful.

Do not create values that will conflict internally inside the script.

If identity/sequence synchronization is required after explicit inserts, include the required `setval`/sequence handling.

### Reset section

At the top, include a clearly marked OPTIONAL development reset section.

Example intention:

```text
-- DANGER: DEVELOPMENT DB ONLY
-- Uncomment/run this section only when a full reset is wanted.
```

Use the correct dependency order / `CASCADE` based on the real schema.

Do not touch schema definitions.

### Structure the single SQL file clearly

Use sections similar to:

```text
00 — Safety / Notes
01 — Optional Reset
02 — Users / Auth
03 — Routes
04 — Route points / geometry
05 — Events
06 — Event ↔ Route
07 — Memberships
08 — Participants
09 — Other required supporting data
10 — Validation Queries
```

Keep it readable and editable by a developer.

### Important product rules

Respect current application behavior.

For example, verify rather than assume:

```text
creator ownership
creator "I'm riding too" behavior
public visibility
published/finished/live status rules
approval state
participant registration status
show_participants
Find Track visibility
route persistence
```

Do not insert impossible states just because PostgreSQL accepts them.

### No mocks

This is test DATA, not mock application behavior.

The real client/server should consume these rows exactly as normal DB data.

### No code changes

Do not modify application source code.

Do not create:

```text
npm scripts
seed services
import utilities
Docker initialization
migration files
```

Only create the standalone SQL artifact.

### Validation

Before finishing, run the SQL against a clean development DB if safely possible and verify:

```text
all INSERTs succeed
no FK violations
no unique violations
event can be read by existing APIs
public event appears where expected
route is attached correctly
participants resolve correctly
```

At the bottom of the SQL add useful verification queries such as:

```sql
SELECT * FROM users;
SELECT * FROM events;
SELECT * FROM routes;
SELECT * FROM event_routes;
SELECT * FROM event_participants;
SELECT * FROM event_members;
```

Use the exact real table names.

### Deliverables

Return:

1. `PODIUM_TEST_DATA.sql`
2. Short explanation of the dataset created
3. IDs/codes intentionally kept stable
4. Any tables deliberately not populated and why
5. Any assumptions that could not be proven from schema/code

The most important requirement:

**The SQL file must be self-contained, manually runnable, safe for a disposable development DB, and easy for me to expand later into many events.**
