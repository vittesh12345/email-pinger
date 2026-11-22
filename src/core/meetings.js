// Meeting memory: store transcripts and notes, pull out what happened and what to follow up on,
// and answer questions about past meetings.

import { listAccounts } from '../accounts.js';
import { aiEnabled } from '../ai/client.js';
import { analyzeMeeting, answerFromMeetings } from '../ai/tasks.js';
import { all, get, run, tx } from '../db.js';
import { changed, runtime } from '../events.js';
import { getSettings } from '../settings.js';
import { HttpError, localDate, lower, nowIso, parseJson, truncate } from '../util.js';
import { createFollowup } from './followups.js';

const MAX_TRANSCRIPT = 1_500_000; // characters; roughly 20+ hours of talk
const GENERIC_TITLE = /^(untitled|new meeting|meeting|live meeting|meeting notes?|transcript)\b/i;

export function userProfile(settings = getSettings()) {
  const accounts = listAccounts();
  return {
    name: settings.profile.name || accounts.find((a) => a.name)?.name || '',
    emails: [...new Set([...accounts.map((a) => lower(a.email)), ...(settings.profile.emails || [])])],
  };
}

function shape(row, { full = false } = {}) {
  if (!row) return null;
  const base = {
    id: row.id,
    title: row.title,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    eventId: row.event_id,
    attendees: parseJson(row.attendees, []),
    source: row.source,
    status: row.status,
    summary: row.summary,
    analysisStatus: row.analysis_status,
    analysisError: row.analysis_error,
    hasTranscript: (row.transcript_length ?? row.transcript?.length ?? 0) > 0,
    openFollowups: row.open_followups ?? 0,
  };
  if (!full) return base;
  return { ...base, transcript: row.transcript, notes: row.notes, analysis: parseJson(row.analysis, null) };
}

export function listMeetings() {
  return all(
    `SELECT m.id, m.title, m.started_at, m.ended_at, m.event_id, m.attendees, m.source, m.status, m.summary,
            m.analysis_status, m.analysis_error, length(m.transcript) AS transcript_length,
            (SELECT COUNT(*) FROM followups f WHERE f.meeting_id = m.id AND f.status = 'open') AS open_followups
     FROM meetings m ORDER BY m.started_at DESC LIMIT 300`,
  ).map((r) => shape(r));
}

export function getMeeting(id) {
  return shape(get('SELECT * FROM meetings WHERE id = ?', id), { full: true });
}

function indexMeeting(id) {
  const m = get('SELECT * FROM meetings WHERE id = ?', id);
  run('DELETE FROM meetings_fts WHERE rowid = ?', id);
  if (!m) return;
  const a = parseJson(m.analysis, null);
  const digest = [
    m.summary,
    ...(a?.key_points || []),
    ...(a?.decisions || []),
    ...(a?.action_items || []).map((i) => `${i.owner}: ${i.task}`),
    ...(a?.open_questions || []),
  ]
    .filter(Boolean)
    .join('\n');
  run('INSERT INTO meetings_fts (rowid, title, summary, body) VALUES (?, ?, ?, ?)', id, m.title, digest, `${m.notes}\n${m.transcript}`);
}

const cleanAttendees = (list) =>
  (Array.isArray(list) ? list : [])
    .map((a) => (typeof a === 'string' ? a : a?.name || a?.email || ''))
    .map((s) => String(s).trim())
    .filter(Boolean)
    .slice(0, 100);

export function createMeeting(input) {
  const transcript = String(input.transcript || '');
  if (transcript.length > MAX_TRANSCRIPT) throw new HttpError(413, 'That transcript is too long for Pinger to store.');
  const startedAt = input.startedAt && !Number.isNaN(Date.parse(input.startedAt)) ? new Date(input.startedAt).toISOString() : nowIso();
  const { lastInsertRowid } = run(
    `INSERT INTO meetings (title, started_at, ended_at, event_id, attendees, source, status, transcript, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    String(input.title || '').trim().slice(0, 200) || 'Untitled meeting',
    startedAt,
    input.endedAt || null,
    input.eventId || null,
    JSON.stringify(cleanAttendees(input.attendees)),
    ['live', 'upload', 'paste'].includes(input.source) ? input.source : 'paste',
    input.status === 'live' ? 'live' : 'ready',
    transcript,
    String(input.notes || '').slice(0, 200_000),
    nowIso(),
  );
  const id = Number(lastInsertRowid);
  indexMeeting(id);
  return getMeeting(id);
}

export function updateMeeting(id, patch) {
  if (!get('SELECT id FROM meetings WHERE id = ?', id)) throw new HttpError(404, 'Meeting not found');
  const sets = {};
  if (patch.title != null) sets.title = String(patch.title).trim().slice(0, 200) || 'Untitled meeting';
  if (patch.transcript != null) {
    if (String(patch.transcript).length > MAX_TRANSCRIPT) throw new HttpError(413, 'That transcript is too long for Pinger to store.');
    sets.transcript = String(patch.transcript);
  }
  if (patch.notes != null) sets.notes = String(patch.notes).slice(0, 200_000);
  if (patch.attendees != null) sets.attendees = JSON.stringify(cleanAttendees(patch.attendees));
  if (patch.startedAt != null && !Number.isNaN(Date.parse(patch.startedAt))) sets.started_at = new Date(patch.startedAt).toISOString();
  if (patch.endedAt !== undefined) sets.ended_at = patch.endedAt ? new Date(patch.endedAt).toISOString() : null;
  if (patch.status != null && ['live', 'ready'].includes(patch.status)) sets.status = patch.status;
  const keys = Object.keys(sets);
  if (keys.length) {
    run(`UPDATE meetings SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => sets[k]), id);
    indexMeeting(id);
  }
  return getMeeting(id);
}

