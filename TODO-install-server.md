<<<<<<< HEAD
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
=======
# Podium Production Server — Simple Checklist

Assumption: a fresh Ubuntu VPS on Hostinger, with `api.example.com` pointing to it.
Replace every `<...>` value before running a command.

## 1. Create the server and DNS

- [ ] Create an Ubuntu VPS.
- [ ] Add DNS record: `api.example.com` → `<SERVER_IP>`.
- [ ] Check it: `nslookup api.example.com`.

## 2. Secure SSH and firewall

Log in as root once:

```bash
adduser podium
usermod -aG sudo podium
install -d -m 700 -o podium -g podium /home/podium/.ssh
cp /root/.ssh/authorized_keys /home/podium/.ssh/authorized_keys
chown podium:podium /home/podium/.ssh/authorized_keys
chmod 600 /home/podium/.ssh/authorized_keys
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw enable
```

- [ ] In a new terminal, verify `ssh podium@<SERVER_IP>` works.
- [ ] Set `PermitRootLogin no` and `PasswordAuthentication no` in
  `/etc/ssh/sshd_config`; run `sudo sshd -t`, then reload SSH.
- [ ] Never expose Node port `5000` or PostgreSQL port `5432` publicly.

## 3. Install software

```bash
sudo apt update
sudo apt upgrade -y
sudo apt install -y nginx postgresql postgresql-contrib certbot python3-certbot-nginx git curl
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node --version
npm --version
```

## 4. Create PostgreSQL database

Generate a password with `openssl rand -base64 32`, then:

```bash
sudo -u postgres psql
```

```sql
CREATE USER podium_app WITH PASSWORD '<STRONG_DB_PASSWORD>';
CREATE DATABASE podium OWNER podium_app;
\q
```

Keep PostgreSQL bound to localhost. Do not open port `5432`.

## 5. Create server directories

```bash
sudo install -d -o podium -g podium /var/www/podium
sudo install -d -m 750 -o podium -g podium /var/lib/podium/uploads/users
sudo install -d -m 750 -o podium -g podium /var/backups/podium
```

Uploads and backups stay outside the deployment directory.

## 6. Install the application

```bash
sudo -u podium git clone <REPOSITORY_URL> /var/www/podium
cd /var/www/podium
sudo -u podium npm ci
```

Use a read-only deploy key for a private repository.

## 7. Add production configuration

```bash
sudo install -m 600 -o root -g root /dev/null /etc/podium.env
sudo nano /etc/podium.env
```

Add:

```dotenv
NODE_ENV=production
PORT=5000
DATABASE_URL=postgresql://podium_app:<URL_ENCODED_DB_PASSWORD>@127.0.0.1:5432/podium
JWT_ACCESS_SECRET=<RUN: openssl rand -hex 32>
JWT_ACCESS_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=30d
GOOGLE_CLIENT_IDS=<GOOGLE_CLIENT_ID>
CORS_ORIGINS=https://app.example.com
AUTH_PROVIDERS=GOOGLE
DEV_LOGIN_ENABLED=false
# TWILIO is not implemented in this server yet. Keep MOCK or disable SMS login.
SMS_PROVIDER=MOCK
LOG_LEVEL=info
CONSOLE_TRACE=false
UPLOADS_DIR=/var/lib/podium/uploads
ASSETS_DIR=/var/www/podium/assets
PUBLIC_BASE_URL=https://api.example.com
```

Do not commit this file. Do not enable SMS login in production until a real SMS provider is
implemented and tested.

## 8. Apply the database schema

First fix the unresolved merge conflict and outdated migration list currently present in
`sql/README.md`. This is a launch blocker.

Then, for a **fresh database**, run each SQL file once in the documented order. Do not run
`900-timestamptz-migration.sql`.

```bash
cd /var/www/podium
sudo bash -c 'set -a; source /etc/podium.env; set +a; psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/001-init.sql'
# Continue with each remaining fresh-database file from sql/README.md.
```

For an existing database, back it up first and use the existing-database list. Never run
migrations blindly.

## 9. Check and build

```bash
cd /var/www/podium
sudo -u podium npm ci
sudo -u podium npm run lint
sudo -u podium npm run typecheck
sudo -u podium npm test
sudo -u podium npm run build
```

