// Calendar from a private .ics link (Google Calendar "secret address", Outlook "publish calendar",
// iCloud public calendar, …). Lets non-Outlook users get the meeting pop-up too.

import crypto from 'node:crypto';
import ical from 'node-ical';
import { findMeetingLink } from '../core/text.js';

const plain = (v) => (v == null ? '' : typeof v === 'string' ? v : String(v.val ?? ''));

function attendeesOf(event) {
  const raw = event.attendee ? (Array.isArray(event.attendee) ? event.attendee : [event.attendee]) : [];
  return raw
    .map((a) => {
      const value = plain(a);
      return { name: a?.params?.CN || '', email: value.replace(/^mailto:/i, '').toLowerCase() };
    })
    .filter((p) => p.email || p.name);
}

export function parseIcs(text, { from, to }) {
  const data = ical.sync.parseICS(text);
  const events = [];
  for (const event of Object.values(data)) {
    if (event?.type !== 'VEVENT' || !event.start) continue;
    let instances;
    try {
      instances = ical.expandRecurringEvent(event, { from, to, expandOngoing: true });
    } catch {
      continue; // one malformed event must not hide the rest of the calendar
    }
    for (const inst of instances) {
      const source = inst.event || event;
      const start = new Date(inst.start);
      if (Number.isNaN(start.getTime())) continue;
      const title = plain(inst.summary ?? source.summary) || '(no title)';
      const location = plain(source.location);
      events.push({
        providerId: crypto
          .createHash('sha1')
          .update(`${plain(source.uid) || title}|${start.toISOString()}`)
          .digest('hex'),
        title,
        startAt: start.toISOString(),
        endAt: inst.end ? new Date(inst.end).toISOString() : null,
        attendees: attendeesOf(source),
        joinUrl: findMeetingLink(location, plain(source.url), plain(source.description)),
        location: location || null,
        isAllDay: !!inst.isFullDay,
        isCancelled: /cancel/i.test(plain(source.status)),
        declined: false,
      });
    }
  }
  return events;
}

export async function fetchIcsEvents(url, { from, to, fetchImpl = fetch }) {
  const res = await fetchImpl(String(url).replace(/^webcal:/i, 'https:'), {
    headers: { Accept: 'text/calendar, text/plain;q=0.8, */*;q=0.5' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`The calendar link returned an error (${res.status}).`);
  const text = await res.text();
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('That link did not return a calendar (.ics) file.');
  return parseIcs(text, { from, to });
}
