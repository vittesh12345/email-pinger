import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { listFollowups, updateFollowup } from '../src/core/followups.js';
import { analyzeMeetingById, askMeetings, createMeeting, deleteMeeting, getMeeting, ruleAnalysis, searchMeetings, updateMeeting } from '../src/core/meetings.js';
import { sampleTranscript } from '../src/providers/demo.js';
import { updateSettings } from '../src/settings.js';
import { fakeAi, freshDb } from './helpers.js';

beforeEach(() => {
  freshDb();
  updateSettings({ profile: { name: 'Alex Morgan' } });
});

const SAMPLE = sampleTranscript('Alex Morgan');

const AI_RESULT = {
  title: 'Onboarding redesign sync',
  summary: 'The team locked December 9 as the launch date.',
  key_points: ['Design is nearly done'],
  decisions: ['Launch on December 9'],
  action_items: [
    { owner: 'Alex Morgan', task: 'Send welcome copy to Jordan', due: '2026-11-24', mine: true },
    { owner: 'Dana Whitfield', task: 'Chase legal on the analytics contract', due: '2026-11-27', mine: false },
  ],
  followups: [
    { kind: 'todo', title: 'Send welcome-screen copy to Jordan', detail: 'Promised by end of day tomorrow.', person: 'Jordan Kim', due: '2026-11-24' },
    { kind: 'waiting', title: 'Check Dana heard back from legal', detail: 'She said Friday.', person: 'Dana Whitfield', due: 'Friday' },
  ],
  open_questions: ['Localize for Germany at launch?'],
};

test('without an AI key, commitments are picked out by rule', async () => {
  const m = createMeeting({ title: 'Weekly product sync', transcript: SAMPLE.transcript, source: 'paste' });
  const done = await analyzeMeetingById(m.id);
  assert.equal(done.analysisStatus, 'done');
  assert.equal(done.analysis.source, 'rules');
  assert.equal(done.summary, null, 'rules never invent a summary');
  const mine = done.analysis.action_items.filter((i) => i.mine).map((i) => i.task);
  assert.ok(mine.some((t) => t.includes('send the final copy')));
  assert.ok(mine.every((t) => t.split(/\s+/).length >= 5), 'throwaway lines like "I\'ll do that." are skipped');
  assert.ok(done.analysis.action_items.some((i) => i.owner === 'Dana Whitfield' && !i.mine), "other people's promises are not the user's");
  assert.ok(done.analysis.decisions.some((d) => d.includes('December 9th')));
  const followups = listFollowups({ status: 'open' });
  assert.equal(followups.length, mine.length);
  assert.ok(followups.every((f) => f.meetingId === m.id && f.source === 'meeting'));
});

test('unlabelled first-person lines (a live microphone transcript) count as the user', () => {
  const a = ruleAnalysis({ title: 'x', notes: '', transcript: "[00:10] I'll send the contract to Priya by Friday.\n[00:20] We talked about the weather." }, { name: 'Alex Morgan' });
  assert.equal(a.action_items.length, 1);
  assert.equal(a.action_items[0].mine, true);
  assert.equal(a.action_items[0].owner, 'You');
});

test('with AI: summary, follow-ups with dates, and a better title for a generic one', async () => {
  const calls = fakeAi(() => AI_RESULT);
  const m = createMeeting({ title: 'Untitled meeting', transcript: SAMPLE.transcript, notes: 'my notes', attendees: SAMPLE.attendees, source: 'paste' });
  const done = await analyzeMeetingById(m.id);
  assert.equal(done.title, 'Onboarding redesign sync');
  assert.equal(done.summary, AI_RESULT.summary);
  assert.equal(done.analysis.source, 'ai');
  const prompt = calls[0].messages[0].content;
  assert.ok(prompt.includes('<transcript>') && prompt.includes('<user_notes>') && prompt.includes('Attendees: Marcus Lee'));
  assert.match(calls[0].system, /The user is Alex Morgan/);
  assert.equal(calls[0].output_config.format.type, 'json_schema');

  const followups = listFollowups({ status: 'open' });
  assert.equal(followups.length, 2);
  const todo = followups.find((f) => f.kind === 'todo');
  assert.equal(todo.dueOn, '2026-11-24');
  assert.equal(todo.person, 'Jordan Kim');
  assert.equal(followups.find((f) => f.kind === 'waiting').dueOn, null, 'a date that is not YYYY-MM-DD is dropped, not stored');
});

