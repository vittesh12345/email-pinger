import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { createAccount } from '../src/accounts.js';
import { createFollowup, updateFollowup } from '../src/core/followups.js';
import { buildDigest, collectOverview, headline, latestDigest, ruleBrief } from '../src/core/overview.js';
import { syncAccount } from '../src/core/sync.js';
import { all } from '../src/db.js';
import { followupReminders, scheduledOverview } from '../src/scheduler.js';
import { updateSettings } from '../src/settings.js';
import { localDate } from '../src/util.js';
import { fakeAi, freshDb } from './helpers.js';

const MONDAY_10 = new Date(2026, 10, 23, 10, 0, 0); // local time, inside ping hours

async function demo(now = MONDAY_10) {
  const account = createAccount({ kind: 'demo', email: 'you@example.com', name: 'Alex Morgan', config: { seedAt: now.getTime() } });
  await syncAccount(account.id, { now });
}

beforeEach(freshDb);

test('the overview counts what needs a reply, who to nudge and what is due', async () => {
  await demo();
  createFollowup({ title: 'Send the deck', dueOn: localDate(MONDAY_10) });
  createFollowup({ title: 'Next month thing', dueOn: '2026-12-20' });
  const o = collectOverview(MONDAY_10);
  assert.deepEqual(
    { ...o.counts, meetingsToday: undefined },
    { needsReply: 5, highPriority: 1, waiting: 3, nudges: 2, followupsDue: 1, followupsOpen: 2, meetingsToday: undefined },
  );
  assert.equal(o.needsReply[0].person.name, 'Priya Raman', 'high priority first');
  assert.deepEqual(o.nudges.map((t) => t.person.name).sort(), ['Elena Petrova', 'Ravi Shah']);
  assert.equal(headline(o.counts), '5 to reply · 2 to nudge · 1 follow-up due');
});

test('the rule-based briefing is factual; an empty inbox says so', async () => {
  assert.match(ruleBrief(collectOverview(MONDAY_10)), /all caught up/);
  assert.equal(headline(collectOverview(MONDAY_10).counts), 'all caught up');
  await demo();
  const text = ruleBrief(collectOverview(MONDAY_10), undefined, MONDAY_10);
  assert.match(text, /5 emails need a reply, 1 of them high priority/);
  assert.match(text, /Hannah Schultz/);
  assert.match(text, /2 people haven't replied to you in 3\+ days/);
});

test('with AI the briefing is written from a compact list, never raw mailboxes', async () => {
  await demo();
  const calls = fakeAi((params) =>
    params.system.includes('triage engine')
      ? { threads: JSON.parse(params.messages[0].content).threads.map((t) => ({ id: t.id, category: t.last_from === 'them' ? 'needs_reply' : 'awaiting_reply', priority: 'medium', summary: 's', ask: 'a', next_step: 'n', due: null })) }
      : 'Priya needs the seat count by Friday.',
  );
  const digest = await buildDigest({ trigger: 'manual', now: MONDAY_10 });
  assert.equal(digest.brief, 'Priya needs the seat count by Friday.');
  assert.equal(digest.briefSource, 'ai');
  const sent = JSON.parse(calls.at(-1).messages[0].content);
  assert.deepEqual(Object.keys(sent), ['need_your_reply', 'waiting_on_others_overdue', 'followups_due', 'meetings_today']);
  assert.equal(sent.need_your_reply.length, 5);
  assert.equal(latestDigest().id, digest.id);
});

test('if the AI briefing fails, the rule-based one is used', async () => {
  await demo();
  fakeAi(() => { throw new Error('offline'); });
  const digest = await buildDigest({ trigger: 'manual', now: MONDAY_10 });
  assert.equal(digest.briefSource, 'rules');
  assert.match(digest.brief, /emails need a reply/);
});

test('a scheduled overview is sent once per slot, with a ping', async () => {
  await demo();
  updateSettings({ overview: { times: ['09:30', '14:00'], weekdaysOnly: true } });
  const first = await scheduledOverview(MONDAY_10);
  assert.equal(first.slot, `${localDate(MONDAY_10)} 09:30`);
  assert.equal(await scheduledOverview(new Date(MONDAY_10.getTime() + 60_000)), null, 'same slot: not again');
  const pings = all('SELECT * FROM pings');
  assert.equal(pings.length, 1);
  assert.equal(pings[0].type, 'overview');
  assert.equal(pings[0].title, 'Email overview: 5 to reply · 2 to nudge');

  const afternoon = new Date(2026, 10, 23, 14, 0, 30);
  assert.equal((await scheduledOverview(afternoon)).slot, `${localDate(MONDAY_10)} 14:00`);
  assert.equal(all('SELECT * FROM pings').length, 2);
});

test('no scheduled overview at the weekend, or when turned off', async () => {
  await demo();
  updateSettings({ overview: { times: ['09:30'] } });
  assert.equal(await scheduledOverview(new Date(2026, 10, 22, 9, 31)), null, 'Sunday');
  updateSettings({ overview: { enabled: false } });
  assert.equal(await scheduledOverview(MONDAY_10), null);
});

test('due follow-ups are reminded about once per interval, inside ping hours, until done', async () => {
  const today = localDate(MONDAY_10);
  const a = createFollowup({ title: 'Send Priya the contract', dueOn: today });
  createFollowup({ title: 'Not due yet', dueOn: '2026-12-30' });

  assert.equal(followupReminders(new Date(2026, 10, 23, 6, 0)).length, 0, 'before ping hours');
  assert.deepEqual(followupReminders(MONDAY_10).map((f) => f.title), ['Send Priya the contract']);
  assert.match(all('SELECT * FROM pings')[0].title, /Follow-up due: Send Priya the contract/);
  assert.equal(followupReminders(new Date(MONDAY_10.getTime() + 3_600_000)).length, 0, 'an hour later: not yet');
  assert.equal(followupReminders(new Date(MONDAY_10.getTime() + 25 * 3_600_000)).length, 1, 'next day: reminded again');

  updateFollowup(a.id, { snoozeUntil: new Date(MONDAY_10.getTime() + 72 * 3_600_000).toISOString() });
  assert.equal(followupReminders(new Date(MONDAY_10.getTime() + 50 * 3_600_000)).length, 0, 'snoozed');
  updateFollowup(a.id, { status: 'done' });
  assert.equal(followupReminders(new Date(MONDAY_10.getTime() + 100 * 3_600_000)).length, 0, 'done');
});
