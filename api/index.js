'use strict';
/**
 * api/index.js — Vercel Serverless entrypoint.
 *
 * Exports the Express app from ../server. Requiring ../server does NOT
 * start a listener (server.js only listens when run as main, or when
 * startServer() is explicitly called), so this module is safe to load
 * inside a serverless function. DB schema + default config are kicked
 * off here, mirroring startServer()'s embedded path; Postgres queries
 * await readiness internally, so a first request that arrives during
 * init simply waits for it instead of failing.
 *
 * Env vars on Vercel (project Settings → Environment Variables):
 *   DATABASE_URL — hosted Postgres connection string (Neon free tier:
 *     use the pooled connection string). Required on Vercel: without
 *     it the app falls back to a local SQLite file, which does not
 *     persist between serverless invocations.
 *   ADMIN_TOKEN  — admin API token (X-Admin-Token header).
 */
const dbLayer = require('../db');
const { app } = require('../server');

// Mirror startServer()'s embedded path: schema + default config.
// Fire-and-forget — Postgres query methods await readiness internally.
dbLayer.init();
dbLayer.seedDefaultConfigIfEmpty().catch((err) =>
  console.error('[server] failed to seed default config:', err)
);

module.exports = app;
