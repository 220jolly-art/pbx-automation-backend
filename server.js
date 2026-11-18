'use strict';
/**
 * server.js — PBX Automation backend (Node.js + Express).
 *
 * Database: SQLite by default (better-sqlite3, ./data.db); Postgres via
 * `pg` when DATABASE_URL is set (Render free tier). See db.js.
 * Serves the Android worker app (APK) and the web admin panel.
 * Ports/conventions inherited from ../combined/:
 *   - proxy formats: ip:port:user:pass, user:pass@ip:port, ip:port, socks5://...
 *   - ENV Local API runs on 8787, MityTech dashboard on 8765 — this
 *     backend is NEW and runs on 3000 by default. Do not confuse them.
 *
 * Auth:
 *   - Admin routes (/api/proxies, /api/links, /api/config, /api/workers)
 *     require header X-Admin-Token matching env ADMIN_TOKEN.
 *   - Worker routes (/api/tasks/*, /api/workers/register) need only a
 *     workerId — a lighter check, by design: workers are untrusted
 *     devices that must never hold the admin token.
 *   - GET /api/health is public.
 *
 * Worker management (admin): PUT/DELETE /api/workers/:id and
 * POST /api/workers/:id/assign store per-worker display name, enabled
 * flag, assigned proxies/links and per-worker settings overrides
 * (tabs_count, cycle_timeout_seconds). GET /api/tasks/next serves only
 * a worker's assigned proxies/links when assignments exist, otherwise
 * it falls back to the global round-robin pool. Workers pick up admin
 * changes on their next sync — GET /api/tasks/config?workerId= (and
 * every /api/tasks/next response, which carries `config`) — no push.
 *
 * Embedding: require('./server') and call startServer(port) to run the
 * backend in-process (the Electron admin app does this). Running
 * `node server.js` still starts it standalone.
 * Run:  npm install && npm start   (or: npm run dev)
 * Env:  see .env.example (PORT, ADMIN_TOKEN, DATABASE_PATH, DATABASE_URL)
 */
try { require('dotenv').config(); } catch { /* dotenv is optional — env vars still work */ }

const express = require('express');
const cors = require('cors');
const dbLayer = require('./db');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

// DB schema + default config are created inside startServer() (awaited
// before the server starts listening). In SQLite mode init() is also
// run at db.js require time, so direct db.js consumers still see a
// ready database; in Postgres mode init() is async and query methods
// await readiness internally.

app.use(cors());
app.use(express.json({ limit: '1mb' }));

// --- helpers ---------------------------------------------------------
function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) {
    return res.status(500).json({ error: 'ADMIN_TOKEN is not configured on the server' });
  }
  const token = req.get('X-Admin-Token') || '';
  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'invalid or missing admin token' });
  }
  next();
}

