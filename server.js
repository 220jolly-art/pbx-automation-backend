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
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
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
    user_id: r.user_id || null,
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
    version: '2.0.0',
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
  // WorkFlowX v2 keys (§2 of the contract).
  if (b.referral_enabled !== undefined) {
    const n = Number(b.referral_enabled);
    if (n !== 0 && n !== 1) return res.status(400).json({ error: 'referral_enabled must be 0 or 1' });
    next.referral_enabled = n;
  }
  if (b.referral_reward !== undefined) {
    const n = Number(b.referral_reward);
    if (!Number.isInteger(n) || n < 0 || n > 1000) return res.status(400).json({ error: 'referral_reward must be an integer 0–1000' });
    next.referral_reward = n;
  }
  if (b.task_reward_default !== undefined) {
    const n = Number(b.task_reward_default);
    if (!Number.isInteger(n) || n < 0 || n > 1000) return res.status(400).json({ error: 'task_reward_default must be an integer 0–1000' });
    next.task_reward_default = n;
  }
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
  // v2: admin-assigned proxies first (source:"admin"), then the worker's
  // manual proxy as fallback (source:"manual"). The APK Connect uses
  // the FIRST entry, so an admin proxy wins over manual.
  const out = proxies.map((p) => ({ ...publicProxy(p), source: 'admin' }));
  const manual = await dbLayer.q.getManualProxy.get(workerId);
  if (manual) {
    out.push({
      host: manual.host, port: manual.port,
      username: manual.username || '', password: manual.password || '',
      type: manual.type, source: 'manual',
    });
  }
  res.json({ proxies: out });
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

// =====================================================================
// WorkFlowX v2 (see ../v2/API_CONTRACT.md — FROZEN).
//   - User auth: bcryptjs-hashed passwords, DB-stored random tokens
//     (NO JWT, no new env vars). User endpoints use
//     `Authorization: Bearer <token>`; admin endpoints keep X-Admin-Token.
//   - v1 endpoints above are unchanged; v2 adds /api/auth/*,
//     /api/tasks (admin CRUD), /api/v2/tasks (worker), /api/users,
//     /api/referral/me, /api/earning-options, /api/withdrawals,
//     /api/admin/* and the manual-proxy extension in /api/tasks/proxies.
// =====================================================================

const REFERRAL_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateReferralCode() {
  let code = 'WFX-';
  for (let i = 0; i < 6; i++) code += REFERRAL_ALPHABET[crypto.randomInt(REFERRAL_ALPHABET.length)];
  return code;
}
async function generateUniqueReferralCode() {
  for (let i = 0; i < 20; i++) {
    const code = generateReferralCode();
    if (!(await dbLayer.q.getUserByReferralCode.get(code))) return code;
  }
  throw new Error('could not generate a unique referral code');
}
// Strip spaces, allow a leading +91/91, keep the last 10 digits.
function normalizeMobile(s) {
  const digits = String(s || '').replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}
function isValidEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim());
}
function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, name: u.name, email: u.email, mobile: u.mobile,
    referral_code: u.referral_code, created_at: u.created_at,
  };
}
async function userBalance(userId) {
  return (await dbLayer.q.userBalance.get(userId)).n;
}
// Today's UTC date as 'YYYY-MM-DD' — matches the TEXT created_at
// columns via substr(created_at, 1, 10) in both adapters.
function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}
function parseScriptJson(text) {
  try {
    const v = JSON.parse(text || '[]');
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}
// Validate a task script: array (or JSON string of one) of objects,
// each with a known step type. Returns {script} or {error}.
const SCRIPT_STEP_TYPES = ['wait', 'scroll', 'click', 'wait_for', 'wait_for_enabled', 'wait_for_href'];
function parseScript(input) {
  if (input === undefined) return { script: [] };
  let arr = input;
  if (typeof input === 'string') {
    try { arr = JSON.parse(input); } catch { return { error: 'script must be a JSON array' }; }
  }
  if (!Array.isArray(arr)) return { error: 'script must be an array of steps' };
  for (const step of arr) {
    if (!step || typeof step !== 'object' || !SCRIPT_STEP_TYPES.includes(step.type)) {
      return { error: 'each script step must be an object with a known type (wait, scroll, click, wait_for, wait_for_enabled, wait_for_href)' };
    }
  }
  return { script: arr };
}
function rowTask(r) {
  if (!r) return null;
  return {
    id: r.id, name: r.name, link_type: r.link_type,
    script: parseScriptJson(r.script), reward: r.reward,
    is_active: !!r.is_active, created_at: r.created_at,
  };
}
function rowEarningOption(r) {
  if (!r) return null;
  let config = {};
  try { config = JSON.parse(r.config || '{}'); } catch { config = {}; }
  return {
    id: r.id, name: r.name, kind: r.kind, description: r.description || '',
    reward: r.reward, config, is_active: !!r.is_active, created_at: r.created_at,
  };
}
function rowAnnouncement(r) {
  if (!r) return null;
  return {
    id: r.id, title: r.title, body: r.body || '',
    is_active: !!r.is_active, created_at: r.created_at,
  };
}
function rowWithdrawal(r) {
  if (!r) return null;
  const base = {
    id: r.id, user_id: r.user_id, amount: r.amount, upi: r.upi,
    status: r.status, created_at: r.created_at, decided_at: r.decided_at || null,
  };
  if (r.user_name !== undefined) base.user_name = r.user_name;
  if (r.user_mobile !== undefined) base.user_mobile = r.user_mobile;
  return base;
}
function rowSubmission(r) {
  if (!r) return null;
  let payload = {};
  try { payload = JSON.parse(r.payload || '{}'); } catch { payload = {}; }
  return {
    id: r.id, user_id: r.user_id,
    user_name: r.user_name || '', option_id: r.option_id,
    option_name: r.option_name || '', reward: r.reward,
    payload, status: r.status, created_at: r.created_at,
    decided_at: r.decided_at || null,
  };
}

// Bearer user auth. Loads the user from the DB-stored token.
const requireUser = asyncHandler(async (req, res, next) => {
  const h = req.get('Authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/);
  if (!m) return res.status(401).json({ error: 'missing bearer token' });
  const token = m[1].trim();
  const tok = await dbLayer.q.getAuthToken.get(token);
  if (!tok) return res.status(401).json({ error: 'invalid token' });
  const user = await dbLayer.q.getUserById.get(tok.user_id);
  if (!user) return res.status(401).json({ error: 'invalid token' });
  req.user = user;
  req.authToken = token;
  next();
});

// --- auth (public) ---------------------------------------------------
app.post('/api/auth/register', asyncHandler(async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const email = String(b.email || '').trim().toLowerCase();
  const mobile = normalizeMobile(b.mobile);
  const password = String(b.password || '');
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (!isValidEmail(email)) return res.status(400).json({ error: 'a valid email is required' });
  if (!/^\d{10}$/.test(mobile)) return res.status(400).json({ error: 'mobile must be 10 digits' });
  if (password.length < 6) return res.status(400).json({ error: 'password must be at least 6 characters' });
  let referrer = null;
  if (b.referral_code) {
    referrer = await dbLayer.q.getUserByReferralCode.get(String(b.referral_code).trim().toUpperCase());
    if (!referrer) return res.status(400).json({ error: 'invalid referral code' });
  }
  if (await dbLayer.q.getUserByEmail.get(email)) return res.status(409).json({ error: 'email already registered' });
  if (await dbLayer.q.getUserByMobile.get(mobile)) return res.status(409).json({ error: 'mobile already registered' });
  const code = await generateUniqueReferralCode();
  const hash = bcrypt.hashSync(password, 10);
  const token = crypto.randomBytes(32).toString('hex');
  const config = await dbLayer.getConfigObject();
  let userId;
  const tx = dbLayer.db.transaction(async () => {
    // referred_by is only recorded when referral is enabled: otherwise
    // the referrer's count would rise while no credit is ever paid.
    const referredBy = referrer && config.referral_enabled === 1 ? referrer.id : null;
    const info = await dbLayer.q.insertUser.run(name, email, mobile, hash, code, referredBy);
    userId = info.lastInsertRowid;
    await dbLayer.q.insertAuthToken.run(token, userId);
    if (referrer && config.referral_enabled === 1) {
      await dbLayer.q.insertLedger.run(
        referrer.id, 'referral', Number(config.referral_reward) || 0, userId, `referral:${userId}`
      );
    }
  });
  try {
    await tx();
  } catch (err) {
    // Unique-constraint race (email/mobile/code taken between check and insert).
    if (/UNIQUE|duplicate key/i.test(err.message)) {
      return res.status(409).json({ error: 'email or mobile already registered' });
    }
    throw err;
  }
  // Link this device's pre-login worker row to the new user (best-effort;
  // auth must never fail on a stale/missing workerId).
  if (typeof b.workerId === 'string' && b.workerId.trim()) {
    try { await dbLayer.q.linkWorkerToUser.run(userId, b.workerId.trim()); } catch (e) { console.error('[server] link worker failed:', e.message); }
  }
  res.status(201).json({ user: publicUser(await dbLayer.q.getUserById.get(userId)), token });
}));

app.post('/api/auth/login', asyncHandler(async (req, res) => {
  const b = req.body || {};
  const identifier = String(b.identifier || '').trim();
  const password = String(b.password || '');
  if (!identifier || !password) return res.status(400).json({ error: 'identifier and password are required' });
  let user = null;
  if (isValidEmail(identifier)) {
    user = await dbLayer.q.getUserByEmail.get(identifier.toLowerCase());
  } else {
    const mobile = normalizeMobile(identifier);
    if (/^\d{10}$/.test(mobile)) user = await dbLayer.q.getUserByMobile.get(mobile);
  }
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'invalid credentials' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  await dbLayer.q.insertAuthToken.run(token, user.id);
  // Link this device's pre-login worker row to the user (best-effort).
  if (typeof b.workerId === 'string' && b.workerId.trim()) {
    try { await dbLayer.q.linkWorkerToUser.run(user.id, b.workerId.trim()); } catch (e) { console.error('[server] link worker failed:', e.message); }
  }
  res.json({ user: publicUser(user), token });
}));

app.get('/api/auth/me', requireUser, asyncHandler(async (req, res) => {
  const u = req.user;
  const config = await dbLayer.getConfigObject();
  const [balance, tasksCompleted, tasksToday, referrals, referralEarnings] = await Promise.all([
    userBalance(u.id),
    dbLayer.q.countUserCompletions.get(u.id),
    dbLayer.q.countUserCompletionsToday.get(u.id, todayUtc()),
    dbLayer.q.countReferrals.get(u.id),
    dbLayer.q.userReferralEarnings.get(u.id),
  ]);
  res.json({
    user: publicUser(u),
    balance,
    referral_enabled: config.referral_enabled === 1 ? 1 : 0,
    stats: {
      tasks_completed: tasksCompleted.n,
      tasks_today: tasksToday.n,
      referrals: referrals.n,
      referral_earnings: referralEarnings.n,
    },
  });
}));

app.post('/api/auth/logout', requireUser, asyncHandler(async (req, res) => {
  await dbLayer.q.deleteAuthToken.run(req.authToken);
  res.json({ ok: true });
}));

// --- tasks (admin) ---------------------------------------------------
app.post('/api/tasks', requireAdmin, asyncHandler(async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  const link_type = b.link_type !== undefined ? String(b.link_type) : 'shortener';
  if (!['shortener', 'ad', 'view', 'video'].includes(link_type)) {
    return res.status(400).json({ error: 'link_type must be shortener, ad, view or video' });
  }
  const parsed = parseScript(b.script);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const config = await dbLayer.getConfigObject();
  let reward = config.task_reward_default !== undefined ? Number(config.task_reward_default) : 1;
  if (b.reward !== undefined) {
    reward = Number(b.reward);
    if (!Number.isInteger(reward) || reward < 0) return res.status(400).json({ error: 'reward must be a non-negative integer' });
  }
  const info = await dbLayer.q.insertTask.run(name, link_type, JSON.stringify(parsed.script), reward);
  res.status(201).json(rowTask(await dbLayer.q.getTask.get(info.lastInsertRowid)));
}));

