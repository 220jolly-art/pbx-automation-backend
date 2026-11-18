'use strict';
/**
 * db.js — small database layer, two adapters behind one interface.
 *
 * Default: SQLite via better-sqlite3, file at DATABASE_PATH (./data.db).
 * Hosting: if DATABASE_URL is set, the backend uses Postgres via `pg`
 * (node-postgres Pool, SSL on as Render requires). The schema ports 1:1
 * (same table and column names). The rest of the app (server.js, seed.js)
 * only calls the functions exported here, so the switch is contained in
 * this one file. This is deliberately a thin abstraction — no ORM.
 *
 * Interface contract (identical in both modes):
 *   - `q.<name>.all(...params)` -> Promise<rows[]>
 *   - `q.<name>.get(...params)` -> Promise<row | undefined>
 *   - `q.<name>.run(...params)` -> Promise<{ changes, lastInsertRowid }>
 *   - `db.transaction(fn)` -> an async function; call it and await the
 *     result: `await db.transaction(async () => { ... })()`. Nested
 *     transactions use savepoints in both modes.
 *   - `db.exec(sql)` -> Promise<void> (multi-statement OK).
 *   - `init()` -> in SQLite mode it is sync; in Postgres mode it returns
 *     a promise that resolves once the schema exists. Safe to call
 *     repeatedly (idempotent). Query methods await readiness internally,
 *     so a first query before init() finishes just waits.
 *   - `getConfigObject`, `setConfigObject`, `seedDefaultConfigIfEmpty`,
 *     `getWorkerAssignments`, `setWorkerAssignments`, `setWorkerSettings`,
 *     `getMergedConfigForWorker` are all async in both modes.
 *
 * Postgres dialect notes:
 *   - SQL is written once in SQLite flavour (`?` placeholders,
 *     `datetime('now')`, `INSERT OR IGNORE`) and converted for `pg`
 *     (`$1..$n`, `to_char(NOW() AT TIME ZONE 'UTC', ...)`,
 *     `ON CONFLICT DO NOTHING`). `?` must therefore never appear inside
 *     a string literal in the SQL below. The few queries that differ
 *     beyond that (COUNT(*) casts — `pg` returns int8 as a string, so
 *     they are cast to int) carry an explicit `pg:` override.
 *   - Date columns stay TEXT in Postgres, formatted exactly like
 *     SQLite's datetime('now') ("YYYY-MM-DD HH:MM:SS", UTC), so API
 *     response shapes are byte-identical between adapters.
 *   - Boolean-ish columns stay INTEGER 0/1 in Postgres too, so no
 *     mapping is needed at the boundary.
 *   - `INTEGER PRIMARY KEY AUTOINCREMENT` -> `INTEGER GENERATED ALWAYS
 *     AS IDENTITY PRIMARY KEY`; `excluded.*` upserts work identically.
 *
 * Concurrency notes:
 *   - Postgres: transactions check a `pg` client out of the pool and
 *     carry it through the async call chain with AsyncLocalStorage, so
 *     concurrent requests cannot see each other's transaction.
 *   - SQLite: better-sqlite3 is a single synchronous connection. Every
 *     statement runs under a small promise mutex, and transactions hold
 *     that mutex for their whole duration (BEGIN IMMEDIATE ... COMMIT),
 *     so no other request's statement can interleave into an open
 *     transaction. Statements inside a transaction skip the mutex
 *     (AsyncLocalStorage marks the transaction) to avoid deadlock.
 */
const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');

const DATABASE_URL = process.env.DATABASE_URL || '';
const DATABASE_PATH = process.env.DATABASE_PATH || './data.db';
const USE_PG = !!DATABASE_URL;

const als = new AsyncLocalStorage();

/* ------------------------------------------------------------------ */
/* Adapter setup                                                       */
/* ------------------------------------------------------------------ */

let pgPool = null;
let sqliteDb = null;
let dbPath = '';