function rowProxy(r) {
  if (!r) return null;
  return {
    id: r.id, host: r.host, port: r.port,
    username: r.username || '', password: r.password || '',
    type: r.type, country: r.country || '',
    is_active: !!r.is_active, added_date: r.added_date,
    last_checked: r.last_checked || null, use_count: r.use_count || 0,
  };
}
function rowLink(r) {
  if (!r) return null;
  return {
    id: r.id, url: r.url, type: r.type, status: r.status,
    created_at: r.created_at, completed_at: r.completed_at || null,
    fail_reason: r.fail_reason || '',
  };
}
function rowWorker(r) {
  if (!r) return null;
  return {
    id: r.id,
    display_name: r.display_name || '',
    enabled: r.enabled === undefined ? true : !!r.enabled,
    deviceInfo: r.device_info || '',
    completed_count: r.completed_count || 0,
    active_link_id: r.active_link_id || null,
    last_seen: r.last_seen,
  };
}
// Full admin view of a worker: base fields + assignments + settings.
async function workerDetail(r) {
  if (!r) return null;
  const base = rowWorker(r);
  const a = await dbLayer.getWorkerAssignments(r.id);
  return { ...base, proxy_ids: a.proxy_ids, link_ids: a.link_ids, settings: a.settings };
}
function publicProxy(r) {
  // What a worker gets: no password is hidden here — workers need the
  // full proxy to connect. Only send a proxy to a registered workerId.
  const p = rowProxy(r);
  if (!p) return null;
  return p;
}
function isValidUrl(s) {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// --- public ----------------------------------------------------------
app.get('/api/health', asyncHandler(async (req, res) => {
  const [proxies, links, workers] = await Promise.all([
    dbLayer.q.listProxies.all(),
    dbLayer.q.listLinks.all(),
    dbLayer.q.listWorkers.all(),
  ]);
  res.json({
    ok: true,
    service: 'pbx-automation-backend',
    version: '1.0.0',
    time: new Date().toISOString(),
    db: dbLayer.dbPath,
    counts: {
      proxies: proxies.length,
      links: links.length,
      workers: workers.length,
    },
  });
}));

// --- proxies (admin) -------------------------------------------------
app.get('/api/proxies', requireAdmin, asyncHandler(async (req, res) => {
  res.json((await dbLayer.q.listProxies.all()).map(rowProxy));
}));

app.post('/api/proxies', requireAdmin, asyncHandler(async (req, res) => {
  const { host, port, username = '', password = '', type = 'http', country = '', is_active = true } = req.body || {};
  if (!host || !port || Number.isNaN(parseInt(port, 10))) {
    return res.status(400).json({ error: 'host and numeric port are required' });
  }
  if (!['http', 'https', 'socks5'].includes(type)) {
    return res.status(400).json({ error: 'type must be http, https or socks5' });
  }
  const info = await dbLayer.q.insertProxy.run(host.trim(), parseInt(port, 10), String(username), String(password), type, String(country), is_active ? 1 : 0);
  res.status(201).json(rowProxy(await dbLayer.q.getProxy.get(info.lastInsertRowid)));
}));

app.post('/api/proxies/bulk', requireAdmin, asyncHandler(async (req, res) => {
  const text = typeof req.body === 'string' ? req.body : (req.body.text || req.body.proxies || '');
  const lines = Array.isArray(text) ? text : String(text).split(/\r?\n/);
  const added = [];
  const skipped = [];
  const tx = dbLayer.db.transaction(async () => {
    for (const line of lines) {
      const parsed = dbLayer.parseProxyLine(line);
      if (!parsed) { if (String(line).trim() && !String(line).trim().startsWith('#')) skipped.push(String(line).trim()); continue; }
      const info = await dbLayer.q.insertProxy.run(
        parsed.host, parsed.port, parsed.username, parsed.password, parsed.type, '', 1
      );
      added.push(rowProxy(await dbLayer.q.getProxy.get(info.lastInsertRowid)));
    }
  });
  await tx();
  res.status(201).json({ added: added.length, skipped, proxies: added });
}));

app.put('/api/proxies/:id', requireAdmin, asyncHandler(async (req, res) => {
  const existing = await dbLayer.q.getProxy.get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'proxy not found' });
  const b = req.body || {};
  const host = b.host !== undefined ? String(b.host).trim() : existing.host;
  const port = b.port !== undefined ? parseInt(b.port, 10) : existing.port;
  if (!host || Number.isNaN(port)) return res.status(400).json({ error: 'host and numeric port are required' });
  const type = b.type !== undefined ? b.type : existing.type;
  if (!['http', 'https', 'socks5'].includes(type)) return res.status(400).json({ error: 'type must be http, https or socks5' });
  await dbLayer.q.updateProxy.run(
    host, port,
    b.username !== undefined ? String(b.username) : existing.username,
    b.password !== undefined ? String(b.password) : existing.password,
    type,
    b.country !== undefined ? String(b.country) : existing.country,
    b.is_active !== undefined ? (b.is_active ? 1 : 0) : existing.is_active,
    b.last_checked !== undefined ? b.last_checked : existing.last_checked,
    req.params.id
  );
  res.json(rowProxy(await dbLayer.q.getProxy.get(req.params.id)));
}));

app.delete('/api/proxies/:id', requireAdmin, asyncHandler(async (req, res) => {
  const existing = await dbLayer.q.getProxy.get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'proxy not found' });
  await dbLayer.q.deleteProxy.run(req.params.id);
  res.json({ ok: true, deleted: Number(req.params.id) });
}));

