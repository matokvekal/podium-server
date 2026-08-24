# El Niño / Podium --- Production Deployment Plan

## 1. Production Server

Deploy a dedicated production environment on Hostinger for the Node.js
API.

**Why:** Production must be stable and isolated from development.

## 2. Domain & DNS

Connect the purchased domain to the production server, preferably
separating the web client and API.

Example:

``` text
app.domain.com  → Web Client
api.domain.com  → API
```

**Why:** Provides stable production addresses and clean separation
between frontend and backend.

## 3. Nginx Reverse Proxy

Use Nginx as the public entry point in front of the Node.js API.

``` text
Internet → Nginx → Node API
```

**Why:** Centralizes HTTPS, routing, security controls, and traffic
management. The Node API should not be directly exposed to the Internet.

## 4. HTTPS / SSL

Use Let's Encrypt certificates for all production domains with automatic
renewal.

**Why:** Login credentials, tokens, user information, and GPS/location
traffic must be encrypted.

## 5. Firewall & Server Hardening

Allow only required public ports.

``` text
80/443 → HTTP/HTTPS
22     → Protected SSH
6500   → Internal only
5432   → Not publicly exposed unless absolutely required
```

Prefer SSH keys, disable root login, and avoid password-based SSH
access.

**Why:** Reduces the attack surface of the production server.

## 6. Application Security

The API should enforce:

-   Helmet and appropriate security headers / CSP.
-   CORS restricted to approved production domains.
-   Rate limiting, with specific policies for login, OTP, and GPS
    traffic.
-   Input validation for every endpoint.
-   Parameterized SQL queries to prevent SQL injection.
-   XSS protection and no unsafe HTML rendering without sanitization.
-   Authentication and authorization for protected operations.
-   Secrets stored in environment configuration, never committed to Git.
-   Request/body size limits where appropriate.

**Why:** Protects the API and users from common web attacks and abusive
traffic.

## 7. PostgreSQL Production Database

The production API must connect only to the production PostgreSQL
database.

Verify:

-   Schema and migrations are current.
-   Database access is restricted.
-   The application DB user has only required permissions.
-   Connection pooling is configured.
-   Database backups are enabled.

**Why:** Prevents schema drift, unauthorized access, and production data
loss.

## 8. Backup & Recovery

Create automatic PostgreSQL backups with a retention policy such as
daily, weekly, and monthly backups.

A real restore procedure must also be tested.

**Why:** A backup is useful only if the system can actually be restored
from it.

## 9. GitHub Actions / CI-CD

Deploy automatically when approved code is pushed to the production
branch.

``` text
Push → prod
    ↓
Build + Validation
    ↓
Deploy to Hostinger
    ↓
Restart API
    ↓
Health Check
```

The pipeline should stop if validation/build fails.

**Why:** Makes production deployments repeatable and reduces manual
deployment mistakes.

## 10. Health Checks & Monitoring

Provide a health endpoint that can report basic production health, for
example:

``` text
API      OK
Database OK
Version
```

Monitor availability, HTTP 5xx errors, database failures, and
application crashes.

**Why:** Problems should be detectable without manually reproducing them
through the UI.

## 11. Application Logs

Store technical server logs with useful levels and correlation
information:

``` text
INFO
WARN
ERROR
requestId
```

Use automatic log rotation, compression, retention, and deletion so logs
cannot fill the server disk.

Never log passwords, JWTs, authorization headers, database credentials,
or unnecessary private information.

**Why:** Logs are required for production debugging but must remain
bounded and secure.

## 12. Remote Error Inspection

Important production errors may also be stored in PostgreSQL for
controlled remote inspection.

Recommended scope:

``` text
ERROR / FATAL → system_errors
```

Do not store every application INFO/DEBUG log in PostgreSQL.

Use automatic retention, for example 30--60 days.

**Why:** Allows remote diagnosis of important failures without turning
the main production database into a high-volume logging system.

## 13. Audit Log

Audit logging should be separate from technical application logging.

Record important business/security actions such as:

``` text
LOGIN
EVENT_CREATED
EVENT_UPDATED
EVENT_DELETED
JOIN_REQUESTED
JOIN_APPROVED
JOIN_REJECTED
PARTICIPANT_ARRIVED
RIDE_STARTED
RIDE_FINISHED
```

Typical audit information:

``` text
actor
action
entity
entityId
timestamp
requestId
relevant metadata
```

**Why:** Provides a reliable record of who performed important actions
and when.

## 14. Log & Audit Retention

Define explicit cleanup policies.

Example categories:

``` text
Debug/technical logs → short retention
Production errors     → 30–60 days
Audit records         → longer business retention
```

Cleanup should be automatic.

**Why:** Prevents unlimited disk/database growth and makes data
retention intentional.

## 15. Analytics

Integrate GA4 in the web client for product usage analytics.

Useful events may include:

``` text
sign_up
login
event_created
join_requested
join_approved
ride_started
ride_finished
find_track_used
```

Do not send precise GPS data, passwords, tokens, email addresses, phone
numbers, or other private information to analytics.

**Why:** Provides product usage insight without mixing analytics with
operational logging or sensitive user data.

## 16. GPS / Android Security

