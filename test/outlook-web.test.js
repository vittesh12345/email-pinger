import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { createAccount, getAccount } from '../src/accounts.js';
import { diagnostics, ingest, outlookWebStatus, requestDiagnostics, requestScan, resetOutlookWeb, syncOutlookWeb } from '../src/core/outlook-web.js';
import { listThreads, publicThread } from '../src/core/sync.js';
import { all, get } from '../src/db.js';
import { EXTENSION_ID } from '../src/config.js';
import { stopScheduler } from '../src/scheduler.js';
import { createApp, listen } from '../src/server.js';
import { updateSettings } from '../src/settings.js';
import { freshDb } from './helpers.js';

const NOW = new Date(2026, 10, 23, 11, 0, 0); // Monday, 11:00 local
const LATER = (minutes) => new Date(NOW.getTime() + minutes * 60_000);
const EN = { order: 'MDY', weekdays: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], yesterday: 'yesterday', today: 'today' };

const snapshot = (over = {}) => ({
  url: 'https://outlook.office.com/mail/inbox',
  title: 'Mail - Vittesh Maganti - Outlook',
  folder: { path: '/mail/inbox', label: 'Inbox' },
  locale: EN,
  rows: [],
  open: null,
  ...over,
});
const row = (convId, sender, subject, when, preview, extra = {}) => ({ convId, lines: [sender, subject, when, preview], titles: [], ...extra });

const INBOX = snapshot({
  rows: [
    row('C-priya', 'Priya Raman', 'Contract renewal — need your answer by Friday', '9:42 AM', 'Hi Vittesh, can you confirm whether you want to keep the 40-seat plan? I need your answer by Friday.', { titles: ['priya.raman@northwind.example'] }),
    row('C-marcus', 'Marcus Lee', 'Q4 roadmap draft', 'Sun 4:10 PM', 'Could you look at the hiring section and let me know if the timeline is realistic?'),
    row('C-news', 'Weekly Newsletter', 'Top stories this week', 'Sun 8:00 AM', 'Five trends shaping remote work. Unsubscribe'),
    row('C-chris', 'Chris Alvarez', 'Re: Invoice for October', 'Fri 9:00 AM', 'Got it, thanks!'),
  ],
});
const SENT = snapshot({
  url: 'https://outlook.office.com/mail/sentitems',
  folder: { path: '/mail/sentitems', label: 'Sent Items' },
  rows: [row('C-elena', 'Elena Petrova', 'Proposal for the spring campaign', '11/18/2026', 'Could you let me know whether the budget on page 3 works for your team?')],
});

let account;
beforeEach(() => {
  freshDb();
  resetOutlookWeb();
  updateSettings({ profile: { name: 'Vittesh Maganti' } });
  account = createAccount({ kind: 'outlook_web', email: 'vittesh@acme.example', name: 'Vittesh Maganti', config: {} });
});

const feed = async (snap, now = NOW) => {
  const reply = ingest({ snapshot: snap }, { now, schedule: false });
  await syncOutlookWeb(account.id, now);
  return reply;
};
const subjects = (state, now = NOW) => listThreads({ state, now }).map((t) => t.subject);

test('the inbox as seen in Outlook on the web is triaged', async () => {
  const reply = await feed(INBOX);
  assert.equal(reply.connected, true);
  assert.equal(reply.stored, 4);
  assert.deepEqual(subjects('needs_reply'), ['Contract renewal — need your answer by Friday', 'Q4 roadmap draft']);
  const priya = publicThread(listThreads({ state: 'needs_reply', now: NOW })[0], undefined, NOW);
  assert.equal(priya.priority, 'high', '"by Friday" is a deadline');
  assert.equal(priya.person.name, 'Priya Raman');
  assert.equal(priya.webLink, 'https://outlook.office.com/mail/');
  assert.equal(outlookWebStatus(NOW.getTime()).live, true);
  assert.equal(outlookWebStatus(NOW.getTime()).folder, 'inbox');
});