// --- links (admin) ---------------------------------------------------
app.get('/api/links', requireAdmin, asyncHandler(async (req, res) => {
  const { status } = req.query;
  let rows = await dbLayer.q.listLinks.all();
  if (status) rows = rows.filter((r) => r.status === status);
  res.json(rows.map(rowLink));
}));

app.post('/api/links', requireAdmin, asyncHandler(async (req, res) => {
  const { url, type = 'shortener' } = req.body || {};
  if (!url || !isValidUrl(String(url))) return res.status(400).json({ error: 'a valid http(s) url is required' });
  if (!['shortener', 'ad', 'view'].includes(type)) return res.status(400).json({ error: 'type must be shortener, ad or view' });
  const info = await dbLayer.q.insertLink.run(String(url).trim(), type);
  res.status(201).json(rowLink(await dbLayer.q.getLink.get(info.lastInsertRowid)));
}));

app.post('/api/links/bulk', requireAdmin, asyncHandler(async (req, res) => {
  // Accepts {links: [...]} (strings or {url, type}) or newline text.
  let items = [];
  if (Array.isArray(req.body.links)) items = req.body.links;
  else if (typeof req.body.text === 'string') items = req.body.text.split(/\r?\n/);
  else if (typeof req.body === 'string') items = req.body.split(/\r?\n/);
  else if (Array.isArray(req.body)) items = req.body;
  else return res.status(400).json({ error: 'send {links: [...]} or newline-separated text' });

  const added = [];
  const skipped = [];
  const tx = dbLayer.db.transaction(async () => {
    for (const item of items) {
      const url = typeof item === 'string' ? item.trim() : String(item.url || '').trim();
      const type = (typeof item === 'object' && item.type) || 'shortener';
      if (!url) continue;
      if (!isValidUrl(url) || !['shortener', 'ad', 'view'].includes(type)) { skipped.push(url); continue; }
      const info = await dbLayer.q.insertLink.run(url, type);
      added.push(rowLink(await dbLayer.q.getLink.get(info.lastInsertRowid)));
    }
  });
  await tx();
  res.status(201).json({ added: added.length, skipped, links: added });
}));

app.delete('/api/links/:id', requireAdmin, asyncHandler(async (req, res) => {
  const existing = await dbLayer.q.getLink.get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'link not found' });
  await dbLayer.q.deleteLink.run(req.params.id);
  res.json({ ok: true, deleted: Number(req.params.id) });
}));

// --- config (admin) --------------------------------------------------
// GET /api/config?workerId=<id> returns the global config with that
// worker's per-worker overrides applied (tabs_count,
// cycle_timeout_seconds). Without workerId it returns the global config.
app.get('/api/config', requireAdmin, asyncHandler(async (req, res) => {
  const workerId = String(req.query.workerId || '').trim();
  res.json(workerId ? await dbLayer.getMergedConfigForWorker(workerId) : await dbLayer.getConfigObject());
}));

app.put('/api/config', requireAdmin, asyncHandler(async (req, res) => {
  const b = req.body || {};
  const current = await dbLayer.getConfigObject();
  const next = { ...current };
  if (b.destination_patterns !== undefined) {
    if (!Array.isArray(b.destination_patterns) || b.destination_patterns.some((p) => typeof p !== 'string')) {
      return res.status(400).json({ error: 'destination_patterns must be an array of strings' });
    }
    next.destination_patterns = b.destination_patterns;
  }
  if (b.cycle_timeout_seconds !== undefined) {
    const n = Number(b.cycle_timeout_seconds);
    if (Number.isNaN(n) || n < 5 || n > 300) return res.status(400).json({ error: 'cycle_timeout_seconds must be 5–300' });
    next.cycle_timeout_seconds = n;
  }
  if (b.tabs_count !== undefined) {
    const n = Number(b.tabs_count);
    if (Number.isNaN(n) || n < 1 || n > 10) return res.status(400).json({ error: 'tabs_count must be 1–10' });
    next.tabs_count = n;
  }
  if (b.captcha_solver_key !== undefined) next.captcha_solver_key = String(b.captcha_solver_key);
  await dbLayer.setConfigObject(next);
  res.json(next);
}));

