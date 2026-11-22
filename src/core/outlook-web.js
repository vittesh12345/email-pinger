// Receives what the browser extension reads from Outlook on the web, stores it, and keeps the
// mail triage up to date. Also holds the small bits of live state the UI shows ("reading Outlook",
// scan progress) and the hand-offs to the extension (start a scan, send a diagnostic outline).

import { getAccount, listAccounts, saveAccountConfig } from '../accounts.js';
import { get, run, tx } from '../db.js';
import { changed } from '../events.js';
import { emailPings } from '../scheduler.js';
import { getSettings } from '../settings.js';
import { HttpError, lower, nowIso, parseJson } from '../util.js';
import { cleanSnapshot, cleanStructure, folderKind, ownerFromTitle, parseStats, snapshotToItems } from './owa-parse.js';
import { normalizeName } from './triage.js';
import { suppressPendingPings, syncAccount } from './sync.js';

const LIVE_MS = 40_000;
const WARM_UP_MS = 10 * 60_000;
const KEEP_DAYS = 60;
const SYNC_DELAY_MS = 2500;
const PRECISION = { guess: 0, day: 1, minute: 2 };

const idleScan = () => ({ state: 'idle', requestedAt: null, finishedAt: null, pages: 0, error: null });
const state = {
  lastSeenAt: null,
  ext: null,
  folder: null,
  rows: 0,
  pane: 0,
  stats: null,
  scan: idleScan(),
  diagnose: false,
  diagnoseAt: null,
  structure: null,
  structureAt: null,
};
let lastBroadcast = '';

export const outlookWebAccount = () => listAccounts().find((a) => a.kind === 'outlook_web') || null;

const isLive = (now = Date.now()) => !!state.lastSeenAt && now - Date.parse(state.lastSeenAt) < LIVE_MS;

export function outlookWebStatus(now = Date.now()) {
  const account = outlookWebAccount();
  return {
    connected: !!account,
    email: account?.email || null,
    live: isLive(now),
    lastSeenAt: state.lastSeenAt,
    folder: state.folder,
    rows: state.rows,
    pane: state.pane,
    scan: { ...state.scan },
  };
}

function broadcastIfChanged() {
  const key = JSON.stringify([isLive(), state.folder, state.rows, state.pane, state.scan.state]);
  if (key !== lastBroadcast) {
    lastBroadcast = key;
    changed('status');
  }
}

/** Reset live state (tests, and after the account is removed). */
export function resetOutlookWeb() {
  Object.assign(state, { lastSeenAt: null, ext: null, folder: null, rows: 0, pane: 0, stats: null, scan: idleScan(), diagnose: false, structure: null });
  lastBroadcast = '';
}

export function requestScan(now = Date.now()) {
  if (!outlookWebAccount()) throw new HttpError(400, 'Connect Outlook in the browser first.');
  if (!isLive(now)) {
    throw new HttpError(409, 'Pinger cannot see Outlook right now. Open Outlook on the web in Chrome or Edge, with the Pinger extension installed.');
  }
  if (state.scan.state === 'idle') state.scan = { ...idleScan(), state: 'requested', requestedAt: new Date(now).toISOString() };
  broadcastIfChanged();
  return { ...state.scan };
}

export function requestDiagnostics(now = Date.now()) {
  state.diagnose = true;
  state.diagnoseAt = new Date(now).toISOString();
  state.structure = null;
  state.structureAt = null;
}

/** Page structure and parse counts — no message text, names or addresses. */
export function diagnostics() {
  return {
    requestedAt: state.diagnoseAt,
    collectedAt: state.structureAt,
    extensionVersion: state.ext,
    live: isLive(),
    stats: state.stats,
    structure: state.structure,
  };
}

function upsertItems(accountId, items, now) {
  let count = 0;
  tx(() => {
    for (const item of items) {
      const prev = get('SELECT data FROM web_items WHERE account_id = ? AND provider_id = ?', accountId, item.providerId);
      let next = item;
      if (prev) {
        // The first good reading of a date wins; Outlook's labels get vaguer as mail ages.
        const old = parseJson(prev.data, null);
        if (old && (PRECISION[old.precision] ?? 0) >= (PRECISION[item.precision] ?? 0)) {
          next = { ...next, sentAt: old.sentAt, precision: old.precision };
        }
        // A conversation id, once known, beats the subject-only key used when the row is off screen.
        if (old && !old.threadKey.startsWith('w:s:') && next.threadKey.startsWith('w:s:')) next = { ...next, threadKey: old.threadKey };
      }
      const data = JSON.stringify(next);
      if (!prev || prev.data !== data) count++;
      run(
        `INSERT INTO web_items (account_id, provider_id, data, seen_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(account_id, provider_id) DO UPDATE SET data = excluded.data, seen_at = excluded.seen_at`,
        accountId,
        item.providerId,
        data,
        nowIso(now),
      );
    }
    run('DELETE FROM web_items WHERE account_id = ? AND seen_at < ?', accountId, new Date(now.getTime() - KEEP_DAYS * 86_400_000).toISOString());
  });
  return count;
}

