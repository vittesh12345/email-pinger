import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { freshDb } from './helpers.js';
import { stopScheduler } from '../src/scheduler.js';
import { createApp, listen } from '../src/server.js';

let server;
let base;
let port;

before(async () => {
  freshDb();
  server = await listen(createApp(), 0);
  port = server.address().port;
  base = `http://localhost:${port}`;
});

after(() => {
  stopScheduler();
  server.closeAllConnections?.();
  server.close();
});

const call = async (path, { method = 'GET', body, headers } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
};

test('the server only answers its own page: wrong Host, cross-site Origin and form posts are refused', async () => {
  // fetch() will not let a caller override Host, so speak HTTP directly for that case.
  const { request } = await import('node:http');
  const status = await new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/api/state', headers: { Host: 'evil.example' } }, (res) => resolve(res.statusCode));
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403, 'a DNS-rebinding style Host header');

  assert.equal((await call('/api/followups', { method: 'POST', body: { title: 'x' }, headers: { Origin: 'https://evil.example' } })).status, 403);
  const form = await fetch(`${base}/api/followups`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'title=x' });
  assert.equal(form.status, 415, 'a plain HTML form post');
  assert.equal((await call('/api/followups', { method: 'POST', body: { title: 'ok' }, headers: { Origin: base } })).status, 200);
});

test('static assets and the app shell are served with a content security policy', async () => {
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>Pinger<\/title>/);
  const csp = page.headers.get('content-security-policy');
  assert.match(csp, /default-src 'self'/);
  assert.match(
    csp,
    /frame-ancestors chrome-extension:\/\/([a-p]{32}) extension:\/\/\1;/,
    'only the bundled side-panel extension (Chrome or Edge form) may frame Pinger',
  );
  for (const asset of ['/app.js', '/styles.css', '/vendor/preact.mjs', '/vendor/preact-hooks.mjs', '/vendor/htm.mjs', '/manifest.webmanifest', '/fonts/inter-latin-wght-normal.woff2', '/icon-192.png']) {
    assert.equal((await fetch(base + asset)).status, 200, asset);
  }
  assert.equal((await call('/api/nope')).status, 404);
});

test('settings round-trip without ever exposing the AI key', async () => {
  const put = await call('/api/settings', { method: 'PUT', body: { profile: { name: 'Alex Morgan' }, ai: { apiKey: 'sk-ant-api03-TOPSECRETVALUE-wxyz' }, overview: { times: ['08:30', '16:00'] } } });
  assert.equal(put.status, 200);
  const { body } = await call('/api/state');
  assert.equal(body.settings.profile.name, 'Alex Morgan');
  assert.deepEqual(body.settings.overview.times, ['08:30', '16:00']);
  assert.equal(body.ai.enabled, true);
  assert.equal(JSON.stringify(body).includes('TOPSECRET'), false);
  assert.equal((await call('/api/settings', { method: 'PUT', body: { overview: { times: ['nope'] } } })).status, 400);
  await call('/api/settings', { method: 'PUT', body: { ai: { apiKey: '' } } });
});

test('sample mailbox: connect, triage, act on a thread, build an overview', async () => {
  // Scheduled overviews off, so the result does not depend on what time the tests run.
  await call('/api/settings', { method: 'PUT', body: { overview: { enabled: false } } });
  const added = await call('/api/accounts/demo', { method: 'POST' });
  assert.equal(added.status, 200);
  assert.equal(JSON.stringify(added.body).includes('seedAt'), false, 'account config stays on the server');

  const { body: state } = await call('/api/state');
  assert.equal(state.accounts.length, 1);
  assert.equal(state.counts.needsReply, 5);
  assert.equal(state.counts.nudges, 2);

  const { body: list } = await call('/api/threads');
  assert.equal(list.threads[0].person.name, 'Priya Raman', 'the deadline email sorts first');
  assert.equal(list.threads[0].priority, 'high');

  const first = list.threads[0];
  const detail = await call(`/api/threads/${first.id}`);
  assert.match(detail.body.messages.at(-1).body, /40-seat plan/);

  assert.equal((await call(`/api/threads/${first.id}/action`, { method: 'POST', body: { action: 'done' } })).status, 200);
  assert.equal((await call('/api/threads')).body.threads.length, 4);
  assert.equal((await call('/api/threads?handled=1')).body.threads.length, 5);
  assert.equal((await call(`/api/threads/${first.id}/action`, { method: 'POST', body: { action: 'snooze' } })).status, 400, 'snooze needs a time');
  assert.equal((await call(`/api/threads/${first.id}/action`, { method: 'POST', body: { action: 'open' } })).status, 200);
  assert.equal((await call(`/api/threads/${first.id}/draft`, { method: 'POST' })).status, 400, 'drafting needs an AI key');

  const waiting = await call('/api/threads?view=waiting');
  assert.deepEqual(waiting.body.threads.filter((t) => t.overdue).map((t) => t.person.name).sort(), ['Elena Petrova', 'Ravi Shah']);

  const overview = await call('/api/overview', { method: 'POST' });
  assert.match(overview.body.digest.brief, /5 emails need a reply/);
  assert.equal(overview.body.digest.briefSource, 'rules');
  const current = await call('/api/overview');
  assert.equal(current.body.brief.trigger, 'manual');
  assert.equal(current.body.now.meetings.length >= 0, true);
});