// --- workers ---------------------------------------------------------
app.post('/api/workers/register', asyncHandler(async (req, res) => {
  const { workerId, deviceInfo = '' } = req.body || {};
  if (!workerId || typeof workerId !== 'string' || !workerId.trim()) {
    return res.status(400).json({ error: 'workerId is required' });
  }
  await dbLayer.q.upsertWorker.run(workerId.trim(), String(deviceInfo));
  res.status(201).json(rowWorker(await dbLayer.q.getWorker.get(workerId.trim())));
}));

app.get('/api/workers', requireAdmin, asyncHandler(async (req, res) => {
  const workers = await Promise.all((await dbLayer.q.listWorkers.all()).map(workerDetail));
  const totalCompleted = (await dbLayer.q.totalCompleted.get()).n;
  res.json({ total_completed: totalCompleted, workers });
}));

// Update a worker: display_name, enabled, assigned proxy/link ids and
// per-worker settings overrides. All fields optional; omitted fields
// keep their current value (proxyIds/linkIds replace assignments only
// when present). settings: {tabs_count?, cycle_timeout_seconds?} —
// null clears that override back to the global config value.
app.put('/api/workers/:id', requireAdmin, asyncHandler(async (req, res) => {
  const existing = await dbLayer.q.getWorker.get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'worker not found' });
  const b = req.body || {};
  try {
    const displayName = b.display_name !== undefined ? String(b.display_name).trim() : (existing.display_name || '');
    const enabled = b.enabled !== undefined ? !!b.enabled : !!existing.enabled;
    await dbLayer.db.transaction(async () => {
      await dbLayer.q.updateWorker.run(displayName, enabled ? 1 : 0, req.params.id);
      if (b.proxyIds !== undefined || b.linkIds !== undefined) {
        const current = await dbLayer.getWorkerAssignments(req.params.id);
        await dbLayer.setWorkerAssignments(
          req.params.id,
          b.proxyIds !== undefined ? b.proxyIds : current.proxy_ids,
          b.linkIds !== undefined ? b.linkIds : current.link_ids
        );
      }
      if (b.settings !== undefined && b.settings !== null) {
        await dbLayer.setWorkerSettings(req.params.id, b.settings);
      }
    })();
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  res.json(await workerDetail(await dbLayer.q.getWorker.get(req.params.id)));
}));

app.delete('/api/workers/:id', requireAdmin, asyncHandler(async (req, res) => {
  const existing = await dbLayer.q.getWorker.get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'worker not found' });
  await dbLayer.q.deleteWorker.run(req.params.id);
  res.json({ ok: true, deleted: req.params.id });
}));

// Replace a worker's assignments: {proxyIds: [...], linkIds: [...]}.
// Either key may be omitted (keeps that side); an empty array clears it.
// Unknown ids are dropped. Workers with no assignments fall back to the
// global pool in /api/tasks/next.
app.post('/api/workers/:id/assign', requireAdmin, asyncHandler(async (req, res) => {
  const existing = await dbLayer.q.getWorker.get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'worker not found' });
  const b = req.body || {};
  const current = await dbLayer.getWorkerAssignments(req.params.id);
  const result = await dbLayer.setWorkerAssignments(
    req.params.id,
    b.proxyIds !== undefined ? b.proxyIds : current.proxy_ids,
    b.linkIds !== undefined ? b.linkIds : current.link_ids
  );
  res.json({ ...(await workerDetail(await dbLayer.q.getWorker.get(req.params.id))), assigned: result });
}));

// --- tasks (worker; lighter check — workerId only) -------------------
// Worker-facing config sync: global config with this worker's overrides
// applied. Workers call this on app start and can rely on the `config`
// field in every /api/tasks/next response instead — either way, admin
// changes propagate on the next sync; there is no push channel.
app.get('/api/tasks/config', asyncHandler(async (req, res) => {
  const workerId = String(req.query.workerId || '').trim();
  if (!workerId) return res.status(400).json({ error: 'workerId query param is required' });
  let worker = await dbLayer.q.getWorker.get(workerId);
  if (!worker) {
    await dbLayer.q.upsertWorker.run(workerId, '');
    worker = await dbLayer.q.getWorker.get(workerId);
  }
  res.json(await dbLayer.getMergedConfigForWorker(workerId));
}));

