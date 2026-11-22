// A "ping" is anything Pinger wants to tell the user: an overview, a meeting starting, a nudge.
// Open tabs show it themselves; when no tab can, the operating system's notification centre is used.

import { PORT } from './config.js';
import { all, run } from './db.js';
import { broadcast, someTabCanNotify } from './events.js';
import { openBrowser } from './open.js';
import { nowIso, parseJson, truncate } from './util.js';

let notifierPromise = null;

async function nativeNotify(p) {
  if (process.env.PINGER_NO_NATIVE_NOTIFY) return;
  try {
    notifierPromise ??= import('node-notifier').then((m) => m.default || m);
    const notifier = await notifierPromise;
    notifier.notify(
      { title: p.title, message: p.body || ' ', appID: 'Pinger', wait: true, timeout: 12 },
      (err, response, meta) => {
        const clicked = meta?.activationType === 'contentsClicked' || meta?.activationType === 'clicked' || response === 'activate';
        if (!err && clicked) openBrowser(`http://localhost:${PORT}${p.url || '/'}`);
      },
    );
  } catch {
    /* notifications are a nicety; never let them break the app */
  }
}

export function ping({ type, title, body = '', url = '/', data = {} }) {
  const createdAt = nowIso();
  const { lastInsertRowid } = run(
    'INSERT INTO pings (created_at, type, title, body, url, data) VALUES (?, ?, ?, ?, ?, ?)',
    createdAt,
    type,
    truncate(title, 140),
    truncate(body, 400),
    url,
    JSON.stringify(data),
  );
  const id = Number(lastInsertRowid);
  run('DELETE FROM pings WHERE id <= ?', id - 200);
  const p = { id, type, title: truncate(title, 140), body: truncate(body, 400), url, data, createdAt };
  broadcast('ping', p);
  if (!someTabCanNotify()) nativeNotify(p);
  return p;
}

export function recentPings(limit = 30) {
  return all('SELECT * FROM pings ORDER BY id DESC LIMIT ?', limit).map((r) => ({
    id: r.id,
    type: r.type,
    title: r.title,
    body: r.body,
    url: r.url,
    data: parseJson(r.data, {}),
    createdAt: r.created_at,
  }));
}
