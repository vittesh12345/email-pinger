import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { getAccount } from '../src/accounts.js';
import { listThreads, publicThread, syncAccount } from '../src/core/sync.js';
import { all, get, run } from '../src/db.js';
import { runtime } from '../src/events.js';
import { emailPings } from '../src/scheduler.js';
import { DAY, fakeAi, fakeProvider, freshDb, HOUR, mail, makeAccount, ME } from './helpers.js';

const PRIYA = { name: 'Priya Raman', email: 'priya@northwind.example' };
const ELENA = { name: 'Elena Petrova', email: 'elena@brightside.example' };
const NOW = new Date(2026, 10, 23, 11, 0, 0); // a Monday, 11:00 local — inside ping hours
const now = NOW.getTime();

let account;
beforeEach(() => {
  freshDb();
  account = makeAccount();
});

const sync = (messages, opts) => syncAccount(account.id, { provider: fakeProvider(messages, opts), now: NOW });
const needsReply = () => listThreads({ state: 'needs_reply', now: NOW });
const waiting = () => listThreads({ state: 'awaiting_reply', now: NOW });

test('sync stores mail and sorts threads into "needs reply" and "waiting"', async () => {
  await sync([
    mail({ now, from: PRIYA, thread: 'renewal', subject: 'Renewal', body: 'Can you confirm the plan by Friday?' }),
    mail({ now, from: ME, to: [ELENA], thread: 'proposal', subject: 'Proposal', body: 'Could you let me know if the budget works?', ago: 4 * DAY }),
    mail({ now, from: { name: 'News', email: 'newsletter@brief.example' }, thread: 'news', body: 'Top stories. Unsubscribe' }),
  ]);
  assert.deepEqual(needsReply().map((t) => t.subject), ['Renewal']);
  assert.deepEqual(waiting().map((t) => t.subject), ['Proposal']);
  assert.equal(publicThread(waiting()[0], undefined, NOW).overdue, true, '4 days of silence passes the 3-day default');
  assert.equal(getAccount(account.id).status, 'ok');
  assert.ok(getAccount(account.id).last_sync_at);
});

test('replying moves a thread out of "needs reply" on the next sync', async () => {
  const first = mail({ now, from: PRIYA, thread: 'renewal', body: 'Can you confirm the plan?', ago: 5 * HOUR });
  await sync([first]);
  assert.equal(needsReply().length, 1);
  await sync([first, mail({ now, from: ME, to: [PRIYA], thread: 'renewal', body: 'Confirmed — 40 seats.', ago: HOUR })]);
  assert.equal(needsReply().length, 0);
});

test('a thread marked done stays done until a new message arrives', async () => {
  const first = mail({ now, from: PRIYA, thread: 'renewal', body: 'Can you confirm the plan?', ago: 5 * HOUR });
  await sync([first]);
  run("UPDATE threads SET user_status = 'done' WHERE id = ?", needsReply()[0].id);
  await sync([first]);
  assert.equal(needsReply().length, 0, 'still done after a re-sync');
  await sync([first, mail({ now, from: PRIYA, thread: 'renewal', body: 'Any update on this?', ago: HOUR })]);
  assert.equal(needsReply().length, 1, 'a follow-up from them reopens it');
});

test('snoozed threads are hidden until the snooze ends', async () => {
  await sync([mail({ now, from: PRIYA, thread: 'renewal', body: 'Can you confirm the plan?' })]);
  const id = needsReply()[0].id;
  run("UPDATE threads SET user_status = 'snoozed', snooze_until = ? WHERE id = ?", new Date(now + HOUR).toISOString(), id);
  assert.equal(needsReply().length, 0);
  assert.equal(listThreads({ state: 'needs_reply', now: new Date(now + 2 * HOUR) }).length, 1);
});

test('mail deleted from the mailbox disappears from Pinger', async () => {
  const keep = mail({ now, from: PRIYA, thread: 'a', body: 'Can you confirm?' });
  const gone = mail({ now, from: ELENA, thread: 'b', body: 'Could you review this?' });
  await sync([keep, gone]);
  assert.equal(needsReply().length, 2);
  await sync([keep]);
  assert.equal(needsReply().length, 1);
  assert.equal(get('SELECT COUNT(*) AS n FROM messages').n, 1);
});

test('an incomplete fetch never deletes anything', async () => {
  const a = mail({ now, from: PRIYA, thread: 'a', body: 'Can you confirm?' });
  const b = mail({ now, from: ELENA, thread: 'b', body: 'Could you review this?' });
  await sync([a, b]);
  await sync([a], { complete: false });
  assert.equal(get('SELECT COUNT(*) AS n FROM messages').n, 2);
});