if (USE_PG) {
  const { Pool } = require('pg');
  pgPool = new Pool({
    connectionString: DATABASE_URL,
    // Render Postgres requires SSL; the cert is not in the local trust
    // store, so verification is off (same as Render's own examples).
    ssl: { rejectUnauthorized: false },
    max: 10,
  });
  pgPool.on('error', (err) => console.error('[db] idle pg client error:', err.message));
  dbPath = 'postgres (DATABASE_URL)';
} else {
  let Database;
  try {
    Database = require('better-sqlite3');
  } catch (err) {
    console.error('[db] better-sqlite3 failed to load:', err.message);
    console.error('[db] Run `npm install` again, or fall back to the JSON-file store (see README.md).');
    process.exit(1);
  }
  dbPath = path.resolve(__dirname, DATABASE_PATH);
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
  sqliteDb = new Database(dbPath);
  sqliteDb.pragma('journal_mode = WAL');
  sqliteDb.pragma('foreign_keys = ON');
}

/* ------------------------------------------------------------------ */
/* SQL dialect conversion (SQLite flavour -> Postgres)                 */
/* ------------------------------------------------------------------ */

function toPgParams(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

function sqliteToPg(sql) {
  let out = sql;
  out = out.replace(
    /datetime\('now'\)/g,
    "to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')"
  );
  if (/^\s*INSERT OR IGNORE INTO/i.test(out)) {
    out = out.replace(/INSERT OR IGNORE INTO/i, 'INSERT INTO');
    out = out.trim().replace(/;?\s*$/, '') + ' ON CONFLICT DO NOTHING';
  }
  return toPgParams(out);
}

/* ------------------------------------------------------------------ */
/* Schema + init                                                       */
/* ------------------------------------------------------------------ */

function sqliteInit() {
  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS proxies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host TEXT NOT NULL,
      port INTEGER NOT NULL,
      username TEXT DEFAULT '',
      password TEXT DEFAULT '',
      type TEXT NOT NULL DEFAULT 'http' CHECK (type IN ('http','https','socks5')),
      country TEXT DEFAULT '',
      is_active INTEGER NOT NULL DEFAULT 1,
      added_date TEXT NOT NULL DEFAULT (datetime('now')),
      last_checked TEXT,
      use_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'shortener' CHECK (type IN ('shortener','ad','view')),
      status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','active','done','failed')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      fail_reason TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS workers (
      id TEXT PRIMARY KEY,
      device_info TEXT DEFAULT '',
      completed_count INTEGER NOT NULL DEFAULT 0,
      active_link_id INTEGER,
      last_seen TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (active_link_id) REFERENCES links(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Worker management (admin): per-worker assignments + settings.
    -- worker_proxies / worker_links: which proxies/links a worker may use.
    --   Empty assignment = no restriction (falls back to the global pool).
    -- worker_settings: per-worker overrides of the global config
    --   (tabs_count, cycle_timeout_seconds); NULL = use the global value.
    CREATE TABLE IF NOT EXISTS worker_proxies (
      worker_id TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
      proxy_id INTEGER NOT NULL REFERENCES proxies(id) ON DELETE CASCADE,
      PRIMARY KEY (worker_id, proxy_id)
    );

    CREATE TABLE IF NOT EXISTS worker_links (
      worker_id TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
      link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
      PRIMARY KEY (worker_id, link_id)
    );

    CREATE TABLE IF NOT EXISTS worker_settings (
      worker_id TEXT PRIMARY KEY REFERENCES workers(id) ON DELETE CASCADE,
      tabs_count INTEGER,
      cycle_timeout_seconds INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_links_status ON links(status);
    CREATE INDEX IF NOT EXISTS idx_proxies_active ON proxies(is_active);
  `);

  // Migration: workers gained display_name / enabled after the first
  // release. Older data.db files get the columns added on startup.
  const workerCols = sqliteDb.prepare('PRAGMA table_info(workers)').all().map((c) => c.name);
  if (!workerCols.includes('display_name')) {
    sqliteDb.exec("ALTER TABLE workers ADD COLUMN display_name TEXT NOT NULL DEFAULT ''");
  }
  if (!workerCols.includes('enabled')) {
    sqliteDb.exec('ALTER TABLE workers ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1');
  }
}

async function pgInit() {
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS proxies (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      host TEXT NOT NULL,
      port INTEGER NOT NULL,
      username TEXT DEFAULT '',
      password TEXT DEFAULT '',
      type TEXT NOT NULL DEFAULT 'http' CHECK (type IN ('http','https','socks5')),
      country TEXT DEFAULT '',
      is_active INTEGER NOT NULL DEFAULT 1,
      added_date TEXT NOT NULL DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
      last_checked TEXT,
      use_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS links (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      url TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'shortener' CHECK (type IN ('shortener','ad','view')),
      status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','active','done','failed')),
      created_at TEXT NOT NULL DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
      completed_at TEXT,
      fail_reason TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS workers (
      id TEXT PRIMARY KEY,
      device_info TEXT DEFAULT '',
      completed_count INTEGER NOT NULL DEFAULT 0,
      active_link_id INTEGER,
      last_seen TEXT NOT NULL DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
      display_name TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (active_link_id) REFERENCES links(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS worker_proxies (
      worker_id TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
      proxy_id INTEGER NOT NULL REFERENCES proxies(id) ON DELETE CASCADE,
      PRIMARY KEY (worker_id, proxy_id)
    );

    CREATE TABLE IF NOT EXISTS worker_links (
      worker_id TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
      link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
      PRIMARY KEY (worker_id, link_id)
    );

    CREATE TABLE IF NOT EXISTS worker_settings (
      worker_id TEXT PRIMARY KEY REFERENCES workers(id) ON DELETE CASCADE,
      tabs_count INTEGER,
      cycle_timeout_seconds INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_links_status ON links(status);
    CREATE INDEX IF NOT EXISTS idx_proxies_active ON proxies(is_active);
  `);

  // Migration for databases created before display_name / enabled
  // existed (fresh databases already have them from the DDL above).
  const cols = await pgPool.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'workers'"
  );
  const names = new Set(cols.rows.map((r) => r.column_name));
  if (!names.has('display_name')) {
    await pgPool.query("ALTER TABLE workers ADD COLUMN display_name TEXT NOT NULL DEFAULT ''");
  }
  if (!names.has('enabled')) {
    await pgPool.query('ALTER TABLE workers ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1');
  }
}

let initPromise = null;
function init() {
  if (USE_PG) {
    if (!initPromise) {
      initPromise = pgInit();
      // Log the failure; awaiting initPromise elsewhere still throws,
      // so this only prevents an unhandled-rejection crash.
      initPromise.catch((err) => console.error('[db] Postgres init failed:', err.message));
    }
    return initPromise;
  }
  sqliteInit();
  return undefined;
}

async function ensureReady() {
  if (USE_PG) await init();
}

// SQLite: schema must exist before statements are prepared (the
// better-sqlite3 statements below are prepared eagerly at require
// time), so init() runs here at load. server.js / seed.js calling
// init() again is a harmless no-op. Postgres statements are not
// prepared — ensureReady() (called by every query) creates the schema
// on first use instead.
if (!USE_PG) init();

/* ------------------------------------------------------------------ */
/* Proxy helpers                                                       */
/* ------------------------------------------------------------------ */

/**
 * Parse one proxy line. Accepted formats (same as combined/proxy_pool.txt):
 *   ip:port:user:pass
 *   user:pass@ip:port
 *   ip:port
 *   socks5://user:pass@ip:port
 *   socks5://ip:port
 *   http://... / https://... prefixes also accepted.
 *   Comma or tab separated values also work.
 * Returns {host, port, username, password, type} or null if unparseable.
 */
function parseProxyLine(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let line = raw.trim();
  if (!line || line.startsWith('#')) return null;
  // Comma/tab separated -> split into parts
  const parts = line.split(/[,\t]+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 4) {
    // ip, port, user, pass
    const port = parseInt(parts[1], 10);
    if (!parts[0] || Number.isNaN(port)) return null;
    return { host: parts[0], port, username: parts[2] || '', password: parts[3] || '', type: 'http' };
  }
  if (parts.length === 2 && !parts[0].includes('@') && !parts[1].includes(':')) {
    // "ip, port" two-part form
    const port = parseInt(parts[1], 10);
    if (Number.isNaN(port)) return null;
    return { host: parts[0], port, username: '', password: '', type: 'http' };
  }
  line = parts[0];

  let type = 'http';
  const scheme = line.match(/^(socks5|https?|socks):\/\//i);
  if (scheme) {
    const s = scheme[1].toLowerCase();
    type = s === 'socks' || s === 'socks5' ? 'socks5' : s;
    line = line.slice(scheme[0].length);
  }

  // user:pass@ip:port
  let auth = '';
  const atIdx = line.lastIndexOf('@');
  if (atIdx !== -1) {
    auth = line.slice(0, atIdx);
    line = line.slice(atIdx + 1);
    const colon = auth.indexOf(':');
    if (colon === -1) return null;
    const username = auth.slice(0, colon);
    const password = auth.slice(colon + 1);
    const hp = parseHostPort(line);
    if (!hp) return null;
    return { host: hp.host, port: hp.port, username, password, type };
  }

  // ip:port:user:pass
  const colonParts = line.split(':');
  if (colonParts.length === 4) {
    const port = parseInt(colonParts[1], 10);
    if (Number.isNaN(port)) return null;
    return { host: colonParts[0], port, username: colonParts[2], password: colonParts[3], type };
  }
  if (colonParts.length === 2) {
    const hp = parseHostPort(line);
    if (!hp) return null;
    return { host: hp.host, port: hp.port, username: '', password: '', type };
  }
  return null;
}

function parseHostPort(s) {
  const idx = s.lastIndexOf(':');
  if (idx === -1) return null;
  const port = parseInt(s.slice(idx + 1), 10);
  const host = s.slice(0, idx);
  if (!host || Number.isNaN(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

// Serialize all SQLite access through one promise chain so a statement
// can never land inside another request's open transaction (see the
// header note). Statements running inside a transaction skip the mutex
// — the transaction already holds it (checked via AsyncLocalStorage).
let mutexTail = Promise.resolve();
function withMutex(fn) {
  const task = mutexTail.then(() => fn());
  mutexTail = task.catch(() => {});
  return task;
}

async function pgExec(pgSql, params) {
  await ensureReady();
  const store = als.getStore();
  const executor = store && store.kind === 'pg' ? store.client : pgPool;
  return executor.query(pgSql, params);
}

function sqliteExec(fn) {
  const store = als.getStore();
  if (store && store.kind === 'sqlite-tx') return Promise.resolve().then(fn);
  return withMutex(fn);
}

// One query definition: SQLite-flavoured SQL plus, only where the
// dialects differ beyond the mechanical conversion, an explicit `pg:`
// override (also written with `?` placeholders). `returningId` appends
// `RETURNING id` to INSERTs in Postgres mode so `.run()` can report
// lastInsertRowid like better-sqlite3 does.
function defineQuery(sqliteSql, opts = {}) {
  const pgSql = opts.pg ? toPgParams(opts.pg) : sqliteToPg(sqliteSql);
  if (USE_PG) {
    return {
      all: async (...params) => (await pgExec(pgSql, params)).rows,
      get: async (...params) => (await pgExec(pgSql, params)).rows[0],
      run: async (...params) => {
        const sql = opts.returningId ? `${pgSql} RETURNING id` : pgSql;
        const res = await pgExec(sql, params);
        return {
          changes: res.rowCount,
          lastInsertRowid: res.rows && res.rows[0] ? res.rows[0].id : undefined,
        };
      },
    };
  }
  const stmt = sqliteDb.prepare(sqliteSql);
  return {
    all: (...params) => sqliteExec(() => stmt.all(...params)),
    get: (...params) => sqliteExec(() => stmt.get(...params)),
    run: (...params) => sqliteExec(() => {
      const info = stmt.run(...params);
      return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
    }),
  };
}

const q = {
  // proxies
  listProxies: defineQuery('SELECT * FROM proxies ORDER BY id DESC'),
  getProxy: defineQuery('SELECT * FROM proxies WHERE id = ?'),
  insertProxy: defineQuery(
    `INSERT INTO proxies (host, port, username, password, type, country, is_active, added_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    { returningId: true }
  ),
  updateProxy: defineQuery(
    `UPDATE proxies SET host = ?, port = ?, username = ?, password = ?, type = ?,
       country = ?, is_active = ?, last_checked = ? WHERE id = ?`
  ),
  deleteProxy: defineQuery('DELETE FROM proxies WHERE id = ?'),
  countProxies: defineQuery('SELECT COUNT(*) AS n FROM proxies WHERE is_active = 1', {
    pg: 'SELECT COUNT(*)::int AS n FROM proxies WHERE is_active = 1',
  }),
  // round-robin: least-used active proxy first
  nextProxy: defineQuery(
    'SELECT * FROM proxies WHERE is_active = 1 ORDER BY use_count ASC, id ASC LIMIT 1'
  ),
  bumpProxyUse: defineQuery('UPDATE proxies SET use_count = use_count + 1 WHERE id = ?'),
  touchProxyChecked: defineQuery("UPDATE proxies SET last_checked = datetime('now') WHERE id = ?"),

  // links
  listLinks: defineQuery('SELECT * FROM links ORDER BY id DESC'),
  getLink: defineQuery('SELECT * FROM links WHERE id = ?'),
  insertLink: defineQuery(
    "INSERT INTO links (url, type, status) VALUES (?, ?, 'queued')",
    { returningId: true }
  ),
  updateLinkStatus: defineQuery('UPDATE links SET status = ? WHERE id = ?'),
  deleteLink: defineQuery('DELETE FROM links WHERE id = ?'),
  nextQueuedLink: defineQuery(
    "SELECT * FROM links WHERE status = 'queued' ORDER BY id ASC LIMIT 1"
  ),
  markLinkActive: defineQuery("UPDATE links SET status = 'active' WHERE id = ?"),
  markLinkDone: defineQuery(
    "UPDATE links SET status = 'done', completed_at = datetime('now') WHERE id = ?"
  ),
  markLinkFailed: defineQuery(
    "UPDATE links SET status = 'failed', fail_reason = ? WHERE id = ?"
  ),
  countLinksByStatus: defineQuery(
    'SELECT status, COUNT(*) AS n FROM links GROUP BY status',
    { pg: 'SELECT status, COUNT(*)::int AS n FROM links GROUP BY status' }
  ),

  // workers
  listWorkers: defineQuery('SELECT * FROM workers ORDER BY last_seen DESC'),
  getWorker: defineQuery('SELECT * FROM workers WHERE id = ?'),
  upsertWorker: defineQuery(
    `INSERT INTO workers (id, device_info, last_seen) VALUES (?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET device_info = excluded.device_info,
       last_seen = datetime('now')`
  ),
  touchWorker: defineQuery("UPDATE workers SET last_seen = datetime('now') WHERE id = ?"),
  setWorkerActive: defineQuery('UPDATE workers SET active_link_id = ?, last_seen = datetime(\'now\') WHERE id = ?'),
  clearWorkerActive: defineQuery('UPDATE workers SET active_link_id = NULL, last_seen = datetime(\'now\') WHERE id = ?'),
  incrementWorkerCompleted: defineQuery(
    'UPDATE workers SET completed_count = completed_count + 1, active_link_id = NULL, last_seen = datetime(\'now\') WHERE id = ?'
  ),
  totalCompleted: defineQuery('SELECT COALESCE(SUM(completed_count), 0) AS n FROM workers', {
    pg: 'SELECT COALESCE(SUM(completed_count), 0)::int AS n FROM workers',
  }),
  updateWorker: defineQuery(
    'UPDATE workers SET display_name = ?, enabled = ? WHERE id = ?'
  ),
  deleteWorker: defineQuery('DELETE FROM workers WHERE id = ?'),

  // worker assignments + per-worker settings
  listWorkerProxyIds: defineQuery('SELECT proxy_id FROM worker_proxies WHERE worker_id = ? ORDER BY proxy_id ASC'),
  listWorkerLinkIds: defineQuery('SELECT link_id FROM worker_links WHERE worker_id = ? ORDER BY link_id ASC'),
  clearWorkerProxies: defineQuery('DELETE FROM worker_proxies WHERE worker_id = ?'),
  insertWorkerProxy: defineQuery('INSERT OR IGNORE INTO worker_proxies (worker_id, proxy_id) VALUES (?, ?)'),
  clearWorkerLinks: defineQuery('DELETE FROM worker_links WHERE worker_id = ?'),
  insertWorkerLink: defineQuery('INSERT OR IGNORE INTO worker_links (worker_id, link_id) VALUES (?, ?)'),
  getWorkerSettings: defineQuery('SELECT * FROM worker_settings WHERE worker_id = ?'),
  upsertWorkerSettings: defineQuery(
    `INSERT INTO worker_settings (worker_id, tabs_count, cycle_timeout_seconds)
     VALUES (?, ?, ?)
     ON CONFLICT(worker_id) DO UPDATE SET tabs_count = excluded.tabs_count,
       cycle_timeout_seconds = excluded.cycle_timeout_seconds`
  ),
  deleteWorkerSettings: defineQuery('DELETE FROM worker_settings WHERE worker_id = ?'),
  // assignment-aware queue picks (least-used assigned proxy; oldest assigned queued link)
  nextAssignedProxy: defineQuery(
    `SELECT p.* FROM proxies p
     JOIN worker_proxies wp ON wp.proxy_id = p.id
     WHERE wp.worker_id = ? AND p.is_active = 1
     ORDER BY p.use_count ASC, p.id ASC LIMIT 1`
  ),
  nextAssignedLink: defineQuery(
    `SELECT l.* FROM links l
     JOIN worker_links wl ON wl.link_id = l.id
     WHERE wl.worker_id = ? AND l.status = 'queued'
     ORDER BY l.id ASC LIMIT 1`
  ),
  // worker-facing bulk queue / proxy pool (APK sync): queued links and
  // active proxies, assignment-aware. These do NOT change link/proxy state.
  queuedLinks: defineQuery(
    "SELECT * FROM links WHERE status = 'queued' ORDER BY id ASC LIMIT ?"
  ),
  assignedQueuedLinks: defineQuery(
    `SELECT l.* FROM links l
     JOIN worker_links wl ON wl.link_id = l.id
     WHERE wl.worker_id = ? AND l.status = 'queued'
     ORDER BY l.id ASC LIMIT ?`
  ),
  activeProxies: defineQuery(
    'SELECT * FROM proxies WHERE is_active = 1 ORDER BY id ASC'
  ),
  assignedProxies: defineQuery(
    `SELECT p.* FROM proxies p
     JOIN worker_proxies wp ON wp.proxy_id = p.id
     WHERE wp.worker_id = ? AND p.is_active = 1
     ORDER BY p.id ASC`
  ),

  // config
  getConfig: defineQuery('SELECT value FROM config WHERE key = ?'),
  setConfig: defineQuery(
    `INSERT INTO config (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ),
  listConfig: defineQuery('SELECT key, value FROM config'),
};

/* ------------------------------------------------------------------ */
/* Transactions + db facade                                            */
/* ------------------------------------------------------------------ */

// SQLite transaction: BEGIN IMMEDIATE under the mutex, so no other
// request's statement can interleave. Nested calls use SAVEPOINTs
// (same as better-sqlite3's native nested transactions).
function sqliteTransaction(fn) {
  return async (...args) => {
    const store = als.getStore();
    if (store && store.kind === 'sqlite-tx') {
      const sp = `sp_${++store.depth}`;
      sqliteDb.exec(`SAVEPOINT ${sp}`);
      try {
        const out = await fn(...args);
        sqliteDb.exec(`RELEASE ${sp}`);
        return out;
      } catch (err) {
        try { sqliteDb.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`); } catch { /* ignore */ }
        throw err;
      }
    }
    return withMutex(async () => {
      sqliteDb.exec('BEGIN IMMEDIATE');
      try {
        const out = await als.run({ kind: 'sqlite-tx', depth: 0 }, () => fn(...args));
        sqliteDb.exec('COMMIT');
        return out;
      } catch (err) {
        try { sqliteDb.exec('ROLLBACK'); } catch { /* ignore */ }
        throw err;
      }
    });
  };
}

// Postgres transaction: a pooled client + BEGIN/COMMIT, carried via
// AsyncLocalStorage so concurrent requests stay isolated. Nested calls
// use SAVEPOINTs.
function pgTransaction(fn) {
  return async (...args) => {
    await ensureReady();
    const store = als.getStore();
    if (store && store.kind === 'pg') {
      const sp = `sp_${++store.depth}`;
      await store.client.query(`SAVEPOINT ${sp}`);
      try {
        const out = await fn(...args);
        await store.client.query(`RELEASE SAVEPOINT ${sp}`);
        return out;
      } catch (err) {
        await store.client.query(`ROLLBACK TO SAVEPOINT ${sp}`).catch(() => {});
        await store.client.query(`RELEASE SAVEPOINT ${sp}`).catch(() => {});
        throw err;
      }
    }
    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');
      const out = await als.run({ kind: 'pg', client, depth: 0 }, () => fn(...args));
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  };
}

// `db` exposes only what server.js / seed.js use: transaction() and
// exec(). In SQLite mode it is the better-sqlite3 instance itself
// (transaction overridden with the async wrapper above); in Postgres
// mode it is a small facade over the pool.
let db;
if (USE_PG) {
  db = {
    transaction: pgTransaction,
    exec: async (sql) => {
      await ensureReady();
      await pgPool.query(sql);
    },
  };
} else {
  db = sqliteDb;
  db.transaction = sqliteTransaction;
}

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

const DEFAULT_CONFIG = {
  destination_patterns: ['drive.google.com', 't.me', 'telegram.me'],
  cycle_timeout_seconds: 15,
  tabs_count: 6,
  captcha_solver_key: '',
};

async function getConfigObject() {
  const rows = await q.listConfig.all();
  const out = { ...DEFAULT_CONFIG };
  for (const r of rows) {
    try {
      out[r.key] = JSON.parse(r.value);
    } catch {
      out[r.key] = r.value;
    }
  }
  return out;
}

async function setConfigObject(obj) {
  const tx = db.transaction(async (o) => {
    for (const [key, value] of Object.entries(o)) {
      await q.setConfig.run(key, JSON.stringify(value));
    }
  });
  await tx(obj);
}

async function seedDefaultConfigIfEmpty() {
  const existing = await q.listConfig.all();
  if (existing.length === 0) await setConfigObject(DEFAULT_CONFIG);
}

/* ------------------------------------------------------------------ */
/* Worker assignments + per-worker settings                            */
/* ------------------------------------------------------------------ */

// Full worker detail: assignments + settings, for admin responses.
async function getWorkerAssignments(workerId) {
  const proxyIds = (await q.listWorkerProxyIds.all(workerId)).map((r) => r.proxy_id);
  const linkIds = (await q.listWorkerLinkIds.all(workerId)).map((r) => r.link_id);
  const s = await q.getWorkerSettings.get(workerId);
  return {
    proxy_ids: proxyIds,
    link_ids: linkIds,
    settings: {
      tabs_count: s ? s.tabs_count : null,
      cycle_timeout_seconds: s ? s.cycle_timeout_seconds : null,
    },
  };
}

// Replace a worker's assignments. Only ids that actually exist are kept;
// unknown ids are silently dropped (they cannot be served anyway).
async function setWorkerAssignments(workerId, proxyIds, linkIds) {
  const validProxyIds = [];
  for (const n of (Array.isArray(proxyIds) ? proxyIds : [])) {
    const id = parseInt(n, 10);
    if (!Number.isNaN(id) && (await q.getProxy.get(id))) validProxyIds.push(id);
  }
  const validLinkIds = [];
  for (const n of (Array.isArray(linkIds) ? linkIds : [])) {
    const id = parseInt(n, 10);
    if (!Number.isNaN(id) && (await q.getLink.get(id))) validLinkIds.push(id);
  }
  const tx = db.transaction(async () => {
    await q.clearWorkerProxies.run(workerId);
    await q.clearWorkerLinks.run(workerId);
    for (const pid of validProxyIds) await q.insertWorkerProxy.run(workerId, pid);
    for (const lid of validLinkIds) await q.insertWorkerLink.run(workerId, lid);
  });
  await tx();
  return { proxy_ids: validProxyIds, link_ids: validLinkIds };
}

// Save per-worker settings overrides. null/undefined = use the global
// config value (stored as NULL). Returns the stored settings object.
async function setWorkerSettings(workerId, settings) {
  const tabs = settings && settings.tabs_count !== undefined && settings.tabs_count !== null
    ? Number(settings.tabs_count) : null;
  const cycle = settings && settings.cycle_timeout_seconds !== undefined && settings.cycle_timeout_seconds !== null
    ? Number(settings.cycle_timeout_seconds) : null;
  if (tabs !== null && (Number.isNaN(tabs) || tabs < 1 || tabs > 10)) {
    throw new Error('tabs_count must be 1–10');
  }
  if (cycle !== null && (Number.isNaN(cycle) || cycle < 5 || cycle > 300)) {
    throw new Error('cycle_timeout_seconds must be 5–300');
  }
  if (tabs === null && cycle === null) {
    await q.deleteWorkerSettings.run(workerId);
  } else {
    await q.upsertWorkerSettings.run(workerId, tabs, cycle);
  }
  const s = await q.getWorkerSettings.get(workerId);
  return {
    tabs_count: s ? s.tabs_count : null,
    cycle_timeout_seconds: s ? s.cycle_timeout_seconds : null,
  };
}

// Global config with a worker's overrides applied on top.
async function getMergedConfigForWorker(workerId) {
  const merged = await getConfigObject();
  if (!workerId) return merged;
  const s = await q.getWorkerSettings.get(workerId);
  if (!s) return merged;
  if (s.tabs_count !== null && s.tabs_count !== undefined) merged.tabs_count = s.tabs_count;
  if (s.cycle_timeout_seconds !== null && s.cycle_timeout_seconds !== undefined) {
    merged.cycle_timeout_seconds = s.cycle_timeout_seconds;
  }
  return merged;
}

module.exports = {
  db,
  init,
  q,
  parseProxyLine,
  getConfigObject,
  setConfigObject,
  seedDefaultConfigIfEmpty,
  DEFAULT_CONFIG,
  getWorkerAssignments,
  setWorkerAssignments,
  setWorkerSettings,
  getMergedConfigForWorker,
  dbPath,
};
