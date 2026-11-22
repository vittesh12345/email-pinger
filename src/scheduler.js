// The heartbeat. Every half minute: sync mail that is due, refresh the calendar, announce meetings
// that are starting, send the scheduled overviews, and remind about follow-ups.

import { listAccounts } from './accounts.js';
import { eventsToPrompt, refreshCalendar, setPromptState } from './core/calendar.js';
import { dueFollowups } from './core/followups.js';
import { buildDigest, digestForSlot, headline } from './core/overview.js';
import { markPinged, pingableThreads, syncAccount } from './core/sync.js';
import { all, run } from './db.js';
import { changed, runtime } from './events.js';
import { ping } from './pings.js';
import { getSettings } from './settings.js';
import { atLocalTime, localDate, nowIso, parseHM, plural, truncate } from './util.js';

const TICK_MS = 30_000;
const CALENDAR_EVERY_MS = 5 * 60_000;
const SLOT_GRACE_MS = 3 * 3_600_000;

/**
 * Which scheduled overview, if any, is due right now.
 * A slot is due from its time until the grace period ends (so a laptop that was asleep at 9:00
 * still gets its overview at 9:40) — but only the most recent due slot counts.
 */
export function dueOverviewSlot({ now, overview, isDone }) {
  if (!overview.enabled || !overview.times?.length) return null;
  const day = now.getDay();
  if (overview.weekdaysOnly && (day === 0 || day === 6)) return null;
  const due = overview.times
    .filter((t) => parseHM(t) != null)
    .map((t) => ({ t, at: atLocalTime(now, t) }))
    .filter(({ at }) => at <= now && now - at <= SLOT_GRACE_MS)
    .sort((a, b) => b.at - a.at)[0];
  if (!due) return null;
  const slot = `${localDate(now)} ${due.t}`;
  return isDone(slot) ? null : slot;
}

export function nextOverviewAt(now, overview) {
  if (!overview.enabled || !overview.times?.length) return null;
  for (let offset = 0; offset < 8; offset++) {
    const day = new Date(now);
    day.setDate(day.getDate() + offset);
    if (overview.weekdaysOnly && (day.getDay() === 0 || day.getDay() === 6)) continue;
    for (const t of [...overview.times].sort()) {
      const at = atLocalTime(day, t);
      if (at > now) return at;
    }
  }
  return null;
}

export function withinPingHours(now, { start, end }) {
  const mins = now.getHours() * 60 + now.getMinutes();
  const a = parseHM(start) ?? 0;
  const b = parseHM(end) ?? 24 * 60;
  return a <= b ? mins >= a && mins < b : mins >= a || mins < b;
}

/* ------------------------------------------------------------------- steps */

export async function syncAll({ force = false, now = new Date() } = {}) {
  const settings = getSettings();
  const accounts = listAccounts().filter((a) => force || a.status !== 'needs_auth');
  const due = accounts.filter(
    (a) => force || !a.last_sync_at || now - new Date(a.last_sync_at) >= settings.sync.intervalMinutes * 60_000,
  );
  if (!due.length) return { synced: 0 };
  runtime.syncing = true;
  changed('status');
  const errors = [];
  try {
    for (const account of due) {
      try {
        await syncAccount(account.id, { now });
      } catch (err) {
        errors.push(`${account.email}: ${err.message}`);
      }
    }
  } finally {
    runtime.syncing = false;
    runtime.lastSyncError = errors.length ? errors.join(' · ') : null;
  }
  emailPings(now);
  changed('threads', 'accounts', 'status');
  return { synced: due.length, errors };
}