// Worker-facing bulk queue (no admin token): the APK pulls a batch of
// queued links into its local Room cache. Assignment-aware (assigned
// links only when assignments exist, else the global queued pool).
// Does NOT mark links active — the APK reports each link via
// complete/failed when its tab finishes. Disabled workers get 403.
app.get('/api/tasks/queue', asyncHandler(async (req, res) => {
  const workerId = String(req.query.workerId || '').trim();
  if (!workerId) return res.status(400).json({ error: 'workerId query param is required' });
  let worker = await dbLayer.q.getWorker.get(workerId);
  if (!worker) {
    await dbLayer.q.upsertWorker.run(workerId, '');
    worker = await dbLayer.q.getWorker.get(workerId);
  } else {
    await dbLayer.q.touchWorker.run(workerId);
  }
  if (worker.enabled === 0) {
    return res.status(403).json({ error: 'worker disabled by admin' });
  }
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
  const assignments = await dbLayer.getWorkerAssignments(workerId);
  const links = assignments.link_ids.length > 0
    ? await dbLayer.q.assignedQueuedLinks.all(workerId, limit)
    : await dbLayer.q.queuedLinks.all(limit);
  res.json({ links: links.map(rowLink) });
}));

// Worker-facing proxy pool (no admin token): the APK caches the pool and
// picks the active / first fresh proxy on Connect. Assignment-aware
// (assigned proxies only when assignments exist, else all active).
app.get('/api/tasks/proxies', asyncHandler(async (req, res) => {
  const workerId = String(req.query.workerId || '').trim();
  if (!workerId) return res.status(400).json({ error: 'workerId query param is required' });
  let worker = await dbLayer.q.getWorker.get(workerId);
  if (!worker) {
    await dbLayer.q.upsertWorker.run(workerId, '');
    worker = await dbLayer.q.getWorker.get(workerId);
  } else {
    await dbLayer.q.touchWorker.run(workerId);
  }
  if (worker.enabled === 0) {
    return res.status(403).json({ error: 'worker disabled by admin' });
  }
  const assignments = await dbLayer.getWorkerAssignments(workerId);
  const proxies = assignments.proxy_ids.length > 0
    ? await dbLayer.q.assignedProxies.all(workerId)
    : await dbLayer.q.activeProxies.all();
  res.json({ proxies: proxies.map(publicProxy) });
}));

app.get('/api/tasks/next', asyncHandler(async (req, res) => {
  const workerId = String(req.query.workerId || '').trim();
  if (!workerId) return res.status(400).json({ error: 'workerId query param is required' });
  let worker = await dbLayer.q.getWorker.get(workerId);
  if (!worker) {
    await dbLayer.q.upsertWorker.run(workerId, '');
    worker = await dbLayer.q.getWorker.get(workerId);
  } else {
    await dbLayer.q.touchWorker.run(workerId);
  }
  if (worker.enabled === 0) {
    return res.status(403).json({ error: 'worker disabled by admin' });
  }

  // Assignment-aware picks: if the worker has assigned proxies/links,
  // serve only from those; otherwise fall back to the global pool.
  const assignments = await dbLayer.getWorkerAssignments(workerId);
  const hasProxyAssignment = assignments.proxy_ids.length > 0;
  const hasLinkAssignment = assignments.link_ids.length > 0;
  const pickProxy = async () => (hasProxyAssignment
    ? await dbLayer.q.nextAssignedProxy.get(workerId)
    : await dbLayer.q.nextProxy.get());
  const config = await dbLayer.getMergedConfigForWorker(workerId);

  // If this worker already has an active link, hand it back (idempotent).
  if (worker.active_link_id) {
    const active = await dbLayer.q.getLink.get(worker.active_link_id);
    if (active && active.status === 'active') {
      const proxy = await pickProxy();
      if (proxy) await dbLayer.q.bumpProxyUse.run(proxy.id);
      return res.json({ link: rowLink(active), proxy: publicProxy(proxy), resumed: true, config });
    }
  }

  const link = hasLinkAssignment
    ? await dbLayer.q.nextAssignedLink.get(workerId)
    : await dbLayer.q.nextQueuedLink.get();
  if (!link) {
    return res.json({
      link: null, proxy: null, config,
      message: hasLinkAssignment ? 'no queued links assigned to this worker' : 'no queued links',
    });
  }
  const proxy = await pickProxy(); // round-robin: least-used active first
  await dbLayer.db.transaction(async () => {
    await dbLayer.q.markLinkActive.run(link.id);
    await dbLayer.q.setWorkerActive.run(link.id, workerId);
    if (proxy) await dbLayer.q.bumpProxyUse.run(proxy.id);
  })();
  res.json({ link: rowLink(await dbLayer.q.getLink.get(link.id)), proxy: publicProxy(proxy), resumed: false, config });
}));