test('a specific title chosen by the user is kept', async () => {
  fakeAi(() => AI_RESULT);
  const m = createMeeting({ title: 'Q4 planning with Dana', transcript: SAMPLE.transcript, source: 'paste' });
  assert.equal((await analyzeMeetingById(m.id)).title, 'Q4 planning with Dana');
});

test('re-reading a meeting keeps follow-ups the user already completed', async () => {
  fakeAi(() => AI_RESULT);
  const m = createMeeting({ title: 'Sync', transcript: SAMPLE.transcript, source: 'paste' });
  await analyzeMeetingById(m.id);
  const todo = listFollowups({ status: 'open' }).find((f) => f.kind === 'todo');
  updateFollowup(todo.id, { status: 'done' });
  await analyzeMeetingById(m.id);
  const all = listFollowups({ status: 'all' });
  assert.equal(all.length, 2, 'no duplicates after a second pass');
  assert.equal(all.find((f) => f.id === todo.id).status, 'done');
});

test('an AI failure is recorded on the meeting, not thrown', async () => {
  fakeAi(() => { throw new Error('rate limited'); });
  const m = createMeeting({ title: 'Sync', transcript: SAMPLE.transcript, source: 'paste' });
  const done = await analyzeMeetingById(m.id);
  assert.equal(done.analysisStatus, 'error');
  assert.match(done.analysisError, /rate limited/);
});

test('a nearly empty meeting is not sent to the AI', async () => {
  const calls = fakeAi(() => AI_RESULT);
  const m = createMeeting({ title: 'Sync', transcript: 'hi', status: 'live', source: 'live' });
  const done = await analyzeMeetingById(m.id);
  assert.equal(calls.length, 0);
  assert.equal(done.analysis.empty, true);
});

test('meetings are searchable by transcript, notes and summary; updates and deletes are reflected', async () => {
  const a = createMeeting({ title: 'Product sync', transcript: SAMPLE.transcript, source: 'paste' });
  const b = createMeeting({ title: 'Budget review', transcript: 'We went through the travel budget line by line.', source: 'paste' });
  assert.deepEqual(searchMeetings('localizing german market').map((r) => r.id), [a.id]);
  assert.deepEqual(searchMeetings('what about the budget?').map((r) => r.id), [b.id]);
  assert.deepEqual(searchMeetings('the of and'), [], 'only stop-words: nothing to search for');
  assert.deepEqual(searchMeetings('"quotes" AND (syntax) *'), [], 'search syntax in the question cannot break the query');

  updateMeeting(b.id, { notes: 'Follow up on the kangaroo sponsorship.' });
  assert.deepEqual(searchMeetings('kangaroo').map((r) => r.id), [b.id]);
  deleteMeeting(b.id);
  assert.deepEqual(searchMeetings('kangaroo'), []);
  assert.equal(getMeeting(b.id), null);
});

test('asking without an AI key returns the matching meetings', async () => {
  const a = createMeeting({ title: 'Product sync', transcript: SAMPLE.transcript, source: 'paste' });
  const r = await askMeetings('When is the launch date?');
  assert.equal(r.needsAi, true);
  assert.equal(r.answer, null);
  assert.deepEqual(r.sources.map((s) => s.id), [a.id]);
});

test('asking with AI sends the relevant records and returns the answer', async () => {
  const calls = fakeAi((params) => (params.system.includes('meeting-memory') ? AI_RESULT : 'You agreed on December 9 (Product sync, 2026-11-20).'));
  const a = createMeeting({ title: 'Product sync', transcript: SAMPLE.transcript, startedAt: '2026-11-20T15:00:00Z', source: 'paste' });
  await analyzeMeetingById(a.id);
  createMeeting({ title: 'Budget review', transcript: 'We went through the travel budget line by line.', source: 'paste' });
  const r = await askMeetings('What launch date did we lock?');
  assert.match(r.answer, /December 9/);
  const prompt = calls.at(-1).messages[0].content;
  assert.ok(prompt.includes('What launch date did we lock?'));
  assert.ok(prompt.includes('Launch on December 9'), 'decisions from the matching meeting are included');
  assert.ok(prompt.includes('Budget review'), 'recent meetings are listed for context');
});
