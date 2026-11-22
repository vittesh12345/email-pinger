// Keeps a short-horizon copy of the user's calendar, used for the "meeting is starting" pop-up.

import crypto from 'node:crypto';
import { listAccounts } from '../accounts.js';
import { all, get, run, tx } from '../db.js';
import { runtime } from '../events.js';
import { fetchIcsEvents } from '../providers/ics.js';
import { createProvider } from '../providers/index.js';
import { getSettings } from '../settings.js';
import { parseJson, safeLink } from '../util.js';

const HOUR = 3_600_000;

function store(source, events, from, to) {
  tx(() => {
    const seen = new Set();
    for (const e of events) {
      seen.add(e.providerId);
      run(
        `INSERT INTO calendar_events (source, provider_id, title, start_at, end_at, attendees, join_url, location,
           is_all_day, is_cancelled, declined)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source, provider_id) DO UPDATE SET title = excluded.title, start_at = excluded.start_at,
           end_at = excluded.end_at, attendees = excluded.attendees, join_url = excluded.join_url,
           location = excluded.location, is_all_day = excluded.is_all_day, is_cancelled = excluded.is_cancelled,
           declined = excluded.declined`,
        source,
        e.providerId,
        e.title,
        e.startAt,
        e.endAt,
        JSON.stringify(e.attendees || []),
        safeLink(e.joinUrl),
        e.location,
        e.isAllDay,
        e.isCancelled,
        e.declined,
      );
    }
    // Events in the window that the calendar no longer has were deleted or moved.
    for (const row of all(
      'SELECT id, provider_id FROM calendar_events WHERE source = ? AND start_at >= ? AND start_at <= ?',
      source,
      from.toISOString(),
      to.toISOString(),
    )) {
      if (!seen.has(row.provider_id)) run('DELETE FROM calendar_events WHERE id = ?', row.id);
    }
  });
}

export async function refreshCalendar(now = new Date()) {
  const from = new Date(now.getTime() - 3 * HOUR);
  const to = new Date(now.getTime() + 7 * 24 * HOUR);
  const active = new Set();
  const errors = [];

  for (const account of listAccounts()) {
    if (account.status === 'needs_auth') continue;
    let provider;
    try {
      provider = createProvider(account);
    } catch {
      continue;
    }
    if (!provider.fetchEvents) continue;
    const source = `account:${account.id}`;
    active.add(source);
    try {
      store(source, await provider.fetchEvents({ from, to }), from, to);
    } catch (err) {
      errors.push(`${account.email}: ${err.message}`);
    }
  }

  for (const url of getSettings().calendar.icsUrls) {
    const source = `ics:${crypto.createHash('sha1').update(url).digest('hex').slice(0, 12)}`;
    active.add(source);
    try {
      store(source, await fetchIcsEvents(url, { from, to }), from, to);
    } catch (err) {
      errors.push(`Calendar link: ${err.message}`);
    }
  }

  tx(() => {
    for (const row of all('SELECT DISTINCT source FROM calendar_events')) {
      if (!active.has(row.source)) run('DELETE FROM calendar_events WHERE source = ?', row.source);
    }
    run('DELETE FROM calendar_events WHERE start_at < ?', new Date(now.getTime() - 48 * HOUR).toISOString());
  });
  runtime.calendarError = errors.length ? errors.join(' · ') : null;
}

export function publicEvent(row) {
  return {
    id: row.id,
    title: row.title,
    startAt: row.start_at,
    endAt: row.end_at,
    attendees: parseJson(row.attendees, []),
    joinUrl: row.join_url,
    location: row.location,
    isAllDay: !!row.is_all_day,
    promptState: row.prompt_state,
    meetingId: row.meeting_id ?? null,
  };
}

const VISIBLE = 'is_cancelled = 0 AND declined = 0 AND is_all_day = 0';

export function upcomingEvents(now = new Date(), hours = 36) {
  return all(
    `SELECT e.*, (SELECT id FROM meetings m WHERE m.event_id = e.id ORDER BY m.id DESC LIMIT 1) AS meeting_id
     FROM calendar_events e
     WHERE ${VISIBLE} AND COALESCE(e.end_at, e.start_at) >= ? AND e.start_at <= ?
     ORDER BY e.start_at LIMIT 40`,
    now.toISOString(),
    new Date(now.getTime() + hours * HOUR).toISOString(),
  ).map(publicEvent);
}

/** Meetings starting now (within the lead time, or up to ten minutes in) that haven't been announced. */
export function eventsToPrompt(now = new Date(), leadMinutes = 1) {
  return all(
    `SELECT e.* FROM calendar_events e
     WHERE ${VISIBLE} AND e.prompt_state IS NULL AND e.start_at <= ? AND e.start_at >= ?
       AND NOT EXISTS (SELECT 1 FROM meetings m WHERE m.event_id = e.id)
     ORDER BY e.start_at`,
    new Date(now.getTime() + leadMinutes * 60_000).toISOString(),
    new Date(now.getTime() - 10 * 60_000).toISOString(),
  ).map(publicEvent);
}

export function setPromptState(id, state) {
  run('UPDATE calendar_events SET prompt_state = ? WHERE id = ?', state, id);
}

export const getEvent = (id) => {
  const row = get('SELECT * FROM calendar_events WHERE id = ?', id);
  return row ? publicEvent(row) : null;
};