test('follow-ups: create, edit, complete, delete', async () => {
  const created = await call('/api/followups', { method: 'POST', body: { title: 'Send Priya the contract', dueOn: '2026-11-25', kind: 'todo' } });
  const id = created.body.followup.id;
  assert.equal(created.body.followup.dueOn, '2026-11-25');
  assert.equal((await call('/api/followups', { method: 'POST', body: { title: '  ' } })).status, 400);
  assert.equal((await call(`/api/followups/${id}`, { method: 'PATCH', body: { dueOn: 'tomorrow' } })).status, 400);
  const done = await call(`/api/followups/${id}`, { method: 'PATCH', body: { status: 'done' } });
  assert.equal(done.body.followup.status, 'done');
  assert.ok(done.body.followup.completedAt);
  assert.equal((await call('/api/followups?status=open')).body.followups.some((f) => f.id === id), false);
  assert.equal((await call(`/api/followups/${id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await call(`/api/followups/99999`, { method: 'PATCH', body: { status: 'done' } })).status, 404);
});

test('meetings: upload a .vtt, get rule-based follow-ups, record a live meeting, search', async () => {
  const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:05.000\n<v Alex Morgan>I'll send the signed contract to Priya by Friday.</v>\n\n00:00:06.000 --> 00:00:09.000\n<v Priya Raman>Thanks, that works for us.</v>";
  const up = await call('/api/meetings/import', { method: 'POST', body: { filename: 'Northwind check-in.vtt', dataBase64: Buffer.from(vtt).toString('base64') } });
  assert.equal(up.status, 200);
  assert.equal(up.body.meeting.title, 'Northwind check in');
  const id = up.body.meeting.id;

  let detail;
  for (let i = 0; i < 40; i++) {
    detail = (await call(`/api/meetings/${id}`)).body;
    if (detail.meeting.analysisStatus === 'done') break;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(detail.meeting.analysisStatus, 'done');
  assert.match(detail.meeting.transcript, /\[00:01\] Alex Morgan: I'll send the signed contract/);
  assert.equal(detail.followups.length, 1);
  assert.match(detail.followups[0].title, /signed contract/);

  assert.equal((await call('/api/meetings/import', { method: 'POST', body: { filename: 'call.mp3', dataBase64: 'AAAA' } })).status, 400);
  assert.equal((await call('/api/meetings', { method: 'POST', body: { title: 'Empty' } })).status, 400);

  const live = await call('/api/meetings', { method: 'POST', body: { live: true, title: 'Standup' } });
  const liveId = live.body.meeting.id;
  assert.equal(live.body.meeting.status, 'live');
  await call(`/api/meetings/${liveId}`, { method: 'PATCH', body: { transcript: '[00:05] We decided to ship on Tuesday.', notes: 'ship Tuesday', quiet: true } });
  assert.equal((await call(`/api/meetings/${liveId}/finish`, { method: 'POST', body: {} })).status, 200);
  const finished = (await call(`/api/meetings/${liveId}`)).body.meeting;
  assert.equal(finished.status, 'ready');
  assert.ok(finished.endedAt);

  const asked = await call('/api/ask', { method: 'POST', body: { question: 'signed contract for Priya' } });
  assert.equal(asked.body.needsAi, true);
  assert.equal(asked.body.sources[0].id, id);

  assert.equal((await call(`/api/meetings/${id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await call(`/api/meetings/${id}`)).status, 404);
});

test('IMAP sign-up validates its input before touching the network', async () => {
  assert.equal((await call('/api/accounts/imap', { method: 'POST', body: { email: 'not-an-email', password: 'x' } })).status, 400);
  assert.equal((await call('/api/accounts/imap', { method: 'POST', body: { email: 'a@b.example', password: '' } })).status, 400);
  assert.equal((await call('/api/accounts/imap', { method: 'POST', body: { email: 'a@b.example', password: 'x', host: 'bad host!' } })).status, 400);
  const d = await call('/api/accounts/imap-defaults?email=someone@gmail.com');
  assert.deepEqual(d.body, { host: 'imap.gmail.com', port: 993, known: true, microsoft: false });
  assert.equal((await call('/api/accounts/imap-defaults?email=someone@hotmail.com')).body.microsoft, true);
});

test('Outlook sign-in: without an app ID the user is sent to setup; a bad callback is rejected', async () => {
  const start = await fetch(`${base}/auth/microsoft/start`, { redirect: 'manual' });
  assert.equal(start.status, 302);
  assert.ok(['/#/settings?outlook=setup'].includes(start.headers.get('location')) || start.headers.get('location').startsWith('https://login.microsoftonline.com/'));
  const cb = await fetch(`${base}/auth/microsoft/callback?code=abc&state=forged`, { redirect: 'manual' });
  assert.equal(cb.status, 302);
  assert.match(decodeURIComponent(cb.headers.get('location')), /sign-in link expired/);
  const denied = await fetch(`${base}/auth/microsoft/callback?error=access_denied&state=x`, { redirect: 'manual' });
  assert.match(decodeURIComponent(denied.headers.get('location')), /cancelled/);
});

test('wiping data needs explicit confirmation and removes everything', async () => {
  assert.equal((await call('/api/data/wipe', { method: 'POST', body: {} })).status, 400);
  assert.equal((await call('/api/data/wipe', { method: 'POST', body: { confirm: 'DELETE' } })).status, 200);
  const { body } = await call('/api/state');
  assert.equal(body.accounts.length, 0);
  assert.equal(body.counts.needsReply, 0);
  assert.equal(body.settings.profile.name, '');
});