Stop if any command fails.

## 10. Run the API with systemd

Create `/etc/systemd/system/podium.service`:

```ini
[Unit]
Description=Podium API
After=network.target postgresql.service

[Service]
Type=simple
User=podium
Group=podium
WorkingDirectory=/var/www/podium
EnvironmentFile=/etc/podium.env
ExecStart=/usr/bin/node dist/server.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now podium
sudo systemctl status podium --no-pager
curl http://127.0.0.1:5000/health
```

Expected: `{"status":"ok"}`.

## 11. Configure Nginx

Create `/etc/nginx/sites-available/podium`:

```nginx
server {
    listen 80;
    server_name api.example.com;
    client_max_body_size 1m;

    location /uploads/ {
        alias /var/lib/podium/uploads/;
        autoindex off;
        add_header Cache-Control "public, max-age=31536000, immutable";
        add_header X-Content-Type-Options nosniff;
        add_header Cross-Origin-Resource-Policy cross-origin;
    }

    location /assets/presets/ {
        alias /var/www/podium/assets/presets/;
        autoindex off;
        add_header Cache-Control "public, max-age=31536000, immutable";
        add_header Cross-Origin-Resource-Policy cross-origin;
    }

    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/podium /etc/nginx/sites-enabled/podium
sudo nginx -t
sudo systemctl reload nginx
curl http://api.example.com/health
```

## 12. Enable HTTPS

```bash
sudo certbot --nginx -d api.example.com
sudo certbot renew --dry-run
curl https://api.example.com/health
```

## 13. Configure backups

Create `/usr/local/sbin/backup-podium` as root:

```bash
#!/usr/bin/env bash
set -euo pipefail
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
sudo -u postgres pg_dump -Fc podium > "/var/backups/podium/db-$stamp.dump"
tar -czf "/var/backups/podium/uploads-$stamp.tar.gz" -C /var/lib/podium uploads
find /var/backups/podium -type f -mtime +30 -delete
```

```bash
sudo chmod 700 /usr/local/sbin/backup-podium
sudo /usr/local/sbin/backup-podium
sudo crontab -e
```

Add: `15 2 * * * /usr/local/sbin/backup-podium`

- [ ] Copy backups to a different machine or storage provider.
- [ ] Test restoring both PostgreSQL and uploads before launch.

## 14. Add GitHub Actions deployment

The production workflow must:

1. Run `npm ci`, lint, typecheck, tests, and build.
2. Deploy only into `/var/www/podium`.
3. Install production dependencies/build, or upload a tested artifact.
4. Apply only reviewed, not-yet-applied SQL migrations.
5. Run `sudo systemctl restart podium`.
6. Require `curl --fail https://api.example.com/health` to pass.

Never delete or synchronize `/var/lib/podium/uploads`. Protect the production branch and
store SSH credentials in GitHub environment secrets.

## 15. Add monitoring and cleanup

- [ ] Monitor HTTPS uptime, HTTP 5xx, restarts, disk, and PostgreSQL.
- [ ] Read API logs with `journalctl -u podium`; configure journald retention.
- [ ] Never log passwords, tokens, authorization headers, or precise GPS data.
- [ ] Keep audit events separate from technical error logs.
- [ ] Run upload cleanup periodically—dry run first:

```bash
cd /var/www/podium
sudo bash -c 'set -a; source /etc/podium.env; set +a; node scripts/cleanup-user-uploads.mjs'
sudo bash -c 'set -a; source /etc/podium.env; set +a; node scripts/cleanup-user-uploads.mjs --delete'
```

## 16. Final production test

- [ ] Login/logout; create, edit, and delete an event.
- [ ] Create a public ride and verify route persistence.
- [ ] Join, approve/reject, and view participants.
- [ ] Start, pause, resume, finish, refresh, and log in again.
- [ ] Upload, replace, and reset avatar/cover images.
- [ ] Verify API/network failure behavior.
- [ ] Test Android GPS on real devices: background, weak network, reconnect, duplicate and
  old updates, and movement on the LIVE web map.
- [ ] Confirm one rider cannot update another rider's location.

Production is ready only after the backup restore and full production flow both pass.
>>>>>>> main
