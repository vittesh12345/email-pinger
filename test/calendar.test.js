import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { eventsToPrompt, refreshCalendar, upcomingEvents } from '../src/core/calendar.js';
import { createMeeting } from '../src/core/meetings.js';
import { all } from '../src/db.js';
import { fetchIcsEvents, parseIcs } from '../src/providers/ics.js';
import { meetingPrompts } from '../src/scheduler.js';
import { updateSettings } from '../src/settings.js';
import { createAccount } from '../src/accounts.js';
import { freshDb } from './helpers.js';

beforeEach(freshDb);

const ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//test//EN
BEGIN:VEVENT
UID:single-1
DTSTAMP:20261120T100000Z
DTSTART:20261123T150000Z
DTEND:20261123T153000Z
SUMMARY:One-off review
DESCRIPTION:Join here https://teams.microsoft.com/l/meetup-join/abc
ATTENDEE;CN=Dana Whitfield:mailto:dana@acme.example
ATTENDEE;CN=Marcus Lee:mailto:marcus@acme.example
END:VEVENT
BEGIN:VEVENT
UID:weekly-1
DTSTAMP:20261101T100000Z
DTSTART;TZID=America/New_York:20261102T100000
DTEND;TZID=America/New_York:20261102T103000
RRULE:FREQ=WEEKLY;BYDAY=MO
EXDATE;TZID=America/New_York:20261130T100000
SUMMARY:Weekly sync
END:VEVENT
BEGIN:VEVENT
UID:allday-1
DTSTAMP:20261101T100000Z
DTSTART;VALUE=DATE:20261124
DTEND;VALUE=DATE:20261125
SUMMARY:Company holiday
END:VEVENT
BEGIN:VEVENT
UID:cancelled-1
DTSTAMP:20261101T100000Z
DTSTART:20261125T150000Z
DTEND:20261125T160000Z
STATUS:CANCELLED
SUMMARY:Cancelled thing
END:VEVENT
END:VCALENDAR`;

const range = { from: new Date('2026-11-22T00:00:00Z'), to: new Date('2026-12-08T00:00:00Z') };

test('ICS: recurring events are expanded in the right time zone, exceptions removed', () => {
  const weekly = parseIcs(ICS, range).filter((e) => e.title === 'Weekly sync').map((e) => e.startAt);
  // 10:00 New York is 15:00 UTC in winter; Nov 30 is excluded by EXDATE.
  assert.deepEqual(weekly, ['2026-11-23T15:00:00.000Z', '2026-12-07T15:00:00.000Z']);
});

test('ICS: attendees, meeting link, all-day and cancelled flags', () => {
  const events = parseIcs(ICS, range);
  const one = events.find((e) => e.title === 'One-off review');
  assert.deepEqual(one.attendees, [{ name: 'Dana Whitfield', email: 'dana@acme.example' }, { name: 'Marcus Lee', email: 'marcus@acme.example' }]);
  assert.equal(one.joinUrl, 'https://teams.microsoft.com/l/meetup-join/abc');
  assert.equal(events.find((e) => e.title === 'Company holiday').isAllDay, true);
  assert.equal(events.find((e) => e.title === 'Cancelled thing').isCancelled, true);
  assert.equal(new Set(events.map((e) => e.providerId)).size, events.length, 'every occurrence has its own id');
});

test('ICS: a link that is not a calendar is rejected with a clear message', async () => {
  const html = async () => new Response('<html>Sign in</html>', { status: 200 });
  await assert.rejects(fetchIcsEvents('https://example.com/x', { ...range, fetchImpl: html }), /did not return a calendar/);
  const missing = async () => new Response('', { status: 404 });
  await assert.rejects(fetchIcsEvents('webcal://example.com/x', { ...range, fetchImpl: missing }), /404/);
});

test('the demo calendar is stored, and a meeting is announced once when it starts', async () => {
  const seed = new Date('2026-11-23T15:00:00Z').getTime();
  createAccount({ kind: 'demo', email: 'you@example.com', name: 'Alex', config: { seedAt: seed } });
  await refreshCalendar(new Date(seed));
  assert.deepEqual(upcomingEvents(new Date(seed), 36).map((e) => e.title), ['Weekly product sync', '1:1 with Marcus', 'Design review']);

  assert.equal(meetingPrompts(new Date(seed)).length, 0, 'two minutes early: nothing yet');
  const prompted = meetingPrompts(new Date(seed + 70_000)); // within the one-minute lead
  assert.deepEqual(prompted.map((e) => e.title), ['Weekly product sync']);
  const ping = all('SELECT * FROM pings')[0];
  assert.equal(ping.type, 'meeting');
  assert.match(ping.title, /Weekly product sync is starting/);
  assert.match(ping.url, /#\/live\?event=\d+/);
  assert.equal(meetingPrompts(new Date(seed + 100_000)).length, 0, 'never announced twice');

  await refreshCalendar(new Date(seed + 120_000));
  assert.equal(meetingPrompts(new Date(seed + 130_000)).length, 0, 'still not after the calendar is refreshed');
});

test('no pop-up for a meeting already being recorded, long started, or when pop-ups are off', async () => {
  const seed = new Date('2026-11-23T15:00:00Z').getTime();
  createAccount({ kind: 'demo', email: 'you@example.com', name: 'Alex', config: { seedAt: seed } });
  await refreshCalendar(new Date(seed));
  const sync = upcomingEvents(new Date(seed), 36)[0];

  assert.equal(eventsToPrompt(new Date(seed + 20 * 60_000), 1).length, 0, 'eighteen minutes in is too late to ask');
  updateSettings({ meetings: { prompt: false } });
  assert.equal(meetingPrompts(new Date(seed + 2 * 60_000)).length, 0);
  updateSettings({ meetings: { prompt: true } });
  createMeeting({ title: sync.title, eventId: sync.id, status: 'live', source: 'live' });
  assert.equal(meetingPrompts(new Date(seed + 2 * 60_000)).length, 0);
});