test('a body the provider did not re-send is kept', async () => {
  const m = mail({ now, from: PRIYA, thread: 'a', body: 'Can you confirm the plan?' });
  await sync([m]);
  await sync([{ ...m, body: undefined }]);
  assert.equal(get('SELECT body FROM messages').body, 'Can you confirm the plan?');
  assert.equal(needsReply().length, 1);
});

test('a failing provider marks the account and rethrows', async () => {
  const provider = { fetchMessages: async () => { throw Object.assign(new Error('Sign in again'), { needsAuth: true }); } };
  await assert.rejects(syncAccount(account.id, { provider, now: NOW }), /Sign in again/);
  assert.equal(getAccount(account.id).status, 'needs_auth');
});

test('AI triage overrides the rules, and its text is shown', async () => {
  const calls = fakeAi((params) => {
    const { threads } = JSON.parse(params.messages[0].content);
    return {
      threads: threads.map((t) => ({
        id: t.id,
        category: t.subject === 'Coffee?' ? 'needs_reply' : 'no_action',
        priority: 'low',
        summary: `About ${t.subject}`,
        ask: 'Pick a day',
        next_step: 'Reply with a day',
        due: '2026-11-27',
      })),
    };
  });
  await sync([
    mail({ now, from: PRIYA, thread: 'coffee', subject: 'Coffee?', body: 'Are you free for coffee next week?' }),
    mail({ now, from: ELENA, thread: 'fyi', subject: 'Heads up', body: 'Can you believe it? We shipped!' }),
    mail({ now, from: { email: 'no-reply@shop.example' }, thread: 'shop', body: 'Can you rate your order?' }),
  ]);
  assert.equal(calls.length, 1);
  const sent = JSON.parse(calls[0].messages[0].content).threads;
  assert.equal(sent.length, 2, 'automated mail is never sent to the AI');
  assert.equal(sent[0].messages[0].sender, 'them');

  const threads = needsReply();
  assert.deepEqual(threads.map((t) => t.subject), ['Coffee?'], 'the AI said "Heads up" needs nothing');
  const shown = publicThread(threads[0], undefined, NOW);
  assert.equal(shown.source, 'ai');
  assert.equal(shown.priority, 'low');
  assert.equal(shown.ask, 'Pick a day');
  assert.equal(shown.due, '2026-11-27');
});

test('AI results are cached until the thread changes', async () => {
  const calls = fakeAi((params) => ({
    threads: JSON.parse(params.messages[0].content).threads.map((t) => ({ id: t.id, category: 'needs_reply', priority: 'medium', summary: 's', ask: 'a', next_step: 'n', due: null })),
  }));
  const first = mail({ now, from: PRIYA, thread: 'a', body: 'Can you confirm?', ago: 5 * HOUR });
  await sync([first]);
  await sync([first]);
  assert.equal(calls.length, 1, 'unchanged thread is not re-analysed');
  await sync([first, mail({ now, from: PRIYA, thread: 'a', body: 'Ping?', ago: HOUR })]);
  assert.equal(calls.length, 2);
});

test('an AI answer that contradicts who spoke last is ignored', async () => {
  fakeAi((params) => ({
    // The user wrote last, so "needs_reply" is impossible; and id 9999 does not exist.
    threads: [
      ...JSON.parse(params.messages[0].content).threads.map((t) => ({ id: t.id, category: 'needs_reply', priority: 'high', summary: 's', ask: 'a', next_step: 'n', due: 'soon' })),
      { id: 9999, category: 'needs_reply', priority: 'high', summary: 's', ask: 'a', next_step: 'n', due: null },
    ],
  }));
  await sync([mail({ now, from: ME, to: [ELENA], thread: 'p', body: 'Could you let me know?' })]);
  assert.equal(needsReply().length, 0);
  assert.equal(waiting().length, 0);
  assert.equal(get('SELECT ai_due FROM threads').ai_due, null, 'a malformed date is dropped');
});

test('if the AI fails, the rule-based triage stands and the reason is surfaced', async () => {
  fakeAi(() => { throw new Error('boom'); });
  await sync([mail({ now, from: PRIYA, thread: 'a', body: 'Can you confirm the plan?' })]);
  assert.equal(needsReply().length, 1);
  assert.equal(needsReply()[0].state_source, 'rules');
  assert.match(runtime.aiError, /boom/);
});

test('mail already there on the first sync does not trigger individual pings', async () => {
  await sync([mail({ now, from: PRIYA, thread: 'a', body: 'Can you confirm by Friday?', importance: 'high' })]);
  emailPings(NOW);
  assert.equal(all('SELECT * FROM pings').length, 0);
});