export function deleteMeeting(id) {
  tx(() => {
    run('DELETE FROM meetings_fts WHERE rowid = ?', id);
    run('DELETE FROM meetings WHERE id = ?', id); // its follow-ups cascade
  });
}

/* ---------------------------------------------------------------- analysis */

const COMMIT_RE =
  /\b(i['’]ll|i will|i can|i['’]m going to|i am going to|let me|i need to|i have to|we['’]ll|we will|we need to|action item|to-?do|follow[- ]up|will do|can you|could you|by (monday|tuesday|wednesday|thursday|friday|tomorrow|eod|end of (the )?(day|week|month)|next week))\b/i;
const FIRST_PERSON_RE = /\b(i['’]ll|i will|i can|i['’]m going to|i am going to|let me|i need to|i have to)\b/i;
const DECISION_RE = /\b(decided|agreed|let['’]s lock|let['’]s go with|we['’]ll go with|approved|signed off|final decision)\b/i;

/** No AI key: a best-effort scan for sentences that sound like commitments or decisions. */
export function ruleAnalysis(meeting, profile) {
  const myFirst = lower(profile.name).split(/\s+/)[0];
  const actionItems = [];
  const decisions = [];
  const text = `${meeting.notes || ''}\n${meeting.transcript || ''}`;
  for (const rawLine of text.split('\n')) {
    let line = rawLine.replace(/^\[[\d:]+\]\s*/, '').trim();
    if (!line) continue;
    let speaker = '';
    const named = /^([\p{L}][\p{L}\p{M}'’.\- ]{0,40}?):\s+(.+)$/u.exec(line);
    if (named) {
      speaker = named[1].trim();
      line = named[2];
    }
    for (const sentence of line.split(/(?<=[.!?])\s+/)) {
      const s = sentence.trim();
      if (s.length > 400 || s.split(/\s+/).length < 5) continue; // "I'll do that." says nothing on its own
      if (DECISION_RE.test(s) && decisions.length < 10) decisions.push(s);
      if (COMMIT_RE.test(s) && actionItems.length < 20) {
        const speakerIsMe = !!myFirst && lower(speaker).split(/\s+/)[0] === myFirst;
        const mine = FIRST_PERSON_RE.test(s) && (speakerIsMe || !speaker);
        actionItems.push({ owner: speaker || (mine ? 'You' : 'Unknown'), task: s, due: null, mine });
      }
    }
  }
  return {
    title: meeting.title,
    summary: null,
    key_points: [],
    decisions,
    action_items: actionItems,
    followups: actionItems
      .filter((i) => i.mine)
      .map((i) => ({ kind: 'todo', title: truncate(i.task, 110), detail: '', person: null, due: null })),
    open_questions: [],
  };
}

const validDate = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d || '') ? d : null);

function saveAnalysis(id, meeting, analysis) {
  tx(() => {
    const title = analysis.source === 'ai' && GENERIC_TITLE.test(meeting.title) && analysis.title?.trim() ? analysis.title.trim().slice(0, 200) : meeting.title;
    run(
      "UPDATE meetings SET title = ?, summary = ?, analysis = ?, analysis_status = 'done', analysis_error = NULL WHERE id = ?",
      title,
      analysis.summary || null,
      JSON.stringify(analysis),
      id,
    );
    // Replace follow-ups from an earlier analysis that the user has not acted on; keep the rest.
    run("DELETE FROM followups WHERE meeting_id = ? AND source = 'meeting' AND status = 'open'", id);
    const handled = new Set(all('SELECT title FROM followups WHERE meeting_id = ?', id).map((f) => lower(f.title)));
    for (const f of analysis.followups || []) {
      if (!f?.title?.trim() || handled.has(lower(f.title))) continue;
      createFollowup(
        { title: f.title, detail: f.detail || '', person: f.person || '', kind: f.kind === 'waiting' ? 'waiting' : 'todo', dueOn: validDate(f.due) },
        { source: 'meeting', meetingId: id },
      );
    }
    indexMeeting(id);
  });
}

export async function analyzeMeetingById(id) {
  const meeting = getMeeting(id);
  if (!meeting) throw new HttpError(404, 'Meeting not found');
  const profile = userProfile();
  const content = `${meeting.transcript}\n${meeting.notes}`.trim();

  if (content.length < 40) {
    saveAnalysis(id, meeting, {
      source: 'rules',
      title: meeting.title,
      summary: null,
      key_points: [],
      decisions: [],
      action_items: [],
      followups: [],
      open_questions: [],
      empty: true,
    });
    changed('meetings', 'followups');
    return getMeeting(id);
  }

  run("UPDATE meetings SET analysis_status = 'pending', analysis_error = NULL WHERE id = ?", id);
  changed('meetings');
  try {
    let analysis;
    if (aiEnabled()) {
      analysis = { ...(await analyzeMeeting(meeting, profile)), source: 'ai' };
      runtime.aiError = null;
    } else {
      analysis = { ...ruleAnalysis(meeting, profile), source: 'rules' };
    }
    saveAnalysis(id, meeting, analysis);
  } catch (err) {
    run("UPDATE meetings SET analysis_status = 'error', analysis_error = ? WHERE id = ?", err.message, id);
    runtime.aiError = err.message;
  }
  changed('meetings', 'followups');
  return getMeeting(id);
}

/* ------------------------------------------------------------------ memory */

const STOP = new Set(
  'a an and are as at be but by did do does for from had has have how i in is it me my of on or our that the their them they this to was we were what when where which who why will with you your about'.split(' '),
);

export function searchTerms(query) {
  return [...new Set((lower(query).match(/[\p{L}\p{N}]{2,}/gu) || []).filter((t) => !STOP.has(t)))].slice(0, 12);
}

export function searchMeetings(query, limit = 8) {
  const terms = searchTerms(query);
  if (!terms.length) return [];
  const match = terms.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ');
  try {
    return all(
      `SELECT m.id, m.title, m.started_at, m.summary,
              snippet(meetings_fts, 2, '', '', ' … ', 28) AS snippet
       FROM meetings_fts JOIN meetings m ON m.id = meetings_fts.rowid
       WHERE meetings_fts MATCH ? ORDER BY bm25(meetings_fts, 6.0, 3.0, 1.0) LIMIT ?`,
      match,
      limit,
    ).map((r) => ({ id: r.id, title: r.title, startedAt: r.started_at, summary: r.summary, snippet: r.snippet }));
  } catch {
    return [];
  }
}

/** Passages of a transcript around the places the search terms occur. */
function excerpts(text, terms, { max = 5, radius = 500 } = {}) {
  if (text.length <= 6000) return [text];
  const hay = lower(text);
  const spans = [];
  for (const term of terms) {
    let from = 0;
    while (spans.length < max * 3) {
      const at = hay.indexOf(term, from);
      if (at === -1) break;
      spans.push([Math.max(0, at - radius), Math.min(text.length, at + radius)]);
      from = at + radius;
    }
  }
  spans.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([...span]);
  }
  return merged.slice(0, max).map(([a, b]) => `…${text.slice(a, b)}…`);
}

function recordFor(m, terms, withExcerpts) {
  const a = parseJson(m.analysis, null);
  const lines = [`## ${m.title} — ${localDate(new Date(m.started_at))}`];
  if (m.summary) lines.push(`Summary: ${m.summary}`);
  if (a?.decisions?.length) lines.push(`Decisions:\n${a.decisions.map((d) => `- ${d}`).join('\n')}`);
  if (a?.action_items?.length) {
    lines.push(`Action items:\n${a.action_items.map((i) => `- ${i.owner}: ${i.task}${i.due ? ` (due ${i.due})` : ''}`).join('\n')}`);
  }
  if (a?.open_questions?.length) lines.push(`Open questions:\n${a.open_questions.map((q) => `- ${q}`).join('\n')}`);
  if (withExcerpts) {
    if (m.notes?.trim()) lines.push(`Notes:\n${truncate(m.notes.trim(), 3000)}`);
    const parts = excerpts(m.transcript || '', terms);
    if (parts.length && parts[0]) lines.push(`Transcript excerpts:\n${parts.join('\n')}`);
  }
  return lines.join('\n');
}

export async function askMeetings(question) {
  question = String(question || '').trim();
  if (!question) throw new HttpError(400, 'Ask a question first');
  const terms = searchTerms(question);
  const hits = searchMeetings(question, 6);
  if (!aiEnabled()) return { answer: null, sources: hits, needsAi: true };

  const hitIds = new Set(hits.map((h) => h.id));
  const detailed = hits.map((h) => get('SELECT * FROM meetings WHERE id = ?', h.id)).filter(Boolean);
  // Recent meetings give the model the timeline for questions like "what did I promise last week?"
  const recent = all('SELECT * FROM meetings ORDER BY started_at DESC LIMIT 12').filter((m) => !hitIds.has(m.id));
  if (!detailed.length && !recent.length) {
    return { answer: "You haven't saved any meetings yet, so there is nothing to search.", sources: [] };
  }
  const context = [
    ...detailed.map((m) => recordFor(m, terms, true)),
    ...recent.map((m) => recordFor(m, terms, false)),
  ].join('\n\n');
  const answer = await answerFromMeetings(question, context, userProfile());
  runtime.aiError = null;
  return { answer, sources: hits };
}
