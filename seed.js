'use strict';
/**
 * seed.js — seed the DB with clearly-fake example data.
 * Run: npm run seed   (safe to re-run; it wipes the example tables first
 * only when --reset is passed, otherwise it only fills empty tables).
 *
 * All proxies/links here are placeholders in TEST-NET ranges
 * (203.0.113.x) or example domains — never real credentials.
 * Works with both adapters (SQLite default, Postgres via DATABASE_URL).
 */
const dbLayer = require('./db');

async function main() {
  await dbLayer.init();

  const reset = process.argv.includes('--reset');
  if (reset) {
    await dbLayer.db.exec('DELETE FROM worker_proxies; DELETE FROM worker_links; DELETE FROM worker_settings; DELETE FROM proxies; DELETE FROM links; DELETE FROM workers; DELETE FROM config;');
    console.log('[seed] tables cleared (--reset)');
  }

  const EXAMPLE_PROXIES = [
    // TEST-NET documentation IPs — placeholders only, replace with real ones.
    { line: '203.0.113.10:8080:demo-user:demo-pass' },
    { line: 'demo-user2:demo-pass2@203.0.113.20:3128' },
    { line: 'socks5://203.0.113.30:1080' },
    { line: '198.51.100.40:8080' },
  ];

  const EXAMPLE_LINKS = [
    { url: 'https://ouo.io/example-shortlink-1', type: 'shortener' },
    { url: 'https://ouo.io/example-shortlink-2', type: 'shortener' },
    { url: 'https://drive.google.com/example-destination', type: 'view' },
    { url: 'https://example.com/ad-landing', type: 'ad' },
  ];

  const proxyCount = (await dbLayer.q.listProxies.all()).length;
  if (proxyCount === 0) {
    for (const p of EXAMPLE_PROXIES) {
      const parsed = dbLayer.parseProxyLine(p.line);
      if (!parsed) { console.warn('[seed] could not parse proxy line:', p.line); continue; }
      await dbLayer.q.insertProxy.run(parsed.host, parsed.port, parsed.username, parsed.password, parsed.type, '', 1);
    }
    console.log(`[seed] inserted ${EXAMPLE_PROXIES.length} example proxies (fake placeholders)`);
  } else {
    console.log(`[seed] proxies already present (${proxyCount}) — skipping`);
  }

  const linkCount = (await dbLayer.q.listLinks.all()).length;
  if (linkCount === 0) {
    for (const l of EXAMPLE_LINKS) await dbLayer.q.insertLink.run(l.url, l.type);
    console.log(`[seed] inserted ${EXAMPLE_LINKS.length} example links`);
  } else {
    console.log(`[seed] links already present (${linkCount}) — skipping`);
  }

  await dbLayer.seedDefaultConfigIfEmpty();
  console.log('[seed] config:', JSON.stringify(await dbLayer.getConfigObject()));
  console.log('[seed] done. DB at', dbLayer.dbPath);
}

main().catch((err) => {
  console.error('[seed] failed:', err);
  process.exit(1);
});