test('new urgent mail and newly overdue threads ping once each', async () => {
  const waitingMail = mail({ now, from: ME, to: [ELENA], thread: 'p', subject: 'Proposal', body: 'Could you let me know?', ago: 2 * DAY });
  await sync([waitingMail]);
  await sync([waitingMail, mail({ now, from: PRIYA, thread: 'u', subject: 'Contract', body: 'Can you sign by Friday? It is urgent.' })]);
  emailPings(NOW);
  let pings = all('SELECT * FROM pings ORDER BY id');
  assert.deepEqual(pings.map((p) => p.type), ['urgent']);
  assert.match(pings[0].title, /Priya Raman needs a reply/);

  emailPings(new Date(now + 2 * DAY)); // the proposal has now been unanswered for 4 days
  pings = all('SELECT * FROM pings ORDER BY id');
  assert.deepEqual(pings.map((p) => p.type), ['urgent', 'nudge']);
  assert.match(pings[1].title, /No reply from Elena Petrova/);

  emailPings(new Date(now + 2 * DAY));
  assert.equal(all('SELECT * FROM pings').length, 2, 'nothing is pinged twice');
});

test('no pings outside ping hours', async () => {
  const m = mail({ now, from: ME, to: [ELENA], thread: 'p', body: 'Could you let me know?', ago: 2 * DAY });
  await sync([m]);
  await sync([m, mail({ now, from: PRIYA, thread: 'u', body: 'Can you sign by Friday?' })]);
  emailPings(new Date(2026, 10, 23, 23, 30));
  assert.equal(all('SELECT * FROM pings').length, 0);
});

test('auto-draft: off by default; on, it pre-writes a reply for each thread that needs one', async () => {
  const { updateSettings } = await import('../src/settings.js');
  const { publicThread } = await import('../src/core/sync.js');
  const calls = fakeAi((params) => {
    if (params.system.includes('triage engine')) {
      return { threads: JSON.parse(params.messages[0].content).threads.map((t) => ({ id: t.id, category: t.last_from === 'them' ? 'needs_reply' : 'awaiting_reply', priority: 'medium', summary: 's', ask: 'a', next_step: 'n', due: null })) };
    }
    return 'Hi Priya,\n\nLet me confirm and get back to you.\n\nAlex';
  });

  const inbound = mail({ now, from: PRIYA, thread: 'renewal', subject: 'Renewal', body: 'Can you confirm the plan?', ago: 5 * HOUR });
  const waitingMail = mail({ now, from: ME, to: [ELENA], thread: 'proposal', subject: 'Proposal', body: 'Could you let me know?', ago: 2 * HOUR });
  await sync([inbound, waitingMail]);
  assert.equal(get('SELECT draft_text FROM threads WHERE subject = ?', 'Renewal').draft_text, null, 'off by default');
  const draftCalls0 = calls.filter((c) => !c.system.includes('triage engine')).length;
  assert.equal(draftCalls0, 0);

  updateSettings({ ai: { autoDraft: true } });
  await sync([inbound, waitingMail]);
  const needs = listThreads({ state: 'needs_reply', now: NOW })[0];
  assert.match(get('SELECT draft_text FROM threads WHERE id = ?', needs.id).draft_text, /Let me confirm/);
  assert.match(publicThread(needs, undefined, NOW).draft, /Let me confirm/);
  // Only threads that need a reply are drafted — not the "waiting on others" one.
  assert.equal(get('SELECT draft_text FROM threads WHERE subject = ?', 'Proposal').draft_text, null);
  const draftCalls1 = calls.filter((c) => !c.system.includes('triage engine')).length;
  assert.equal(draftCalls1, 1);
});

test('auto-draft: a reply is not re-drafted until a new message arrives', async () => {
  const { updateSettings } = await import('../src/settings.js');
  updateSettings({ ai: { autoDraft: true } });
  const calls = fakeAi((params) => (params.system.includes('triage engine')
    ? { threads: JSON.parse(params.messages[0].content).threads.map((t) => ({ id: t.id, category: 'needs_reply', priority: 'medium', summary: 's', ask: 'a', next_step: 'n', due: null })) }
    : 'Draft body.'));
  const first = mail({ now, from: PRIYA, thread: 'a', body: 'Can you confirm?', ago: 5 * HOUR });
  await sync([first]);
  await sync([first]);
  assert.equal(calls.filter((c) => !c.system.includes('triage engine')).length, 1, 'unchanged thread not re-drafted');
  await sync([first, mail({ now, from: PRIYA, thread: 'a', body: 'Any update?', ago: HOUR })]);
  assert.equal(calls.filter((c) => !c.system.includes('triage engine')).length, 2, 'a new message gets a fresh draft');
});