The Android application will send rider location to the production API.

The server must validate:

``` text
Authenticated rider
    ↓
belongs to event
    ↓
event is LIVE
    ↓
may update only their own location
```

The server must not trust a user ID supplied by the mobile client when
identity can be derived from authentication.

Also validate location coordinates, timestamps, update frequency, and
event state.

**Why:** Location information is sensitive and must not allow one user
to impersonate or update another rider.

## 17. Production Web Validation

Before connecting Android, validate the complete web production flow:

``` text
Login
→ Create Public Ride
→ Route persistence
→ Find Track
→ Join
→ Approval
→ Participants
→ START
→ LIVE
→ FINISH
→ Refresh
→ Logout/Login
```

Also verify offline/cache behavior when the API or network is
unavailable.

**Why:** Android integration should begin only after the production API
and core web flows are stable.

## 18. Android + LIVE Validation

After production Web/API validation:

``` text
Android GPS
    ↓
Production API
    ↓
PostgreSQL
    ↓
Web LIVE
    ↓
Rider moves on map
```

Test with real devices and verify:

-   GPS updates.
-   Background operation.
-   Weak/no connectivity.
-   Disconnect and reconnect.
-   Duplicate updates.
-   Old/out-of-order timestamps.
-   Synchronization with the LIVE web view.

**Why:** This proves the complete real-world rider tracking pipeline.

## 19. Persistent User Uploads (Avatar / Cover)

Riders' uploaded avatar and cover images are the first files this system stores
outside PostgreSQL. They must live **outside the directory a deployment
replaces**.

``` text
application code      /var/www/podium/...        replaced by every deploy
persistent uploads    /var/lib/podium/uploads/   never touched by a deploy
                          users/{userId}/avatar-{token}.{ext}
                          users/{userId}/cover-{token}.{ext}
shared preset art     /var/www/podium/assets/presets/   ships WITH the code
```

Create the upload root once, before the first deploy:

``` bash
mkdir -p /var/lib/podium/uploads/users
chown -R podium:podium /var/lib/podium/uploads
chmod 750 /var/lib/podium/uploads
```

Production environment:

``` text
UPLOADS_DIR=/var/lib/podium/uploads
PUBLIC_BASE_URL=https://api.domain.com
```

`UPLOADS_DIR` is **required** in production — the API refuses to start without
it rather than falling back to a path inside the code tree that the next release
would erase. `PUBLIC_BASE_URL` must be absolute because the web client is served
from a different host than the API.

The GitHub Actions deploy (section 9) must never `rsync --delete` or `git clean`
anything outside `/var/www/podium`. The upload root is deliberately on a separate
branch of the filesystem so that no build, restart, checkout or release can reach
it.

Serve the images from Nginx rather than through Node:

``` nginx
client_max_body_size 1m;

location /uploads/ {
    alias /var/lib/podium/uploads/;
    autoindex off;
    add_header Cache-Control "public, max-age=31536000, immutable";
    add_header X-Content-Type-Options nosniff;
    add_header Cross-Origin-Resource-Policy cross-origin;
    types { image/jpeg jpg jpeg; image/png png; image/webp webp; image/gif gif; }
    default_type application/octet-stream;
}

location /assets/presets/ {
    alias /var/www/podium/assets/presets/;
    autoindex off;
    add_header Cache-Control "public, max-age=31536000, immutable";
    add_header Cross-Origin-Resource-Policy cross-origin;
}
```

Every uploaded file carries a random token in its name, so a replacement is
always a new URL and the immutable cache is safe.

**Backups.** Back up `/var/lib/podium/uploads` alongside PostgreSQL. The database
stores only references, so a database-only restore leaves dangling image URLs.

**Cleanup.** Replaced files are removed as part of the change; anything missed is
collected by the sweeper, which is safe to run on a live server:

``` bash
node scripts/cleanup-user-uploads.mjs            # dry run
node scripts/cleanup-user-uploads.mjs --delete
```

It only ever removes files under `uploads/users/` that no `users` row points at.
It never touches the shared preset art.

**Audit.** Avatar/cover changes emit `USER_AVATAR_CHANGED`, `USER_COVER_CHANGED`,
`USER_AVATAR_RESET` and `USER_COVER_RESET` through `src/lib/audit.ts` — currently
as structured log lines carrying the section 13 field set. When the `audit_log`
table of section 13 is built, it is written inside that helper and no call site
changes.

## Recommended Order

``` text
1. Production server
2. Firewall + server hardening
3. PostgreSQL + migrations
4. Backup + restore
5. Domain + DNS
6. Nginx
7. HTTPS / Let's Encrypt
8. Application security
9. Logs + rotation + cleanup
10. Remote error inspection
11. Audit
12. Health checks + monitoring
13. Manual production validation
14. GitHub Actions / CI-CD
15. Analytics
16. Full web production test
17. Android GPS + LIVE synchronization test
```

## Final Goal

A production environment that is:

-   Secure.
-   Automatically deployable.
-   Observable and auditable.
-   Protected against uncontrolled log/database growth.
-   Recoverable from backups.
-   Ready for web users.
-   Ready for Android GPS and LIVE synchronization after the core
    production flow is verified.