app.get('/api/tasks', requireAdmin, asyncHandler(async (req, res) => {
  const rows = await dbLayer.q.listTasks.all();
  const out = [];
  for (const r of rows) {
    const [lc, cc] = await Promise.all([
      dbLayer.q.countTaskLinks.get(r.id),
      dbLayer.q.countTaskCompletions.get(r.id),
    ]);
    out.push({ ...rowTask(r), link_count: lc.n, completion_count: cc.n });
  }
  res.json(out);
}));

app.get('/api/tasks/:id', requireAdmin, asyncHandler(async (req, res) => {
  const task = await dbLayer.q.getTask.get(req.params.id);
  if (!task) return res.status(404).json({ error: 'task not found' });
  const links = (await dbLayer.q.listTaskLinks.all(task.id)).map((l) => ({
    id: l.id, url: l.url, status: l.status, created_at: l.created_at,
  }));
  const assigned_user_ids = (await dbLayer.q.listTaskAssignmentUserIds.all(task.id)).map((r) => r.user_id);
  res.json({ ...rowTask(task), links, assigned_user_ids });
}));

app.put('/api/tasks/:id', requireAdmin, asyncHandler(async (req, res) => {
  const task = await dbLayer.q.getTask.get(req.params.id);
  if (!task) return res.status(404).json({ error: 'task not found' });
  const b = req.body || {};
  const name = b.name !== undefined ? String(b.name).trim() : task.name;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const link_type = b.link_type !== undefined ? String(b.link_type) : task.link_type;
  if (!['shortener', 'ad', 'view', 'video'].includes(link_type)) {
    return res.status(400).json({ error: 'link_type must be shortener, ad, view or video' });
  }
  let scriptText = task.script;
  if (b.script !== undefined) {
    const parsed = parseScript(b.script);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    scriptText = JSON.stringify(parsed.script);
  }
  let reward = task.reward;
  if (b.reward !== undefined) {
    reward = Number(b.reward);
    if (!Number.isInteger(reward) || reward < 0) return res.status(400).json({ error: 'reward must be a non-negative integer' });
  }
  const is_active = b.is_active !== undefined ? (b.is_active ? 1 : 0) : task.is_active;
  await dbLayer.q.updateTask.run(name, link_type, scriptText, reward, is_active, task.id);
  res.json(rowTask(await dbLayer.q.getTask.get(task.id)));
}));

app.delete('/api/tasks/:id', requireAdmin, asyncHandler(async (req, res) => {
  const task = await dbLayer.q.getTask.get(req.params.id);
  if (!task) return res.status(404).json({ error: 'task not found' });
  const tx = dbLayer.db.transaction(async () => {
    // Completions reference tasks/links without ON DELETE CASCADE, so
    // remove them explicitly; links + assignments cascade with the task.
    await dbLayer.q.deleteTaskCompletions.run(task.id);
    await dbLayer.q.deleteTask.run(task.id);
  });
  await tx();
  res.json({ ok: true, deleted: task.id });
}));

