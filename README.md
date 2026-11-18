# PBX Automation Backend

Node.js + Express + SQLite backend for the unified PBX / MityTech automation
worker app (Android APK) and the web admin panel.

**Ports — do not confuse them:**

| Port | Service |
|------|---------|
| 8787 | ENV (PBX Virtual Browser) Local API — existing Windows project |
| 8765 | MityTech local dashboard — existing Windows project |
| **3000** | **This backend (default)** — new, serves the APK + admin panel |

Proxy formats are the same as `../combined/config/proxy_pool.txt`:
`ip:port:user:pass`, `user:pass@ip:port`, `ip:port`, `socks5://...`.

## Run locally

```bash
cd backend
npm install
cp .env.example .env        # then set a real ADMIN_TOKEN in .env
npm run seed                # example proxies/links (fake placeholders)
npm start                   # or: npm run dev  (auto-restart on change)
```

Server: http://localhost:3000 — health check: `GET /api/health`.

## Env vars

| Var | Default | Notes |
|-----|---------|-------|
| `PORT` | `3000` | Listen port |
| `ADMIN_TOKEN` | *(none)* | Required. Admin routes return 500 until it is set. Send as `X-Admin-Token` header. |
| `DATABASE_PATH` | `./data.db` | SQLite file (local dev) |
| `DATABASE_URL` | *(unset)* | Postgres connection string for hosting — see "Postgres switch" below |

## Auth

- **Admin routes** (`/api/proxies`, `/api/links`, `/api/config`, `/api/workers`
  including `PUT`/`DELETE /api/workers/:id` and `POST /api/workers/:id/assign`)
  require header `X-Admin-Token: <ADMIN_TOKEN>`.
- **Worker routes** (`/api/tasks/*`, `POST /api/workers/register`) need only a
  `workerId`. Workers are untrusted devices and must never hold the admin token.
  `GET /api/tasks/config?workerId=` is the worker-facing config sync endpoint.
- `GET /api/health` is public.

## API

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| GET | `/api/health` | — | Service status + row counts |
| GET | `/api/proxies` | admin | List proxies |
| POST | `/api/proxies` | admin | Add one proxy `{host, port, username?, password?, type?, country?, is_active?}` |
| POST | `/api/proxies/bulk` | admin | Add many; body `{text: "one per line"}` or `{proxies: [...]}`; auto-parses all formats |
| PUT | `/api/proxies/:id` | admin | Edit a proxy |
| DELETE | `/api/proxies/:id` | admin | Delete a proxy |
| GET | `/api/links` | admin | List links (`?status=queued\|active\|done\|failed`) |
| POST | `/api/links` | admin | Add one link `{url, type?}` (`type`: shortener/ad/view) |
| POST | `/api/links/bulk` | admin | Add many; `{links: [...]}` (strings or `{url,type}`) or newline text |
| DELETE | `/api/links/:id` | admin | Delete a link |
| GET | `/api/config` | admin | Destination patterns + settings. `?workerId=<id>` returns the global config with that worker's overrides applied. |
| PUT | `/api/config` | admin | Update config (partial OK) |
| POST | `/api/workers/register` | workerId | Register a worker `{workerId, deviceInfo?}` |
| GET | `/api/workers` | admin | Worker stats + total completed; each worker now includes `display_name`, `enabled`, `proxy_ids`, `link_ids`, `settings` |
| PUT | `/api/workers/:id` | admin | Update a worker `{display_name?, enabled?, proxyIds?, linkIds?, settings?}` — proxyIds/linkIds replace assignments when present; `settings: {tabs_count?, cycle_timeout_seconds?}` (`null` clears an override back to global) |
| DELETE | `/api/workers/:id` | admin | Delete a worker (assignments + settings are removed with it) |
| POST | `/api/workers/:id/assign` | admin | Replace assignments `{proxyIds?, linkIds?}` — omitted side is kept, empty array clears it; unknown ids are dropped |
| GET | `/api/tasks/config?workerId=` | workerId | Worker-facing config sync: global config with that worker's overrides applied (no admin token needed) |
| GET | `/api/tasks/queue?workerId=` | workerId | Worker-facing bulk queue sync: up to `limit` (default 20, max 100) queued links as `{links: [...]}`. **Assignment-aware:** assigned links only when assignments exist, else the global queued pool. Does NOT mark links active — the APK reports each via complete/failed. Disabled workers get `403`. |
| GET | `/api/tasks/proxies?workerId=` | workerId | Worker-facing proxy pool sync: `{proxies: [...]}` (full proxy rows incl. credentials — workers need them to connect). **Assignment-aware:** assigned proxies only when assignments exist, else all active proxies. Disabled workers get `403`. |
| GET | `/api/tasks/next?workerId=` | workerId | Next queued link + round-robin active proxy (marks link active; idempotent resume if worker already has one). **Assignment-aware:** if the worker has assigned proxies/links, serves only from those; otherwise falls back to the global pool. Disabled workers get `403 worker disabled by admin`. Every response also carries the worker's merged `config`. |
| POST | `/api/tasks/complete` | workerId | `{workerId, linkId, durationMs?}` — marks done, increments worker count |
| POST | `/api/tasks/failed` | workerId | `{workerId, linkId, reason?}` — marks failed |

### Config object

