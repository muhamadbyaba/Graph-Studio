# Deployment

BuildGraph Studio is one Node process with no runtime dependencies and no build step. It
stores everything under a single data directory. That makes deployment unusually simple, and
this document covers the parts that still need thought.

## Requirements

- Node 23.6 or newer (the server runs TypeScript through Node's native type stripping)
- A writable data directory
- A TLS-terminating reverse proxy in front, for anything reachable from the internet

## Minimum viable production setup

```bash
git clone https://github.com/OWNER/REPO.git
cd REPO
npm ci

export NODE_ENV=production
export HOST=127.0.0.1                  # the proxy reaches it; the internet does not
export PORT=4317
export BG_SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
export BG_BEHIND_TLS_PROXY=true        # so cookies are issued with Secure
export BG_DATA_DIR=/var/lib/buildgraph
export BG_ALLOW_REGISTRATION=true      # temporarily, to create accounts

npm start
```

Create your accounts, then set `BG_ALLOW_REGISTRATION=false` and restart. Registration is
closed by default in production; opening it is a deliberate act.

**Keep `BG_SESSION_SECRET` stable.** It is not used to sign sessions — those are random tokens
— but the server refuses to start in production without it, and treating it as a permanent
secret keeps the configuration honest as the storage layer evolves.

## Configuration

Every setting is documented in [`.env.example`](../.env.example). Node can load it directly:

```bash
node --env-file=.env apps/studio/server.ts
```

The settings that change behaviour materially:

| Variable | Default | Notes |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Loopback by default. Bind wider only behind a proxy. |
| `NODE_ENV` | `development` | `production` closes registration and requires a session secret. |
| `BG_SESSION_SECRET` | *(generated in dev)* | Required in production, 32+ characters. |
| `BG_BEHIND_TLS_PROXY` | `false` | Set true when the proxy terminates TLS, so cookies get `Secure`. |
| `BG_AUTH_MODE` | `accounts` | `open` disables authentication; refuses to start off loopback or in production. |
| `BG_ALLOW_REGISTRATION` | dev `true`, prod `false` | |
| `BG_DATA_DIR` | `apps/studio/data` | Accounts, sessions, documents, projects. Back this up. |
| `ANTHROPIC_API_KEY` | *(unset)* | Without it the assistant answers deterministically from the engine. |

## Container

```bash
export BG_SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
docker compose up -d
```

The image runs as an unprivileged user with a read-only root filesystem and a named volume at
`/data`. It publishes to `127.0.0.1:4317` so a proxy is still required.

## Reverse proxy

The application needs one thing from a proxy beyond the usual: **do not buffer the event
stream.** `/api/events` is a long-lived Server-Sent Events response, and a buffering proxy will
delay every collaborative update until the buffer fills.

nginx:

```nginx
server {
    listen 443 ssl http2;
    server_name buildgraph.example.com;

    # ssl_certificate / ssl_certificate_key …

    location / {
        proxy_pass         http://127.0.0.1:4317;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Forwarded-Proto $scheme;

        # Server-Sent Events: no buffering, no early timeout.
        proxy_buffering    off;
        proxy_cache        off;
        proxy_read_timeout 1h;
    }

    # IFC meshes are posted for section-cutting and can be large.
    client_max_body_size 32m;
}
```

Caddy needs no special configuration — it does not buffer streamed responses:

```
buildgraph.example.com {
    reverse_proxy 127.0.0.1:4317
}
```

The application sends `X-Accel-Buffering: no` on the event stream, which nginx honours, but
setting `proxy_buffering off` explicitly is clearer about the intent.

## Running as a service

```ini
# /etc/systemd/system/buildgraph.service
[Unit]
Description=BuildGraph Studio
After=network.target

[Service]
Type=simple
User=buildgraph
WorkingDirectory=/opt/buildgraph
EnvironmentFile=/etc/buildgraph/env
ExecStart=/usr/bin/node apps/studio/server.ts
Restart=on-failure
RestartSec=5

# The process needs nothing but its data directory.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/buildgraph

[Install]
WantedBy=multi-user.target
```

The server handles `SIGTERM` by closing the live streams and flushing every document with
unsaved edits before exiting, so `systemctl restart` does not lose work. Give it a few seconds:

```ini
TimeoutStopSec=15
```

## Backups

Everything durable lives under `BG_DATA_DIR`:

```
accounts.json          users and workspaces (passwords are scrypt digests)
sessions.json          active sessions (token digests only, not credentials)
catalog.json           user-added components
workspaces/<id>.json   the live document for each workspace, as its event log
projects/<hash>/       saved projects
```

They are plain JSON written atomically, so a copy taken at any moment is consistent. A nightly
snapshot of the directory is a sufficient backup:

```bash
tar czf "buildgraph-$(date +%F).tar.gz" -C /var/lib buildgraph
```

To restore, stop the service, replace the directory, and start it again.

Because documents are stored as event logs rather than rendered models, a restored project
replays through whatever engine version is running — it picks up every fix made since it was
saved.

## Monitoring

`GET /api/health` is unauthenticated and reports process status, the registered jurisdictions,
whether the copilot is configured, and the auth mode:

```json
{ "status": "ok", "version": "0.1.0", "jurisdictions": ["GULF", "US"], "ai": false, "authMode": "accounts" }
```

The container declares a `HEALTHCHECK` against it.

Failures are logged to stdout with the request method and path. Client errors are not logged
as failures; only unexpected exceptions are, and those carry a full stack trace server-side
while the client receives a bare `500`.

## Scaling

Honest limits, so nobody is surprised:

- **One process.** Sessions, live documents, the SSE hub and the rate limiters are all in
  process memory. Running two instances behind a load balancer will not work correctly today:
  rate limits become per-instance and collaborators on different instances will not see each
  other. Vertical scaling is the supported path.
- **Documents are held in memory** while in use, bounded by `BG_MAX_DOCUMENTS_IN_MEMORY` with
  least-recently-used eviction. Evicted documents are flushed to disk first and reloaded on
  next access. A workspace with live collaborators is never evicted.
- **Edits autosave** on a one-second debounce, so a hard kill loses at most a second of work.
  A clean shutdown loses none.

Moving to multiple instances would mean a shared session store, a shared rate limiter and a
pub/sub channel behind the SSE hub. The interfaces are narrow enough to make that a contained
change, but it has not been done.