test('Sent Items gives "waiting on others", with a nudge once it is overdue', async () => {
  await feed(SENT);
  const waiting = listThreads({ state: 'awaiting_reply', now: NOW }).map((t) => publicThread(t, undefined, NOW));
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].person.name, 'Elena Petrova');
  assert.equal(waiting[0].overdue, true, 'sent 5 days ago');
});

test('opening a conversation replaces the preview with the full message', async () => {
  await feed(INBOX);
  const opened = snapshot({
    url: 'https://outlook.office.com/mail/inbox/id/AAQk',
    rows: INBOX.rows.map((r) => ({ ...r, selected: r.convId === 'C-priya' })),
    open: {
      subject: 'Contract renewal — need your answer by Friday',
      messages: [
        {
          header: 'Priya Raman <priya.raman@northwind.example>\nTo:\nVittesh Maganti\nMon 11/23/2026 9:42 AM',
          body: 'Hi Vittesh, can you confirm whether you want to keep the 40-seat plan? I need your answer by Friday.\n\nThanks,\nPriya',
        },
      ],
    },
  });
  await feed(opened, LATER(1));
  const thread = listThreads({ state: 'needs_reply', now: LATER(1) }).find((t) => t.subject.startsWith('Contract'));
  const messages = all('SELECT * FROM messages WHERE thread_key = ?', thread.thread_key);
  assert.equal(messages.length, 1, 'the list preview was replaced, not duplicated');
  assert.match(messages[0].body, /Thanks,\nPriya/);
  assert.deepEqual(JSON.parse(messages[0].to_json), [{ name: 'Vittesh Maganti', email: '' }]);
  assert.ok(publicThread(thread, undefined, LATER(1)).reasons.includes('sent only to you'), 'recognised by name');
});

test('an open conversation whose list row has scrolled out of view is not stored twice', async () => {
  const open = {
    subject: 'Contract renewal — need your answer by Friday',
    messages: [{ header: 'Priya Raman <priya.raman@northwind.example>\nTo:\nVittesh Maganti\nMon 11/23/2026 9:42 AM', body: 'Hi Vittesh, we are finalizing. Can you confirm the 40-seat plan?' }],
  };
  await feed(snapshot({ rows: INBOX.rows.map((r) => ({ ...r, selected: r.convId === 'C-priya' })), open }));
  // Scrolled: the row (and with it the conversation id) is gone, the reading pane is not.
  await feed(snapshot({ rows: [row('C-f1', 'Colleague 1', 'Status', '11/10/2026', 'Nothing needed.')], open }), LATER(1));
  const thread = listThreads({ state: 'needs_reply', now: LATER(1) }).find((t) => t.subject.startsWith('Contract'));
  assert.equal(all('SELECT * FROM messages WHERE thread_key = ?', thread.thread_key).length, 1);
  assert.equal(all('SELECT data FROM web_items').filter((r) => JSON.parse(r.data).origin === 'pane').length, 1);
  assert.ok(!JSON.parse(all('SELECT data FROM web_items').find((r) => JSON.parse(r.data).origin === 'pane').data).threadKey.startsWith('w:s:'), 'keeps the conversation id');
});

test('after you reply in Outlook, the conversation no longer needs a reply', async () => {
  await feed(INBOX);
  const replied = snapshot({
    rows: INBOX.rows.map((r) => ({ ...r, selected: r.convId === 'C-priya' })),
    open: {
      subject: 'Contract renewal — need your answer by Friday',
      messages: [
        { header: 'Vittesh Maganti <vittesh@acme.example>\nTo: Priya Raman\nMon 11/23/2026 10:55 AM', body: 'Confirmed: 40 seats.' },
        { header: 'Priya Raman <priya.raman@northwind.example>\nTo: Vittesh Maganti\nMon 11/23/2026 9:42 AM', body: 'Hi Vittesh, can you confirm whether you want to keep the 40-seat plan? I need your answer by Friday.' },
      ],
    },
  });
  await feed(replied, LATER(1));
  assert.deepEqual(subjects('needs_reply', LATER(1)), ['Q4 roadmap draft']);
});