/** Individual pings for mail that can't wait for the next overview. */
export function emailPings(now = new Date()) {
  const settings = getSettings();
  if (!withinPingHours(now, settings.pingHours)) return;
  const { urgent, nudges } = pingableThreads(now, settings);

  if (settings.followups.pingUrgent && urgent.length) {
    for (const t of urgent.slice(0, 3)) {
      ping({
        type: 'urgent',
        title: `${t.counterpart_name || t.counterpart_email} needs a reply`,
        body: t.ai_message_id === t.last_message_id && t.ai_ask ? t.ai_ask : t.subject,
        url: `/#/emails?open=${t.id}`,
      });
    }
    if (urgent.length > 3) {
      ping({ type: 'urgent', title: `${urgent.length - 3} more urgent emails need a reply`, url: '/#/emails' });
    }
    for (const t of urgent) markPinged(t.id);
  }

  if (nudges.length) {
    const names = nudges.map((t) => t.counterpart_name || t.counterpart_email);
    ping({
      type: 'nudge',
      title: nudges.length === 1 ? `No reply from ${names[0]} yet` : `${nudges.length} people haven't replied to you`,
      body: nudges.length === 1 ? `“${truncate(nudges[0].subject, 80)}” — time for a nudge?` : truncate(names.join(', '), 160),
      url: nudges.length === 1 ? `/#/emails/waiting?open=${nudges[0].id}` : '/#/emails/waiting',
    });
    for (const t of nudges) markPinged(t.id);
  }
}

export function meetingPrompts(now = new Date()) {
  const settings = getSettings();
  if (!settings.meetings.prompt) return [];
  const events = eventsToPrompt(now, settings.meetings.leadMinutes);
  for (const e of events) {
    setPromptState(e.id, 'prompted');
    ping({
      type: 'meeting',
      title: `${e.title} is starting`,
      body: 'Want Pinger to take notes and record a transcript?',
      url: `/#/live?event=${e.id}`,
      data: { eventId: e.id, title: e.title, startAt: e.startAt, joinUrl: e.joinUrl },
    });
  }
  return events;
}

export async function scheduledOverview(now = new Date()) {
  const settings = getSettings();
  const slot = dueOverviewSlot({ now, overview: settings.overview, isDone: (s) => !!digestForSlot(s) });
  if (!slot) return null;
  const digest = await buildDigest({ trigger: 'scheduled', slot, now });
  ping({ type: 'overview', title: `Email overview: ${headline(digest.counts)}`, body: digest.brief, url: '/#/' });
  changed('digest');
  return digest;
}

export function followupReminders(now = new Date()) {
  const settings = getSettings();
  if (!withinPingHours(now, settings.pingHours)) return [];
  const cutoff = new Date(now.getTime() - settings.followups.remindEveryHours * 3_600_000).toISOString();
  const lastPinged = new Map(all("SELECT id, last_pinged_at FROM followups WHERE status = 'open'").map((r) => [r.id, r.last_pinged_at]));
  const due = dueFollowups(now).filter((f) => !lastPinged.get(f.id) || lastPinged.get(f.id) <= cutoff);
  if (!due.length) return [];
  ping({
    type: 'followups',
    title: due.length === 1 ? `Follow-up due: ${truncate(due[0].title, 90)}` : `${plural(due.length, 'follow-up')} are due`,
    body: due.length === 1 ? due[0].detail || (due[0].meetingTitle ? `From “${due[0].meetingTitle}”` : '') : truncate(due.map((f) => f.title).join(' · '), 300),
    url: '/#/followups',
  });
  for (const f of due) run('UPDATE followups SET last_pinged_at = ? WHERE id = ?', nowIso(now), f.id);
  return due;
}

/* -------------------------------------------------------------------- loop */

let busy = false;
let lastCalendar = 0;
let timer = null;

export async function tick(now = new Date(), { forceCalendar = false } = {}) {
  if (busy) return;
  busy = true;
  const step = async (name, fn) => {
    try {
      await fn();
    } catch (err) {
      console.error(`[pinger] ${name} failed:`, err.message);
    }
  };
  try {
    await step('mail sync', () => syncAll({ now }));
    if (forceCalendar || now.getTime() - lastCalendar >= CALENDAR_EVERY_MS) {
      lastCalendar = now.getTime();
      await step('calendar refresh', async () => {
        await refreshCalendar(now);
        changed('events');
      });
    }
    await step('meeting prompts', () => meetingPrompts(now));
    await step('overview', () => scheduledOverview(now));
    await step('follow-up reminders', () => followupReminders(now));
  } finally {
    busy = false;
  }
}

export function startScheduler() {
  stopScheduler();
  timer = setInterval(() => tick(), TICK_MS);
  timer.unref?.();
  tick();
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Ask for a calendar refresh on the next tick (after adding an account or calendar link). */
export function calendarStale() {
  lastCalendar = 0;
}
