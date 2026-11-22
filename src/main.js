import fs from 'node:fs';
import path from 'node:path';
import { createAccount, listAccounts } from './accounts.js';
import { dataDir, PORT, VERSION } from './config.js';
import { closeDb, initDb } from './db.js';
import { openBrowser } from './open.js';
import { DEMO_EMAIL, demoIdentity } from './providers/demo.js';
import { startScheduler, stopScheduler } from './scheduler.js';
import { createApp, listen } from './server.js';
import { getSettings } from './settings.js';

export async function main(argv = []) {
  // A background job that fails must never take the whole app down with it.
  process.on('unhandledRejection', (err) => console.error('[pinger]', err?.message || err));

  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dbFile = path.join(dir, 'pinger.db');
  initDb(dbFile);
  try {
    fs.chmodSync(dbFile, 0o600); // mail and tokens: readable by this user only
  } catch {
    /* not supported on this file system */
  }

  const url = `http://localhost:${PORT}`;
  const app = createApp();
  let server;
  try {
    server = await listen(app, PORT);
  } catch (err) {
    if (err.code !== 'EADDRINUSE') throw err;
    const already = await fetch(`${url}/api/health`)
      .then((r) => r.json())
      .then((j) => j.app === 'pinger')
      .catch(() => false);
    if (already) {
      console.log(`Pinger is already running — opening ${url}`);
      if (!argv.includes('--no-open')) openBrowser(url);
      return;
    }
    console.error(`Port ${PORT} is being used by another program. Start Pinger with PINGER_PORT set to a free port.`);
    process.exitCode = 1;
    return;
  }

  if (argv.includes('--demo') && !listAccounts().some((a) => a.kind === 'demo')) {
    createAccount({
      kind: 'demo',
      email: DEMO_EMAIL,
      name: demoIdentity(getSettings().profile.name).name,
      config: { seedAt: Date.now() },
    });
  }

  startScheduler();
  console.log(`\n  Pinger ${VERSION} is running.\n\n  Open:  ${url}\n  Data:  ${dir}\n\n  Leave this window open to keep getting pings. Press Ctrl+C to stop.\n`);
  if (!argv.includes('--no-open')) openBrowser(url);

  const shutdown = () => {
    stopScheduler();
    server.close(() => {
      closeDb();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