app.post('/api/tasks/complete', asyncHandler(async (req, res) => {
  const { workerId, linkId, durationMs } = req.body || {};
  if (!workerId || !linkId) return res.status(400).json({ error: 'workerId and linkId are required' });
  const link = await dbLayer.q.getLink.get(linkId);
  if (!link) return res.status(404).json({ error: 'link not found' });
  const worker = await dbLayer.q.getWorker.get(String(workerId));
  if (!worker) return res.status(404).json({ error: 'worker not registered — call /api/workers/register first' });
  await dbLayer.db.transaction(async () => {
    await dbLayer.q.markLinkDone.run(linkId);
    await dbLayer.q.incrementWorkerCompleted.run(String(workerId));
  })();
  res.json({ ok: true, link: rowLink(await dbLayer.q.getLink.get(linkId)), worker: rowWorker(await dbLayer.q.getWorker.get(String(workerId))), durationMs: durationMs || null });
}));

app.post('/api/tasks/failed', asyncHandler(async (req, res) => {
  const { workerId, linkId, reason = '' } = req.body || {};
  if (!workerId || !linkId) return res.status(400).json({ error: 'workerId and linkId are required' });
  const link = await dbLayer.q.getLink.get(linkId);
  if (!link) return res.status(404).json({ error: 'link not found' });
  const worker = await dbLayer.q.getWorker.get(String(workerId));
  if (worker) await dbLayer.q.clearWorkerActive.run(String(workerId));
  await dbLayer.q.markLinkFailed.run(String(reason).slice(0, 500), linkId);
  res.json({ ok: true, link: rowLink(await dbLayer.q.getLink.get(linkId)) });
}));

// --- root status -----------------------------------------------------
// A plain status page for the deployment root. Without an explicit
// handler Vercel's rewrite of "/" to the serverless function failed
// with FUNCTION_INVOCATION_FAILED instead of reaching the 404 handler.
app.get('/', (req, res) =>
  res.json({
    ok: true,
    service: 'pbx-automation-backend',
    version: '1.0.0',
    health: '/api/health',
  })
);

// --- errors / 404 ----------------------------------------------------
app.use((req, res) => res.status(404).json({ error: 'not found', path: req.path }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[server] error:', err);
  res.status(500).json({ error: 'internal server error' });
});

function startServer(port = PORT) {
  // Returns the http.Server synchronously (the Electron admin app
  // assigns it and calls .close() on shutdown, so this must NOT become
  // an async function). Schema + default config are kicked off here:
  // in SQLite mode init() is synchronous anyway; in Postgres mode the
  // init promise resolves in the background and every query awaits
  // readiness internally (db.js ensureReady), so requests that arrive
  // during init simply wait for it instead of failing. The standalone
  // path below awaits init() before calling startServer(), so a bad
  // DATABASE_URL still fails fast there (see require.main branch).
  dbLayer.init();
  dbLayer.seedDefaultConfigIfEmpty().catch((err) =>
    console.error('[server] failed to seed default config:', err)
  );
  const server = app.listen(port, () => {
    console.log(`[server] pbx-automation-backend listening on http://localhost:${port}`);
    console.log(`[server] db: ${dbLayer.dbPath}`);
    console.log(`[server] health: http://localhost:${port}/api/health`);
  });
  return server;
}

// Standalone: `node server.js` starts listening. Embedded (Electron
// admin app): require('./server') and call startServer(port) instead.
if (require.main === module) {
  (async () => {
    await dbLayer.init();
    await dbLayer.seedDefaultConfigIfEmpty();
    startServer();
  })().catch((err) => {
    console.error('[server] failed to start:', err);
    process.exit(1);
  });
}

module.exports = { app, startServer };
