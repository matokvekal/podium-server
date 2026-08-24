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