app.post('/api/tasks/:id/links/bulk', requireAdmin, asyncHandler(async (req, res) => {
  const task = await dbLayer.q.getTask.get(req.params.id);
  if (!task) return res.status(404).json({ error: 'task not found' });
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
      if (!url) continue;
      if (!isValidUrl(url)) { skipped.push(url); continue; }
      const info = await dbLayer.q.insertTaskLink.run(task.id, url);
      added.push({ id: info.lastInsertRowid, url, status: 'queued' });
    }
  });
  await tx();
  res.status(201).json({ added: added.length, skipped, links: added });
}));

app.delete('/api/tasks/:id/links/:linkId', requireAdmin, asyncHandler(async (req, res) => {
  const task = await dbLayer.q.getTask.get(req.params.id);
  if (!task) return res.status(404).json({ error: 'task not found' });
  const link = await dbLayer.q.getTaskLink.get(req.params.linkId);
  if (!link || link.task_id !== task.id) return res.status(404).json({ error: 'link not found' });
  await dbLayer.q.deleteTaskLink.run(req.params.linkId, task.id);
  res.json({ ok: true, deleted: Number(req.params.linkId) });
}));

app.post('/api/tasks/:id/assign', requireAdmin, asyncHandler(async (req, res) => {
  const task = await dbLayer.q.getTask.get(req.params.id);
  if (!task) return res.status(404).json({ error: 'task not found' });
  const b = req.body || {};
  const userIds = Array.isArray(b.userIds) ? b.userIds : [];
  const valid = [];
  for (const n of userIds) {
    const id = parseInt(n, 10);
    if (!Number.isNaN(id) && (await dbLayer.q.getUserById.get(id))) valid.push(id);
  }
  const tx = dbLayer.db.transaction(async () => {
    await dbLayer.q.clearTaskAssignments.run(task.id);
    for (const uid of valid) await dbLayer.q.insertTaskAssignment.run(task.id, uid);
  });
  await tx();
  const assigned = (await dbLayer.q.listTaskAssignmentUserIds.all(task.id)).map((r) => r.user_id);
  res.json({ ...rowTask(task), assigned_user_ids: assigned });
}));

// --- tasks (worker, Bearer) ------------------------------------------
app.get('/api/v2/tasks', requireUser, asyncHandler(async (req, res) => {
  const rows = await dbLayer.q.visibleTasksForUser.all(req.user.id);
  const out = [];
  for (const t of rows) {
    const links = (await dbLayer.q.listTaskLinks.all(t.id)).map((l) => ({ id: l.id, url: l.url }));
    out.push({
      id: t.id, name: t.name, link_type: t.link_type, reward: t.reward,
      script: parseScriptJson(t.script), links,
    });
  }
  res.json(out);
}));

app.post('/api/v2/tasks/:taskId/complete', requireUser, asyncHandler(async (req, res) => {
  const b = req.body || {};
  const task = await dbLayer.q.getTask.get(req.params.taskId);
  if (!task) return res.status(404).json({ error: 'task not found' });
  if (!task.is_active) return res.status(400).json({ error: 'task is not active' });
  const link = await dbLayer.q.getTaskLink.get(b.linkId);
  if (!link || link.task_id !== task.id) return res.status(400).json({ error: 'link does not belong to this task' });
  const visible = await dbLayer.q.visibleTasksForUser.all(req.user.id);
  if (!visible.some((t) => t.id === task.id)) return res.status(403).json({ error: 'task not assigned to this user' });
  const workerId = String(b.workerId || '');
  let completionId;
  const tx = dbLayer.db.transaction(async () => {
    const info = await dbLayer.q.insertCompletion.run(req.user.id, task.id, link.id, workerId, task.reward);
    completionId = info.lastInsertRowid;
    await dbLayer.q.insertLedger.run(req.user.id, 'task', task.reward, completionId, `task:${task.id}`);
  });
  await tx();
  res.json({ ok: true, reward: task.reward, balance: await userBalance(req.user.id) });
}));

app.get('/api/v2/tasks/stats', requireUser, asyncHandler(async (req, res) => {
  const [tc, tt, bal] = await Promise.all([
    dbLayer.q.countUserCompletions.get(req.user.id),
    dbLayer.q.countUserCompletionsToday.get(req.user.id, todayUtc()),
    userBalance(req.user.id),
  ]);
  res.json({ tasks_completed: tc.n, tasks_today: tt.n, balance: bal });
}));

