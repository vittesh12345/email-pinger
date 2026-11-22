// The overview ("digest"): one snapshot of everything that needs the user, with a short briefing on top.

import { aiEnabled } from '../ai/client.js';
import { overviewBrief } from '../ai/tasks.js';
import { all, get, run } from '../db.js';
import { runtime } from '../events.js';
import { getSettings } from '../settings.js';
import { ago, localDate, nowIso, parseJson, plural, truncate } from '../util.js';
import { upcomingEvents } from './calendar.js';
import { dueFollowups, listFollowups } from './followups.js';
import { userProfile } from './meetings.js';
import { listThreads, publicThread } from './sync.js';

export function collectOverview(now = new Date()) {
  const settings = getSettings();
  const needsReply = listThreads({ state: 'needs_reply', now }).map((t) => publicThread(t, settings, now));
  const awaiting = listThreads({ state: 'awaiting_reply', now }).map((t) => publicThread(t, settings, now));
  const nudges = awaiting.filter((t) => t.overdue);
  const followupsDue = dueFollowups(now);
  const followupsOpen = listFollowups({ status: 'open', now }).filter((f) => !f.snoozed);
  const today = localDate(now);
  const meetings = upcomingEvents(now, 24).filter((e) => localDate(new Date(e.startAt)) === today);

  return {
    generatedAt: nowIso(now),
    counts: {
      needsReply: needsReply.length,
      highPriority: needsReply.filter((t) => t.priority === 'high').length,
      waiting: awaiting.length,
      nudges: nudges.length,
      followupsDue: followupsDue.length,
      followupsOpen: followupsOpen.length,
      meetingsToday: meetings.length,
    },
    needsReply: needsReply.slice(0, 30),
    nudges: nudges.slice(0, 20),
    followupsDue: followupsDue.slice(0, 20),
    meetings,
  };
}

/** The briefing when there is no AI key: plain, factual, built from the counts. */
export function ruleBrief(overview, settings = getSettings(), now = new Date()) {
  const { counts } = overview;
  if (!counts.needsReply && !counts.nudges && !counts.followupsDue) {
    return "You're all caught up — nothing is waiting on you right now.";
  }
  const parts = [];
  if (counts.needsReply) {
    let s = `${plural(counts.needsReply, 'email needs', 'emails need')} a reply`;
    if (counts.highPriority) s += `, ${counts.highPriority} of them high priority`;
    parts.push(`${s}.`);
    const oldest = [...overview.needsReply].sort((a, b) => a.waitingSince.localeCompare(b.waitingSince))[0];
    if (oldest) {
      parts.push(`The longest wait is ${oldest.person.name || oldest.person.email} (“${truncate(oldest.subject, 60)}”), ${ago(oldest.waitingSince, now)}.`);
    }
  }
  if (counts.nudges) {
    parts.push(
      `${plural(counts.nudges, "person hasn't", "people haven't")} replied to you in ${settings.followups.awaitingDays}+ days — worth a nudge.`,
    );
  }
  if (counts.followupsDue) parts.push(`${plural(counts.followupsDue, 'follow-up is', 'follow-ups are')} due.`);
  return parts.join(' ');
}

function compactForAi(overview, now) {
  return {
    need_your_reply: overview.needsReply.slice(0, 12).map((t) => ({
      from: t.person.name || t.person.email,
      subject: t.subject,
      priority: t.priority,
      waiting: ago(t.waitingSince, now),
      about: t.ask || t.summary || t.preview,
      due: t.due,
    })),
    waiting_on_others_overdue: overview.nudges.slice(0, 8).map((t) => ({
      to: t.person.name || t.person.email,
      subject: t.subject,
      waiting: ago(t.waitingSince, now),
      about: t.ask || t.summary || t.preview,
    })),
    followups_due: overview.followupsDue.slice(0, 10).map((f) => ({
      title: f.title,
      due: f.dueOn,
      person: f.person || undefined,
      from_meeting: f.meetingTitle || undefined,
      kind: f.kind === 'waiting' ? 'someone owes you this' : 'yours to do',
    })),
    meetings_today: overview.meetings.map((e) => ({ title: e.title, starts: e.startAt })),
  };
}

export function headline(counts) {
  const bits = [];
  if (counts.needsReply) bits.push(`${counts.needsReply} to reply`);
  if (counts.nudges) bits.push(`${counts.nudges} to nudge`);
  if (counts.followupsDue) bits.push(`${plural(counts.followupsDue, 'follow-up')} due`);
  return bits.length ? bits.join(' · ') : 'all caught up';
}

/**
 * Build and store an overview.
 * @param {{trigger: 'scheduled'|'manual', slot?: string|null, now?: Date}} opts
 */
export async function buildDigest({ trigger, slot = null, now = new Date() }) {
  const overview = collectOverview(now);
  const settings = getSettings();
  let brief = ruleBrief(overview, settings, now);
  let briefSource = 'rules';
  const hasWork = overview.counts.needsReply || overview.counts.nudges || overview.counts.followupsDue;
  if (aiEnabled() && hasWork) {
    try {
      const text = await overviewBrief(compactForAi(overview, now), userProfile(settings), now);
      if (text) {
        brief = text;
        briefSource = 'ai';
      }
      runtime.aiError = null;
    } catch (err) {
      runtime.aiError = err.message;
    }
  }
  const payload = { ...overview, brief, briefSource };
  const { lastInsertRowid } = run(
    'INSERT INTO digests (created_at, slot, trigger, payload) VALUES (?, ?, ?, ?)',
    nowIso(now),
    slot,
    trigger,
    JSON.stringify(payload),
  );
  run('DELETE FROM digests WHERE id <= ?', Number(lastInsertRowid) - 120);
  return { id: Number(lastInsertRowid), createdAt: nowIso(now), slot, trigger, ...payload };
}

const shape = (row) => (row ? { id: row.id, createdAt: row.created_at, slot: row.slot, trigger: row.trigger, ...parseJson(row.payload, {}) } : null);

export const latestDigest = () => shape(get('SELECT * FROM digests ORDER BY id DESC LIMIT 1'));
export const digestForSlot = (slot) => get('SELECT id FROM digests WHERE slot = ?', slot);
export const digestHistory = (limit = 20) =>
  all('SELECT * FROM digests ORDER BY id DESC LIMIT ?', limit).map((row) => {
    const d = shape(row);
    return { id: d.id, createdAt: d.createdAt, trigger: d.trigger, counts: d.counts, brief: d.brief };
  });