```json
{
  "destination_patterns": ["drive.google.com", "t.me", "telegram.me"],
  "cycle_timeout_seconds": 15,
  "tabs_count": 6,
  "captcha_solver_key": ""
}
```

`destination_patterns` are the final-destination hosts the APK watches for
(auto-close tab + count the task complete when one is reached).
`cycle_timeout_seconds` is the per-link timeout (5–300). `tabs_count` is the
number of concurrent mini-tabs (1–10).

## Worker management + sync behaviour

Admins manage workers from the admin panel (Workers tab) or the API:

- **Display name / enabled:** `PUT /api/workers/:id` with `display_name`
  and `enabled` (`false` disables the worker — it then gets `403 worker
  disabled by admin` from `/api/tasks/next` and no new tasks).
- **Assignments:** `POST /api/workers/:id/assign` with `{proxyIds, linkIds}`
  (or the same keys on `PUT`). A worker with assigned proxies only ever
  receives proxies from that set; a worker with assigned links only ever
  receives links from that set. **No assignments = no restriction** — the
  worker falls back to the global round-robin pool (least-used active
  proxy, oldest queued link).
- **Per-worker settings:** `PUT /api/workers/:id` with
  `settings: {tabs_count, cycle_timeout_seconds}` overrides the global
  config for that worker only. `null` clears an override back to the
  global value. `GET /api/config?workerId=<id>` (admin) shows the merged
  result.

**Sync — no push needed.** Workers fetch the latest config + queue on
app start (`GET /api/tasks/config?workerId=`) and on every task fetch
(`GET /api/tasks/next?workerId=` also returns the merged `config` in
every response). Any admin change — new proxies/links, changed
assignments, toggled enabled flag, changed settings — therefore
propagates to a worker on its next sync, i.e. at most one task cycle
later. Workers never hold the admin token.

## Database

- **Local dev:** SQLite file `data.db` via `better-sqlite3` (WAL mode).
  Schema lives in `db.js` (`proxies`, `links`, `workers`, `config` tables,
  plus `worker_proxies`, `worker_links`, `worker_settings` for worker
  management). `workers` also carries `display_name` and `enabled`
  columns (added by migration in `db.js` `init()` for older databases).
- **Postgres switch (hosting):** implemented 2026-11-18. When `DATABASE_URL`
  is set, the backend uses Postgres via `pg` (Pool, SSL on as Render
  requires) with the same schema, table/column names and API responses as
  SQLite — date columns stay TEXT in `YYYY-MM-DD HH:MM:SS` (UTC) format,
  boolean-ish columns stay INTEGER 0/1, so nothing else changes. Data
  survives restarts/redeploys (unlike SQLite on Render's ephemeral disk).
  `render.yaml` already wires the free Render Postgres database in as
  `DATABASE_URL`. When `DATABASE_URL` is unset, behaviour is exactly as
  before (SQLite `./data.db`). See `../HOSTING.md`.

## Deploy on Vercel (free Hobby tier, no card)

`api/index.js` exports the Express app for Vercel Serverless
Functions (`vercel.json` rewrites every route to it). No `maxDuration`
or other plan-gated options are set, so it validates on the free Hobby
tier.

Env vars (Vercel project Settings → Environment Variables):
- `DATABASE_URL` — hosted Postgres connection string (Neon free tier:
  use the **pooled** connection string). Required on Vercel: without
  it the app falls back to a local SQLite file, which does not persist
  between serverless invocations.
- `ADMIN_TOKEN` — admin API token (`X-Admin-Token` header).

`better-sqlite3` is only ever loaded when `DATABASE_URL` is unset
(lazy require in `db.js`), so the Postgres-only serverless function
never touches the native module. Deploy from the GitHub repo
(`220jolly-art/pbx-automation-backend`): import the repo in Vercel,
set the two env vars, deploy. The `render.yaml` in this repo targets
Render and is ignored by Vercel.

## Files

| File | Purpose |
|------|---------|
| `server.js` | Express app + all routes |
| `db.js` | DB layer: SQLite (default) or Postgres via `pg` when `DATABASE_URL` is set — schema, proxy parser, config store, transactions. Both adapters load lazily; the Postgres path never requires `better-sqlite3` |
| `api/index.js` | Vercel Serverless entrypoint (exports the Express app) |
| `vercel.json` | Vercel rewrites (all routes → `api/index.js`); no plan-gated options |
| `seed.js` | Example data (`npm run seed`, `--reset` to wipe first) |
| `render.yaml` | Render free deploy config (ignored by Vercel) |
| `.env.example` | Env template |
| `package.json` | Deps: express, cors, better-sqlite3, pg |

## Smoke test (after `npm install`)

```bash
ADMIN_TOKEN=test-token PORT=3000 node server.js &
curl http://localhost:3000/api/health
curl -H "X-Admin-Token: test-token" http://localhost:3000/api/proxies
```

Postgres mode (same commands, `DATABASE_URL` set — verified against
local PostgreSQL 16; Render's free Postgres is the same setup):

```bash
DATABASE_URL='postgres://<user>:<pass>@<host>:5432/<db>' ADMIN_TOKEN=test-token PORT=3000 node server.js &
curl http://localhost:3000/api/health   # "db": "postgres (DATABASE_URL)"
```

A bad `DATABASE_URL` fails fast at startup with a clear error
(`[db] Postgres init failed: connect ECONNREFUSED ...`) instead of
serving with a broken database.