test('a date read precisely once is kept when Outlook later shows a vaguer label', async () => {
  await feed(INBOX);
  const tomorrow = new Date(2026, 10, 24, 11, 0, 0);
  // The next day Outlook shows yesterday's 9:42 message as "Mon 11/23".
  const vaguer = snapshot({ rows: [{ ...INBOX.rows[0], lines: ['Priya Raman', INBOX.rows[0].lines[1], 'Mon 11/23', INBOX.rows[0].lines[3]] }] });
  ingest({ snapshot: vaguer }, { now: tomorrow, schedule: false });
  const stored = all('SELECT data FROM web_items').map((r) => JSON.parse(r.data)).find((d) => d.subject.startsWith('Contract'));
  assert.equal(stored.precision, 'minute');
  assert.equal(new Date(stored.sentAt).getHours(), 9);
  assert.equal(new Date(stored.sentAt).getMinutes(), 42);
});

test('no individual pings for mail Pinger is only just getting to know; later urgent mail does ping', async () => {
  await feed(INBOX);
  assert.equal(all("SELECT * FROM pings WHERE type = 'urgent'").length, 0, 'first minutes: the overview covers it');

  const later = LATER(30);
  const withNew = snapshot({
    rows: [row('C-ops', 'Dana Whitfield', 'Server down — need approval ASAP', '11:25 AM', 'Can you approve the emergency change? It is urgent.'), ...INBOX.rows],
  });
  ingest({ snapshot: withNew }, { now: later, schedule: false });
  await syncOutlookWeb(account.id, later);
  const urgent = all("SELECT * FROM pings WHERE type = 'urgent'");
  assert.equal(urgent.length, 1);
  assert.match(urgent[0].title, /Dana Whitfield needs a reply/);
});

test('when no Outlook-web account is connected, snapshots are discarded', async () => {
  freshDb();
  resetOutlookWeb();
  const reply = ingest({ snapshot: INBOX }, { now: NOW, schedule: false });
  assert.deepEqual(reply, { connected: false, scan: false, stopScan: false, diagnose: false });
  assert.equal(get('SELECT COUNT(*) AS n FROM web_items').n, 0);
});

test('a snapshot from a page that is not Outlook is ignored', async () => {
  const reply = ingest({ snapshot: { ...INBOX, url: 'https://evil.example/mail/inbox' } }, { now: NOW, schedule: false });
  assert.equal(reply.stored, undefined);
  assert.equal(get('SELECT COUNT(*) AS n FROM web_items').n, 0);
});

test('scan: needs Outlook open; starts on the next message; stops once mail is older than the lookback', async () => {
  assert.throws(() => requestScan(NOW.getTime()), /cannot see Outlook/);
  ingest({ unchanged: true }, { now: NOW, schedule: false });
  assert.equal(requestScan(NOW.getTime()).state, 'requested');

  const first = ingest({ unchanged: true }, { now: LATER(0.1), schedule: false });
  assert.equal(first.scan, true);
  assert.equal(outlookWebStatus(LATER(0.1).getTime()).scan.state, 'running');

  const recent = ingest({ snapshot: INBOX }, { now: LATER(0.2), schedule: false });
  assert.equal(recent.stopScan, false);
  const old = snapshot({ rows: [row('C-old', 'Old Sender', 'Old thing', '10/01/2026', 'Ancient?')] });
  assert.equal(ingest({ snapshot: old }, { now: LATER(0.3), schedule: false }).stopScan, true, 'older than 14 days');

  ingest({ scanFinished: true }, { now: LATER(0.4), schedule: false });
  const status = outlookWebStatus(LATER(0.4).getTime());
  assert.equal(status.scan.state, 'idle');
  assert.ok(status.scan.finishedAt);
  assert.equal(status.scan.pages, 2);
});