// --- manual proxy (worker, Bearer) -----------------------------------
app.post('/api/users/me/proxy', requireUser, asyncHandler(async (req, res) => {
  const b = req.body || {};
  const workerId = String(b.workerId || '').trim();
  if (!workerId) return res.status(400).json({ error: 'workerId is required' });
  const parsed = dbLayer.parseProxyLine(b.proxy);
  if (!parsed) return res.status(400).json({ error: 'unparseable proxy — use ip:port, ip:port:user:pass, user:pass@ip:port or socks5://...' });
  const tx = dbLayer.db.transaction(async () => {
    await dbLayer.q.ensureWorker.run(workerId);
    await dbLayer.q.upsertManualProxy.run(workerId, parsed.host, parsed.port, parsed.username, parsed.password, parsed.type);
  });
  await tx();
  res.json({
    ok: true,
    proxy: { host: parsed.host, port: parsed.port, username: parsed.username, type: parsed.type },
  });
}));

// --- referral (worker, Bearer) ---------------------------------------
app.get('/api/referral/me', requireUser, asyncHandler(async (req, res) => {
  const config = await dbLayer.getConfigObject();
  const [refs, earn] = await Promise.all([
    dbLayer.q.countReferrals.get(req.user.id),
    dbLayer.q.userReferralEarnings.get(req.user.id),
  ]);
  res.json({
    code: req.user.referral_code,
    link: `https://pbx-automation-backend.vercel.app/?ref=${req.user.referral_code}`,
    referrals: refs.n,
    earnings: earn.n,
    referral_enabled: config.referral_enabled === 1 ? 1 : 0,
  });
}));

