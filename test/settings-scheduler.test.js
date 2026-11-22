import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { dueOverviewSlot, nextOverviewAt, withinPingHours } from '../src/scheduler.js';
import { getSettings, publicSettings, spreadTimes, updateSettings } from '../src/settings.js';
import { freshDb } from './helpers.js';

beforeEach(freshDb);

// Local-time helper so these tests pass in any time zone.
const at = (y, m, d, h, min = 0) => new Date(y, m - 1, d, h, min, 0, 0);
const MONDAY = [2026, 11, 23];
const SUNDAY = [2026, 11, 22];

test('spreadTimes spaces overviews across the working day', () => {
  assert.deepEqual(spreadTimes(0), []);
  assert.deepEqual(spreadTimes(1), ['09:00']);
  assert.deepEqual(spreadTimes(2), ['09:00', '17:00']);
  assert.deepEqual(spreadTimes(3), ['09:00', '13:00', '17:00']);
  assert.deepEqual(spreadTimes(5), ['09:00', '11:00', '13:00', '15:00', '17:00']);
  assert.equal(spreadTimes(40).length <= 12, true);
});

test('settings merge with defaults, sort and de-duplicate times', () => {
  const s = updateSettings({ overview: { times: ['17:00', '9:05', '09:05'] } });
  assert.deepEqual(s.overview.times, ['09:05', '17:00']);
  assert.equal(s.overview.weekdaysOnly, true, 'untouched keys keep their defaults');
  assert.equal(getSettings().followups.awaitingDays, 3);
});

test('settings reject bad values', () => {
  assert.throws(() => updateSettings({ overview: { times: ['25:00'] } }), /not a valid time/);
  assert.throws(() => updateSettings({ ai: { model: 'gpt-4' } }), /Unknown model/);
  assert.throws(() => updateSettings({ calendar: { icsUrls: ['file:///etc/passwd'] } }), /https/);
  assert.equal(updateSettings({ followups: { awaitingDays: 999 } }).followups.awaitingDays, 30, 'out-of-range numbers are clamped');
});

test('webcal links are stored as https', () => {
  const s = updateSettings({ calendar: { icsUrls: ['webcal://calendar.example/feed.ics'] } });
  assert.deepEqual(s.calendar.icsUrls, ['https://calendar.example/feed.ics']);
});

test('the UI never receives the AI key', () => {
  updateSettings({ ai: { apiKey: 'sk-ant-api03-SECRETSECRETSECRET-abcd' } });
  const pub = publicSettings();
  assert.equal(pub.ai.apiKeySet, true);
  assert.equal(JSON.stringify(pub).includes('SECRETSECRET'), false);
  assert.equal(pub.ai.apiKeyHint, 'sk-ant-…abcd');
});

test('an overview is due at its time and stays due through the grace period', () => {
  const overview = { enabled: true, times: ['09:00', '13:00', '17:00'], weekdaysOnly: true };
  const notDone = () => false;
  assert.equal(dueOverviewSlot({ now: at(...MONDAY, 8, 59), overview, isDone: notDone }), null);
  assert.equal(dueOverviewSlot({ now: at(...MONDAY, 9, 0), overview, isDone: notDone }), '2026-11-23 09:00');
  assert.equal(dueOverviewSlot({ now: at(...MONDAY, 9, 40), overview, isDone: notDone }), '2026-11-23 09:00', 'laptop woke up late');
  assert.equal(dueOverviewSlot({ now: at(...MONDAY, 12, 30), overview, isDone: notDone }), null, 'too late for 9:00, too early for 13:00');
});

test('only the most recent due overview is sent, and never twice', () => {
  const overview = { enabled: true, times: ['09:00', '10:00'], weekdaysOnly: false };
  assert.equal(dueOverviewSlot({ now: at(...MONDAY, 10, 5), overview, isDone: () => false }), '2026-11-23 10:00');
  assert.equal(dueOverviewSlot({ now: at(...MONDAY, 10, 5), overview, isDone: (slot) => slot === '2026-11-23 10:00' }), null);
});

test('weekends and the off switch are respected', () => {
  const overview = { enabled: true, times: ['09:00'], weekdaysOnly: true };
  assert.equal(dueOverviewSlot({ now: at(...SUNDAY, 9, 5), overview, isDone: () => false }), null);
  assert.equal(dueOverviewSlot({ now: at(...SUNDAY, 9, 5), overview: { ...overview, weekdaysOnly: false }, isDone: () => false }), '2026-11-22 09:00');
  assert.equal(dueOverviewSlot({ now: at(...MONDAY, 9, 5), overview: { ...overview, enabled: false }, isDone: () => false }), null);
});

test('nextOverviewAt finds the next slot, skipping the weekend', () => {
  const overview = { enabled: true, times: ['09:00', '17:00'], weekdaysOnly: true };
  assert.deepEqual(nextOverviewAt(at(...MONDAY, 10), overview), at(...MONDAY, 17));
  assert.deepEqual(nextOverviewAt(at(...MONDAY, 18), overview), at(2026, 11, 24, 9));
  assert.deepEqual(nextOverviewAt(at(...SUNDAY, 10), overview), at(...MONDAY, 9));
  assert.equal(nextOverviewAt(at(...MONDAY, 10), { ...overview, enabled: false }), null);
});

test('withinPingHours handles ordinary and overnight ranges', () => {
  assert.equal(withinPingHours(at(...MONDAY, 7, 59), { start: '08:00', end: '20:00' }), false);
  assert.equal(withinPingHours(at(...MONDAY, 8, 0), { start: '08:00', end: '20:00' }), true);
  assert.equal(withinPingHours(at(...MONDAY, 20, 0), { start: '08:00', end: '20:00' }), false);
  assert.equal(withinPingHours(at(...MONDAY, 23, 0), { start: '22:00', end: '06:00' }), true);
  assert.equal(withinPingHours(at(...MONDAY, 12, 0), { start: '22:00', end: '06:00' }), false);
});