test('diagnostics: asked for on the next message, stored without content', () => {
  requestDiagnostics(NOW.getTime());
  assert.equal(ingest({ unchanged: true }, { now: NOW, schedule: false }).diagnose, true);
  const reply = ingest({ structure: { tag: 'page', kids: [{ tag: 'div', role: 'option', attrs: ['data-convid'], text: 'Priya Raman — renewal' }] }, snapshot: INBOX }, { now: LATER(0.1), schedule: false });
  assert.equal(reply.diagnose, false);
  const d = diagnostics();
  assert.equal(d.structure.kids[0].role, 'option');
  assert.equal(JSON.stringify(d).includes('Priya'), false, 'no names or text');
  assert.equal(d.stats.rows, 4);
  assert.equal(d.stats.rowsWithSubject, 4);
});

/* ------------------------------------------------------------------ HTTP */

let server;
let base;
const EXT = `chrome-extension://${EXTENSION_ID}`;
before(async () => {
  server = await listen(createApp(), 0);
  base = `http://localhost:${server.address().port}`;
});
after(() => {
  stopScheduler();
  server.closeAllConnections?.();
  server.close();
});

const call = async (path, { method = 'GET', body, origin } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

test('HTTP: only the Pinger extension may send snapshots', async () => {
  assert.equal((await call('/api/outlook-web/snapshot', { method: 'POST', body: { snapshot: INBOX }, origin: 'https://evil.example' })).status, 403);
  assert.equal((await call('/api/outlook-web/snapshot', { method: 'POST', body: { snapshot: INBOX }, origin: base })).status, 403, "not even Pinger's own page");
  const ok = await call('/api/outlook-web/snapshot', { method: 'POST', body: { snapshot: INBOX }, origin: EXT });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.connected, true);
  assert.equal((await call('/api/outlook-web/snapshot', { method: 'POST', body: { unchanged: true }, origin: `extension://${EXTENSION_ID}` })).status, 200, 'Edge');
  assert.equal((await call('/api/followups', { method: 'POST', body: { title: 'x' }, origin: EXT })).status, 403, 'the extension may only use the Outlook-web routes');
});

test('HTTP: connecting, status, one account at a time, disconnecting', async () => {
  freshDb();
  resetOutlookWeb();
  assert.equal((await call('/api/accounts/outlook-web', { method: 'POST', body: { email: 'nope' } })).status, 400);
  const made = await call('/api/accounts/outlook-web', { method: 'POST', body: { email: 'Vittesh@Acme.example' } });
  assert.equal(made.status, 200);
  assert.equal(made.body.account.kind, 'outlook_web');
  assert.equal(made.body.account.email, 'vittesh@acme.example');
  assert.equal((await call('/api/accounts/outlook-web', { method: 'POST', body: { email: 'other@acme.example' } })).status, 400);

  let state = (await call('/api/state')).body;
  assert.equal(state.outlookWeb.connected, true);
  assert.equal(state.outlookWeb.live, false);
  assert.equal((await call('/api/outlook-web/scan', { method: 'POST' })).status, 409, 'Outlook not open yet');

  await call('/api/outlook-web/snapshot', { method: 'POST', body: { snapshot: INBOX }, origin: EXT });
  state = (await call('/api/state')).body;
  assert.equal(state.outlookWeb.live, true);
  assert.equal(state.outlookWeb.rows, 4);
  assert.equal((await call('/api/outlook-web/scan', { method: 'POST' })).body.scan.state, 'requested');

  assert.equal((await call(`/api/accounts/${made.body.account.id}`, { method: 'DELETE' })).status, 200);
  state = (await call('/api/state')).body;
  assert.equal(state.outlookWeb.connected, false);
  assert.equal(getAccount(made.body.account.id), null);
  assert.equal(get('SELECT COUNT(*) AS n FROM web_items').n, 0, 'stored items go with the account');
});