// --- earning options -------------------------------------------------
// One path, two roles: a valid X-Admin-Token gets the admin view (all
// options + submission_count); otherwise a Bearer user token gets the
// worker view (active options only).
app.get('/api/earning-options', asyncHandler(async (req, res) => {
  const adminToken = req.get('X-Admin-Token') || '';
  if (ADMIN_TOKEN && adminToken === ADMIN_TOKEN) {
    const rows = await dbLayer.q.listEarningOptions.all();
    const out = [];
    for (const r of rows) {
      const c = await dbLayer.q.countOptionSubmissions.get(r.id);
      out.push({ ...rowEarningOption(r), submission_count: c.n });
    }
    return res.json(out);
  }
  const h = req.get('Authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/);
  if (!m) return res.status(401).json({ error: 'missing bearer token or admin token' });
  const tok = await dbLayer.q.getAuthToken.get(m[1].trim());
  if (!tok) return res.status(401).json({ error: 'invalid token' });
  res.json((await dbLayer.q.listActiveEarningOptions.all()).map(rowEarningOption));
}));

app.post('/api/earning-options/:id/submit', requireUser, asyncHandler(async (req, res) => {
  const opt = await dbLayer.q.getEarningOption.get(req.params.id);
  if (!opt) return res.status(404).json({ error: 'earning option not found' });
  if (!opt.is_active) return res.status(400).json({ error: 'earning option is not active' });
  const b = req.body || {};
  const payload = (b.payload && typeof b.payload === 'object') ? b.payload : {};
  if (opt.kind === 'video_upload') {
    if (!payload.video_url || !isValidUrl(String(payload.video_url))) {
      return res.status(400).json({ error: 'payload.video_url must be a valid http(s) URL' });
    }
  }
  const info = await dbLayer.q.insertSubmission.run(req.user.id, opt.id, JSON.stringify(payload));
  const sub = await dbLayer.q.getSubmission.get(info.lastInsertRowid);
  res.status(201).json({ submission: { id: sub.id, status: sub.status } });
}));

app.post('/api/earning-options', requireAdmin, asyncHandler(async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const kind = String(b.kind || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (!kind) return res.status(400).json({ error: 'kind is required' });
  let reward = b.reward !== undefined ? Number(b.reward) : 1;
  if (!Number.isInteger(reward) || reward < 0) return res.status(400).json({ error: 'reward must be a non-negative integer' });
  const configText = b.config !== undefined
    ? (typeof b.config === 'string' ? b.config : JSON.stringify(b.config)) : '{}';
  try { JSON.parse(configText); } catch { return res.status(400).json({ error: 'config must be valid JSON' }); }
  const info = await dbLayer.q.insertEarningOption.run(name, kind, String(b.description || ''), reward, configText);
  res.status(201).json(rowEarningOption(await dbLayer.q.getEarningOption.get(info.lastInsertRowid)));
}));

app.put('/api/earning-options/:id', requireAdmin, asyncHandler(async (req, res) => {
  const opt = await dbLayer.q.getEarningOption.get(req.params.id);
  if (!opt) return res.status(404).json({ error: 'earning option not found' });
  const b = req.body || {};
  const name = b.name !== undefined ? String(b.name).trim() : opt.name;
  const kind = b.kind !== undefined ? String(b.kind).trim() : opt.kind;
  if (!name || !kind) return res.status(400).json({ error: 'name and kind are required' });
  let reward = opt.reward;
  if (b.reward !== undefined) {
    reward = Number(b.reward);
    if (!Number.isInteger(reward) || reward < 0) return res.status(400).json({ error: 'reward must be a non-negative integer' });
  }
  let configText = opt.config;
  if (b.config !== undefined) {
    configText = typeof b.config === 'string' ? b.config : JSON.stringify(b.config);
    try { JSON.parse(configText); } catch { return res.status(400).json({ error: 'config must be valid JSON' }); }
  }
  const is_active = b.is_active !== undefined ? (b.is_active ? 1 : 0) : opt.is_active;
  await dbLayer.q.updateEarningOption.run(
    name, kind, b.description !== undefined ? String(b.description) : opt.description,
    reward, configText, is_active, opt.id
  );
  res.json(rowEarningOption(await dbLayer.q.getEarningOption.get(opt.id)));
}));

app.delete('/api/earning-options/:id', requireAdmin, asyncHandler(async (req, res) => {
  const opt = await dbLayer.q.getEarningOption.get(req.params.id);
  if (!opt) return res.status(404).json({ error: 'earning option not found' });
  const tx = dbLayer.db.transaction(async () => {
    await dbLayer.q.deleteOptionSubmissions.run(opt.id);
    await dbLayer.q.deleteEarningOption.run(opt.id);
  });
  await tx();
  res.json({ ok: true, deleted: opt.id });
}));

app.get('/api/admin/earning-submissions', requireAdmin, asyncHandler(async (req, res) => {
  const status = String(req.query.status || '').trim();
  const rows = status
    ? await dbLayer.q.listSubmissionsByStatus.all(status)
    : await dbLayer.q.listAllSubmissions.all();
  res.json(rows.map(rowSubmission));
}));

app.post('/api/admin/earning-submissions/:id/approve', requireAdmin, asyncHandler(async (req, res) => {
  const sub = await dbLayer.q.getSubmission.get(req.params.id);
  if (!sub) return res.status(404).json({ error: 'submission not found' });
  if (sub.status !== 'pending') return res.status(409).json({ error: 'submission is not pending' });
  const opt = await dbLayer.q.getEarningOption.get(sub.option_id);
  if (!opt) return res.status(409).json({ error: 'earning option no longer exists' });
  const tx = dbLayer.db.transaction(async () => {
    const info = await dbLayer.q.decideSubmission.run('approved', sub.id);
    if (info.changes === 0) throw new Error('not-pending');
    await dbLayer.q.insertLedger.run(sub.user_id, 'earning', opt.reward, sub.id, `earning:${sub.option_id}`);
  });
  try {
    await tx();
  } catch (err) {
    if (err.message === 'not-pending') return res.status(409).json({ error: 'submission is not pending' });
    throw err;
  }
  res.json(rowSubmission(await dbLayer.q.getSubmissionDetail.get(sub.id)));
}));

app.post('/api/admin/earning-submissions/:id/reject', requireAdmin, asyncHandler(async (req, res) => {
  const sub = await dbLayer.q.getSubmission.get(req.params.id);
  if (!sub) return res.status(404).json({ error: 'submission not found' });
  if (sub.status !== 'pending') return res.status(409).json({ error: 'submission is not pending' });
  const info = await dbLayer.q.decideSubmission.run('rejected', sub.id);
  if (info.changes === 0) return res.status(409).json({ error: 'submission is not pending' });
  res.json(rowSubmission(await dbLayer.q.getSubmissionDetail.get(sub.id)));
}));

// --- announcements (polish) ------------------------------------------
// One path, two roles (same pattern as /api/earning-options): a valid
// X-Admin-Token gets ALL announcements; otherwise a Bearer user token
// gets the active ones only (the APK feed/banner + polling loop).
app.get('/api/announcements', asyncHandler(async (req, res) => {
  const adminToken = req.get('X-Admin-Token') || '';
  if (ADMIN_TOKEN && adminToken === ADMIN_TOKEN) {
    return res.json((await dbLayer.q.listAnnouncements.all()).map(rowAnnouncement));
  }
  const h = req.get('Authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/);
  if (!m) return res.status(401).json({ error: 'missing bearer token or admin token' });
  const tok = await dbLayer.q.getAuthToken.get(m[1].trim());
  if (!tok) return res.status(401).json({ error: 'invalid token' });
  res.json((await dbLayer.q.listActiveAnnouncements.all()).map(rowAnnouncement));
}));

app.post('/api/announcements', requireAdmin, asyncHandler(async (req, res) => {
  const b = req.body || {};
  const title = String(b.title || '').trim();
  if (!title) return res.status(400).json({ error: 'title is required' });
  const info = await dbLayer.q.insertAnnouncement.run(title, String(b.body || ''));
  res.status(201).json(rowAnnouncement(await dbLayer.q.getAnnouncement.get(info.lastInsertRowid)));
}));

app.put('/api/announcements/:id', requireAdmin, asyncHandler(async (req, res) => {
  const a = await dbLayer.q.getAnnouncement.get(req.params.id);
  if (!a) return res.status(404).json({ error: 'announcement not found' });
  const b = req.body || {};
  const title = b.title !== undefined ? String(b.title).trim() : a.title;
  if (!title) return res.status(400).json({ error: 'title is required' });
  const body = b.body !== undefined ? String(b.body) : a.body;
  const is_active = b.is_active !== undefined ? (b.is_active ? 1 : 0) : a.is_active;
  await dbLayer.q.updateAnnouncement.run(title, body, is_active, a.id);
  res.json(rowAnnouncement(await dbLayer.q.getAnnouncement.get(a.id)));
}));

app.delete('/api/announcements/:id', requireAdmin, asyncHandler(async (req, res) => {
  const a = await dbLayer.q.getAnnouncement.get(req.params.id);
  if (!a) return res.status(404).json({ error: 'announcement not found' });
  await dbLayer.q.deleteAnnouncement.run(a.id);
  res.json({ ok: true, deleted: a.id });
}));

// --- withdrawals -----------------------------------------------------
app.post('/api/withdrawals', requireUser, asyncHandler(async (req, res) => {
  const b = req.body || {};
  const amount = Number(b.amount);
  const upi = String(b.upi || '').trim();
  if (!Number.isInteger(amount) || amount <= 0) return res.status(400).json({ error: 'amount must be a positive integer' });
  if (!upi) return res.status(400).json({ error: 'upi is required' });
  const balance = await userBalance(req.user.id);
  if (amount > balance) return res.status(400).json({ error: 'amount exceeds balance' });
  const info = await dbLayer.q.insertWithdrawal.run(req.user.id, amount, upi);
  res.status(201).json({ withdrawal: rowWithdrawal(await dbLayer.q.getWithdrawal.get(info.lastInsertRowid)) });
}));

app.get('/api/withdrawals', requireUser, asyncHandler(async (req, res) => {
  res.json((await dbLayer.q.listUserWithdrawals.all(req.user.id)).map(rowWithdrawal));
}));

app.get('/api/admin/withdrawals', requireAdmin, asyncHandler(async (req, res) => {
  const status = String(req.query.status || '').trim();
  const rows = status
    ? await dbLayer.q.listWithdrawalsByStatus.all(status)
    : await dbLayer.q.listAllWithdrawals.all();
  res.json(rows.map(rowWithdrawal));
}));

app.post('/api/admin/withdrawals/:id/approve', requireAdmin, asyncHandler(async (req, res) => {
  const w = await dbLayer.q.getWithdrawal.get(req.params.id);
  if (!w) return res.status(404).json({ error: 'withdrawal not found' });
  if (w.status !== 'pending') return res.status(409).json({ error: 'withdrawal is not pending' });
  const tx = dbLayer.db.transaction(async () => {
    const info = await dbLayer.q.decideWithdrawal.run('approved', w.id);
    if (info.changes === 0) throw new Error('not-pending');
    await dbLayer.q.insertLedger.run(w.user_id, 'withdrawal', -w.amount, w.id, `withdrawal:${w.id}`);
  });
  try {
    await tx();
  } catch (err) {
    if (err.message === 'not-pending') return res.status(409).json({ error: 'withdrawal is not pending' });
    throw err;
  }
  res.json(rowWithdrawal(await dbLayer.q.getWithdrawalDetail.get(w.id)));
}));

app.post('/api/admin/withdrawals/:id/reject', requireAdmin, asyncHandler(async (req, res) => {
  const w = await dbLayer.q.getWithdrawal.get(req.params.id);
  if (!w) return res.status(404).json({ error: 'withdrawal not found' });
  if (w.status !== 'pending') return res.status(409).json({ error: 'withdrawal is not pending' });
  const info = await dbLayer.q.decideWithdrawal.run('rejected', w.id);
  if (info.changes === 0) return res.status(409).json({ error: 'withdrawal is not pending' });
  res.json(rowWithdrawal(await dbLayer.q.getWithdrawalDetail.get(w.id)));
}));

// --- users (admin) + admin stats -------------------------------------
app.get('/api/users', requireAdmin, asyncHandler(async (req, res) => {
  const rows = await dbLayer.q.listUsers.all();
  const out = [];
  for (const u of rows) {
    const [bal, tc, rc] = await Promise.all([
      userBalance(u.id),
      dbLayer.q.countUserCompletions.get(u.id),
      dbLayer.q.countReferrals.get(u.id),
    ]);
    out.push({
      id: u.id, name: u.name, email: u.email, mobile: u.mobile,
      referral_code: u.referral_code, referred_by: u.referred_by,
      balance: bal, tasks_completed: tc.n, referrals_count: rc.n,
      created_at: u.created_at,
    });
  }
  res.json(out);
}));

app.get('/api/users/:id', requireAdmin, asyncHandler(async (req, res) => {
  const u = await dbLayer.q.getUserById.get(req.params.id);
  if (!u) return res.status(404).json({ error: 'user not found' });
  const [bal, ledger, completions] = await Promise.all([
    userBalance(u.id),
    dbLayer.q.userLedger.all(u.id),
    dbLayer.q.listUserCompletions.all(u.id),
  ]);
  res.json({ ...publicUser(u), referred_by: u.referred_by, balance: bal, ledger, completions });
}));

// Delete a user (admin): removes the user and all of their dependent rows
// (tokens, ledger, completions, withdrawals, submissions, assignments).
// Users they referred keep their accounts with referred_by cleared.
// Added to remove test / fake accounts (no contract endpoint covers it).
app.delete('/api/users/:id', requireAdmin, asyncHandler(async (req, res) => {
  const u = await dbLayer.q.getUserById.get(req.params.id);
  if (!u) return res.status(404).json({ error: 'user not found' });
  await dbLayer.db.transaction(async () => {
    await dbLayer.q.deleteUserTokens.run(req.params.id);
    await dbLayer.q.deleteUserLedger.run(req.params.id);
    await dbLayer.q.deleteUserCompletions.run(req.params.id);
    await dbLayer.q.deleteUserWithdrawals.run(req.params.id);
    await dbLayer.q.deleteUserSubmissions.run(req.params.id);
    await dbLayer.q.deleteUserAssignments.run(req.params.id);
    await dbLayer.q.clearReferredBy.run(req.params.id);
    await dbLayer.q.deleteUser.run(req.params.id);
  })();
  res.json({ ok: true, deleted: Number(req.params.id) });
}));

app.get('/api/admin/stats', requireAdmin, asyncHandler(async (req, res) => {
  const today = todayUtc();
  const [users, workers, completionsToday, distinctTasksToday, earningsToday, pendingW, pendingS, recent, pendingWithdrawals] = await Promise.all([
    dbLayer.q.countUsers.get(),
    dbLayer.q.listWorkers.all(),
    dbLayer.q.countCompletionsToday.get(today),
    dbLayer.q.countDistinctTasksToday.get(today),
    dbLayer.q.sumLedgerCreditsToday.get(today),
    dbLayer.q.countPendingWithdrawals.get(),
    dbLayer.q.countPendingSubmissions.get(),
    dbLayer.q.recentCompletions.all(),
    dbLayer.q.listPendingWithdrawals.all(),
  ]);
  const per_worker = [];
  for (const w of workers) {
    const [tt, total, earn] = await Promise.all([
      dbLayer.q.countWorkerCompletionsToday.get(w.id, today),
      dbLayer.q.countWorkerCompletions.get(w.id),
      dbLayer.q.sumWorkerEarningsToday.get(w.id, today),
    ]);
    per_worker.push({
      worker_id: w.id, display_name: w.display_name || '',
      tasks_today: tt.n, total_completed: total.n, earnings: earn.n,
    });
  }
  res.json({
    totals: {
      users: users.n,
      workers: workers.length,
      tasks_today: distinctTasksToday.n,
      completions_today: completionsToday.n,
      earnings_today: earningsToday.n,
      pending_withdrawals: pendingW.n,
      pending_submissions: pendingS.n,
    },
    per_worker,
    recent_completions: recent.map((r) => ({
      id: r.id, user_name: r.user_name, task_name: r.task_name,
      reward: r.reward, created_at: r.created_at,
    })),
    withdrawals_pending: pendingWithdrawals.map((r) => ({
      id: r.id, user_name: r.user_name, amount: r.amount,
      upi: r.upi, created_at: r.created_at,
    })),
  });
}));

// Daily trend for the admin dashboard charts (polish): last N days
// (default 7, 1–30), oldest first, days with no activity filled with
// zeros. completions = task_completions that day; earnings = ledger
// credits (task/referral/earning) that day.
app.get('/api/admin/trends', requireAdmin, asyncHandler(async (req, res) => {
  let days = parseInt(req.query.days, 10);
  if (Number.isNaN(days)) days = 7;
  days = Math.min(Math.max(days, 1), 30);
  const today = new Date(todayUtc() + 'T00:00:00Z');
  const dates = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400000);
    dates.push(d.toISOString().slice(0, 10));
  }
  const start = dates[0];
  const [comp, earn] = await Promise.all([
    dbLayer.q.completionsByDay.all(start),
    dbLayer.q.earningsByDay.all(start),
  ]);
  const compByDay = new Map(comp.map((r) => [r.day, r.n]));
  const earnByDay = new Map(earn.map((r) => [r.day, r.n]));
  res.json(dates.map((date) => ({
    date,
    completions: compByDay.get(date) || 0,
    earnings: earnByDay.get(date) || 0,
  })));
}));

// --- root status -----------------------------------------------------
// A plain status page for the deployment root. Without an explicit
// handler Vercel's rewrite of "/" to the serverless function failed
// with FUNCTION_INVOCATION_FAILED instead of reaching the 404 handler.
app.get('/', (req, res) =>
  res.json({
    ok: true,
    service: 'pbx-automation-backend',
    version: '2.0.0',
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

// Vercel also loads this file directly as the "/" serverless function
// (a root server.js becomes the /index function), and its runtime
// requires the default export to be a function or server. The Express
// app IS a function, so export it directly and attach the named
// helpers as properties: api/index.js destructures { app }, the
// Electron admin app uses .startServer, and local `node server.js`
// still starts via the require.main branch above.
module.exports = app;
module.exports.app = app;
module.exports.startServer = startServer;
