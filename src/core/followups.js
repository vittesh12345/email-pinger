import { all, get, run } from '../db.js';
import { HttpError, localDate, nowIso } from '../util.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function shape(row, now) {
  const today = localDate(now);
  const snoozed = !!row.snooze_until && row.snooze_until > nowIso(now);
  let dueState = 'none';
  if (row.due_on) dueState = row.due_on < today ? 'overdue' : row.due_on === today ? 'today' : 'upcoming';
  return {
    id: row.id,
    source: row.source,
    meetingId: row.meeting_id,
    meetingTitle: row.meeting_title || null,
    kind: row.kind,
    title: row.title,
    detail: row.detail || '',
    person: row.person || '',
    dueOn: row.due_on,
    dueState,
    status: row.status,
    snoozed,
    snoozeUntil: row.snooze_until,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

const SELECT = `SELECT f.*, m.title AS meeting_title FROM followups f LEFT JOIN meetings m ON m.id = f.meeting_id`;

export function listFollowups({ status = 'open', now = new Date() } = {}) {
  const rows =
    status === 'all'
      ? all(`${SELECT} ORDER BY f.id DESC LIMIT 500`)
      : all(`${SELECT} WHERE f.status = ? ORDER BY f.id DESC LIMIT 500`, status);
  const order = { overdue: 0, today: 1, upcoming: 2, none: 3 };
  return rows
    .map((r) => shape(r, now))
    .sort((a, b) => order[a.dueState] - order[b.dueState] || (a.dueOn || '').localeCompare(b.dueOn || '') || b.id - a.id);
}

/** Open, not snoozed, and due today or earlier. */
export function dueFollowups(now = new Date()) {
  return listFollowups({ status: 'open', now }).filter((f) => !f.snoozed && (f.dueState === 'overdue' || f.dueState === 'today'));
}

export function getFollowup(id, now = new Date()) {
  const row = get(`${SELECT} WHERE f.id = ?`, id);
  return row ? shape(row, now) : null;
}

function clean(input, { partial }) {
  const out = {};
  if (input.title != null || !partial) {
    const title = String(input.title || '').trim();
    if (!title) throw new HttpError(400, 'A follow-up needs a title');
    out.title = title.slice(0, 300);
  }
  if (input.detail != null) out.detail = String(input.detail).trim().slice(0, 2000);
  if (input.person != null) out.person = String(input.person).trim().slice(0, 200);
  if (input.kind != null) {
    if (!['todo', 'waiting'].includes(input.kind)) throw new HttpError(400, 'Unknown kind');
    out.kind = input.kind;
  }
  if (input.dueOn !== undefined) {
    if (input.dueOn !== null && input.dueOn !== '' && !DATE.test(input.dueOn)) throw new HttpError(400, 'dueOn must be YYYY-MM-DD');
    out.due_on = input.dueOn || null;
  }
  if (input.status != null) {
    if (!['open', 'done', 'dismissed'].includes(input.status)) throw new HttpError(400, 'Unknown status');
    out.status = input.status;
  }
  if (input.snoozeUntil !== undefined) {
    if (input.snoozeUntil && Number.isNaN(Date.parse(input.snoozeUntil))) throw new HttpError(400, 'Invalid snooze time');
    out.snooze_until = input.snoozeUntil ? new Date(input.snoozeUntil).toISOString() : null;
  }
  return out;
}

export function createFollowup(input, { source = 'manual', meetingId = null } = {}) {
  const f = clean(input, { partial: false });
  const { lastInsertRowid } = run(
    `INSERT INTO followups (source, meeting_id, kind, title, detail, person, due_on, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    source,
    meetingId,
    f.kind || 'todo',
    f.title,
    f.detail || '',
    f.person || '',
    f.due_on ?? null,
    nowIso(),
  );
  return getFollowup(Number(lastInsertRowid));
}

export function updateFollowup(id, input) {
  if (!get('SELECT id FROM followups WHERE id = ?', id)) throw new HttpError(404, 'Follow-up not found');
  const f = clean(input, { partial: true });
  if (f.status) {
    f.completed_at = f.status === 'open' ? null : nowIso();
    if (f.status !== 'open') f.snooze_until = null;
  }
  if ('due_on' in f || 'snooze_until' in f) f.last_pinged_at = null; // re-arm the reminder
  const keys = Object.keys(f);
  if (keys.length) {
    run(`UPDATE followups SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => f[k]), id);
  }
  return getFollowup(id);
}

export function deleteFollowup(id) {
  run('DELETE FROM followups WHERE id = ?', id);
}