/**
 * Sync the account from its stored items and handle pings. While Pinger is first getting to
 * know the mailbox, or a scan is digging up older mail, nothing found is pinged individually.
 */
export async function syncOutlookWeb(accountId, now = new Date()) {
  const account = getAccount(accountId);
  if (!account) return;
  await syncAccount(accountId, { now });
  const firstSeen = Date.parse(getAccount(accountId)?.config?.firstSeenAt || '') || now.getTime();
  const quiet = state.scan.state !== 'idle' || now.getTime() - firstSeen < WARM_UP_MS;
  if (quiet) suppressPendingPings(accountId, now);
  else emailPings(now);
  changed('threads', 'accounts', 'status');
}

const timers = new Map();
function scheduleSync(accountId) {
  clearTimeout(timers.get(accountId));
  const t = setTimeout(() => {
    timers.delete(accountId);
    syncOutlookWeb(accountId).catch((err) => console.error('[pinger] Outlook web sync failed:', err.message));
  }, SYNC_DELAY_MS);
  t.unref?.();
  timers.set(accountId, t);
}

/**
 * One message from the extension: a snapshot of the page, or just "still here".
 * The reply tells the extension whether to start a scan, stop one, or send a diagnostic outline.
 *
 * @param {object} body  { snapshot?, unchanged?, structure?, scanFinished?, scanError?, ext? }
 * @param {{now?: Date, schedule?: boolean}} [opts]  `schedule: false` leaves syncing to the caller (tests)
 */
export function ingest(body, { now = new Date(), schedule = true } = {}) {
  state.lastSeenAt = nowIso(now);
  if (typeof body?.ext === 'string') state.ext = body.ext.slice(0, 20);
  const account = outlookWebAccount();
  const reply = { connected: !!account, scan: false, stopScan: false, diagnose: state.diagnose };

  if (body?.structure && state.diagnose) {
    state.structure = cleanStructure(body.structure);
    state.structureAt = nowIso(now);
    state.diagnose = false;
    reply.diagnose = false;
  }
  if (body?.scanFinished && state.scan.state !== 'idle') {
    state.scan = {
      ...state.scan,
      state: 'idle',
      finishedAt: nowIso(now),
      error: body.scanError ? 'Pinger could not find Outlook’s message list to scroll.' : null,
    };
  }

  if (account) {
    if (state.scan.state === 'requested' && !body?.scanFinished) {
      state.scan = { ...state.scan, state: 'running', pages: 0 };
      reply.scan = true;
    }
    const snap = body?.snapshot ? cleanSnapshot(body.snapshot) : null;
    if (snap) {
      const settings = getSettings();
      const owner = ownerFromTitle(snap.title);
      const me = {
        email: lower(account.email),
        name: settings.profile.name || account.name || owner.name || '',
        names: new Set([account.name, settings.profile.name, owner.name].map(normalizeName).filter(Boolean)),
      };
      const items = snapshotToItems(snap, { now, me });
      state.folder = folderKind(snap.folder);
      state.rows = snap.rows.length;
      state.pane = snap.open?.messages.length || 0;
      state.stats = parseStats(snap, now);

      if (!account.config?.firstSeenAt) saveAccountConfig(account.id, { ...account.config, firstSeenAt: nowIso(now) });
      const count = upsertItems(account.id, items, now);

      if (state.scan.state === 'running') {
        state.scan.pages++;
        const since = now.getTime() - settings.sync.lookbackDays * 86_400_000;
        const dated = items.filter((it) => it.origin === 'list' && it.precision !== 'guess').map((it) => Date.parse(it.sentAt));
        if (dated.length && Math.min(...dated) < since) reply.stopScan = true;
      }
      if (count && schedule) scheduleSync(account.id);
      reply.stored = count;
    }
  }
  broadcastIfChanged();
  return reply;
}
