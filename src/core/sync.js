// Pull mail from a provider into the local store, then work out what each thread needs.

import { getAccount, ownAddresses, setAccountStatus } from '../accounts.js';
import { aiEnabled } from '../ai/client.js';
import { triageThreads } from '../ai/tasks.js';
import { all, get, run, tx } from '../db.js';
import { runtime } from '../events.js';
import { createProvider } from '../providers/index.js';
import { getSettings } from '../settings.js';
import { lower, nowIso, parseJson, safeLink, truncate } from '../util.js';
import { assignThreadKeys, automatedLevel, evaluateThread, isMeetingMessage, stripQuoted } from './triage.js';

const DAY = 86_400_000;
const BODY_LIMIT = 12_000;
const AI_BATCH = 8;
const AI_MAX_THREADS = 64;
const SUBJECT_PREFIX = /^\s*((re|fw|fwd|aw|sv|wg|tr|antw|rv)\s*(\[\d+\])?\s*:\s*)+/i;

const displaySubject = (s) => String(s || '').replace(SUBJECT_PREFIX, '').trim() || '(no subject)';

const inFlight = new Map();

/** Sync one account. Concurrent calls for the same account share one run. */
export function syncAccount(accountId, opts = {}) {
  if (inFlight.has(accountId)) return inFlight.get(accountId);
  const job = doSync(accountId, opts).finally(() => inFlight.delete(accountId));
  inFlight.set(accountId, job);
  return job;
}

async function doSync(accountId, { now = new Date(), provider } = {}) {
  const account = getAccount(accountId);
  if (!account) throw new Error('Account not found');
  const settings = getSettings();
  const since = new Date(now.getTime() - settings.sync.lookbackDays * DAY);
  const firstSync = !account.last_sync_at;
  const source = provider || createProvider(account);

  let result;
  try {
    const knownIds = new Set(
      all('SELECT provider_id FROM messages WHERE account_id = ? AND body IS NOT NULL', accountId).map((r) => r.provider_id),
    );
    result = await source.fetchMessages({ since, knownIds });
  } catch (err) {
    setAccountStatus(accountId, err.needsAuth ? 'needs_auth' : 'error', err.message);
    throw err;
  }

  const me = ownAddresses(account, settings);
  storeMessages(accountId, result, me, since, now);
  rebuildThreads(accountId, me);
  run("UPDATE accounts SET last_sync_at = ?, status = 'ok', status_detail = NULL WHERE id = ?", nowIso(now), accountId);

  let analysed = 0;
  if (aiEnabled()) {
    try {
      analysed = await enrichThreads(accountId, settings, now);
      runtime.aiError = null;
    } catch (err) {
      runtime.aiError = err.message; // the rule-based answer stands; surface why AI did not run
    }
  }

  // Don't fire individual pings for mail that was already urgent or overdue when the account was added —
  // the first overview covers it. Threads that become overdue later still get their nudge.
  if (firstSync) {
    const { urgent, nudges } = pingableThreads(now, settings);
    for (const t of [...urgent, ...nudges]) if (t.account_id === accountId) markPinged(t.id);
  }

  return { fetched: result.messages.length, complete: result.complete, analysed };
}

function storeMessages(accountId, result, me, since, now) {
  const known = new Map(
    all('SELECT message_id_header, thread_key FROM messages WHERE account_id = ? AND message_id_header IS NOT NULL', accountId).map(
      (r) => [r.message_id_header, r.thread_key],
    ),
  );
  assignThreadKeys(result.messages, known);

  tx(() => {
    const seen = new Set();
    for (const m of result.messages) {
      seen.add(m.providerId);
      const direction = m.folderHint === 'sent' || me.has(lower(m.from?.email)) ? 'out' : 'in';
      const hasBody = m.body !== undefined;
      run(
        `INSERT INTO messages (account_id, provider_id, thread_key, direction, from_name, from_email, to_json, cc_json,
           subject, body, sent_at, is_read, automated, is_meeting, importance, web_link, message_id_header)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id, provider_id) DO UPDATE SET
           thread_key = excluded.thread_key,
           direction = excluded.direction,
           is_read = excluded.is_read,
           importance = excluded.importance,
           web_link = COALESCE(excluded.web_link, messages.web_link),
           body = COALESCE(excluded.body, messages.body),
           automated = MAX(excluded.automated, messages.automated)`,
        accountId,
        m.providerId,
        m.threadKey,
        direction,
        m.from?.name || '',
        lower(m.from?.email),
        JSON.stringify(m.to || []),
        JSON.stringify(m.cc || []),
        m.subject || '',
        hasBody ? String(m.body).slice(0, BODY_LIMIT) : null,
        m.sentAt,
        m.isRead,
        direction === 'in' ? automatedLevel(m) : 0,
        isMeetingMessage(m),
        m.importance || 'normal',
        m.webLink || null,
        m.messageIdHeader || null,
      );
    }

    // Anything in the window that the mailbox no longer has was deleted or junked by the user.
    if (result.complete) {
      for (const row of all('SELECT id, provider_id FROM messages WHERE account_id = ? AND sent_at >= ?', accountId, since.toISOString())) {
        if (!seen.has(row.provider_id)) run('DELETE FROM messages WHERE id = ?', row.id);
      }
    }
    const keepDays = Math.max(90, getSettings().sync.lookbackDays * 3);
    run('DELETE FROM messages WHERE account_id = ? AND sent_at < ?', accountId, new Date(now.getTime() - keepDays * DAY).toISOString());
  });
}

const shapeMessage = (row) => ({
  id: row.id,
  direction: row.direction,
  from: { name: row.from_name, email: row.from_email },
  to: parseJson(row.to_json, []),
  cc: parseJson(row.cc_json, []),
  subject: row.subject,
  body: row.body || '',
  sentAt: row.sent_at,
  automated: row.automated,
  isMeeting: !!row.is_meeting,
  importance: row.importance,
});

export function rebuildThreads(accountId, me) {
  const groups = new Map();
  for (const row of all('SELECT * FROM messages WHERE account_id = ? ORDER BY sent_at, id', accountId)) {
    if (!groups.has(row.thread_key)) groups.set(row.thread_key, []);
    groups.get(row.thread_key).push(shapeMessage(row));
  }
  const existing = new Map(all('SELECT * FROM threads WHERE account_id = ?', accountId).map((t) => [t.thread_key, t]));

  tx(() => {
    for (const [key, messages] of groups) {
      const last = messages.at(-1);
      const verdict = evaluateThread(messages, { me });
      const prev = existing.get(key);
      const common = [
        displaySubject(messages[0].subject || last.subject),
        last.id,
        last.sentAt,
        last.direction,
        messages.length,
        verdict.candidate,
        verdict.score,
        JSON.stringify(verdict.reasons),
        verdict.counterpart?.name || '',
        verdict.counterpart?.email || '',
        verdict.waitingSince || last.sentAt,
      ];
      if (!prev) {
        run(
          `INSERT INTO threads (subject, last_message_id, last_at, last_direction, message_count, candidate, score, reasons,
             counterpart_name, counterpart_email, waiting_since, state, priority, account_id, thread_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ...common,
          verdict.state,
          verdict.priority,
          accountId,
          key,
        );
        continue;
      }
      run(
        `UPDATE threads SET subject = ?, last_message_id = ?, last_at = ?, last_direction = ?, message_count = ?,
           candidate = ?, score = ?, reasons = ?, counterpart_name = ?, counterpart_email = ?, waiting_since = ?
         WHERE id = ?`,
        ...common,
        prev.id,
      );
      // The AI's verdict stands for as long as it describes the thread's latest message.
      if (prev.ai_message_id !== last.id) {
        run("UPDATE threads SET state = ?, priority = ?, state_source = 'rules' WHERE id = ?", verdict.state, verdict.priority, prev.id);
      }
      // A new message reopens a thread the user had put away.
      if (prev.last_message_id !== last.id && prev.user_status !== 'open') {
        run("UPDATE threads SET user_status = 'open', snooze_until = NULL WHERE id = ?", prev.id);
      }
    }
    for (const [key, prev] of existing) if (!groups.has(key)) run('DELETE FROM threads WHERE id = ?', prev.id);
  });
}

/** Messages of a thread, oldest first, shaped for the AI: quoted text removed and length-capped. */
export function threadForAi(thread, limit = 3) {
  const rows = all(
    'SELECT * FROM messages WHERE account_id = ? AND thread_key = ? ORDER BY sent_at DESC, id DESC LIMIT ?',
    thread.account_id,
    thread.thread_key,
    limit,
  ).reverse();
  return rows.map((row, i) => {
    const isLast = i === rows.length - 1;
    const names = (json) => parseJson(json, []).map((r) => (r.name ? `${r.name} <${r.email}>` : r.email));
    return {
      sender: row.direction === 'out' ? 'user' : 'them',
      from: row.from_name ? `${row.from_name} <${row.from_email}>` : row.from_email,
      to: names(row.to_json),
      cc: names(row.cc_json),
      date: row.sent_at,
      text: truncate(stripQuoted(row.body), isLast ? 3000 : 900),
    };
  });
}

async function enrichThreads(accountId, settings, now) {
  const pending = all(
    `SELECT * FROM threads
     WHERE account_id = ? AND candidate = 1 AND (ai_message_id IS NULL OR ai_message_id != last_message_id)
     ORDER BY last_at DESC LIMIT ?`,
    accountId,
    AI_MAX_THREADS,
  );
  if (!pending.length) return 0;
  const account = getAccount(accountId);
  const profile = {
    name: settings.profile.name || account.name || '',
    emails: [...ownAddresses(account, settings)],
  };

  let analysed = 0;
  for (let i = 0; i < pending.length; i += AI_BATCH) {
    const batch = pending.slice(i, i + AI_BATCH);
    const byId = new Map(batch.map((t) => [t.id, t]));
    const payload = batch.map((t) => ({
      id: t.id,
      subject: t.subject,
      last_from: t.last_direction === 'out' ? 'user' : 'them',
      messages: threadForAi(t),
    }));
    const results = await triageThreads(payload, profile, now);
    for (const r of results) {
      const thread = byId.get(r.id);
      if (!thread) continue; // an id the model made up
      // The category has to agree with who actually spoke last.
      let state = 'none';
      if (r.category === 'needs_reply' && thread.last_direction === 'in') state = 'needs_reply';
      if (r.category === 'awaiting_reply' && thread.last_direction === 'out') state = 'awaiting_reply';
      const due = /^\d{4}-\d{2}-\d{2}$/.test(r.due || '') ? r.due : null;
      run(
        `UPDATE threads SET state = ?, state_source = 'ai', priority = ?, ai_message_id = ?, ai_summary = ?, ai_ask = ?,
           ai_next_step = ?, ai_due = ? WHERE id = ? AND last_message_id = ?`,
        state,
        ['high', 'medium', 'low'].includes(r.priority) ? r.priority : 'low',
        thread.last_message_id,
        truncate(r.summary, 600),
        truncate(r.ask, 600),
        truncate(r.next_step, 300),
        due,
        thread.id,
        thread.last_message_id,
      );
      analysed++;
    }
  }
  return analysed;
}

/**
 * Threads that deserve a ping of their own right now and have not had one for their latest message:
 * high-priority mail awaiting the user's reply, and threads where the other side has gone quiet.
 */
export function pingableThreads(now = new Date(), settings = getSettings()) {
  const fresh = "(t.pinged_message_id IS NULL OR t.pinged_message_id != t.last_message_id) AND t.user_status = 'open'";
  const cutoff = new Date(now.getTime() - settings.followups.awaitingDays * DAY).toISOString();
  return {
    urgent: all(`SELECT t.* FROM threads t WHERE t.state = 'needs_reply' AND t.priority = 'high' AND ${fresh} ORDER BY t.last_at DESC`),
    nudges: all(`SELECT t.* FROM threads t WHERE t.state = 'awaiting_reply' AND t.waiting_since <= ? AND ${fresh} ORDER BY t.waiting_since`, cutoff),
  };
}

export function markPinged(threadId) {
  run('UPDATE threads SET pinged_message_id = last_message_id WHERE id = ?', threadId);
}

/** Threads joined with the fields the UI and overview need. */
export function listThreads({ state, includeHandled = false, now = new Date() } = {}) {
  const rows = all(
    `SELECT t.*, a.email AS account_email, a.kind AS account_kind,
            m.body AS last_body, m.web_link AS web_link, m.from_name AS last_from_name, m.from_email AS last_from_email
     FROM threads t
     JOIN accounts a ON a.id = t.account_id
     LEFT JOIN messages m ON m.id = t.last_message_id
     WHERE t.state = ?`,
    state,
  );
  const nowStr = nowIso(now);
  const rank = { high: 0, medium: 1, low: 2 };
  return rows
    .map((t) => {
      const snoozed = t.user_status === 'snoozed' && t.snooze_until && t.snooze_until > nowStr;
      const status = t.user_status === 'snoozed' && !snoozed ? 'open' : t.user_status;
      return { ...t, status };
    })
    .filter((t) => includeHandled || t.status === 'open')
    .sort((a, b) => rank[a.priority] - rank[b.priority] || a.waiting_since.localeCompare(b.waiting_since));
}

export function publicThread(t, settings = getSettings(), now = new Date()) {
  const aiFresh = t.ai_message_id != null && t.ai_message_id === t.last_message_id;
  const waitingDays = (now.getTime() - new Date(t.waiting_since).getTime()) / DAY;
  return {
    id: t.id,
    account: t.account_email,
    subject: t.subject,
    state: t.state,
    status: t.status ?? t.user_status,
    snoozeUntil: t.snooze_until,
    priority: t.priority,
    source: t.state_source,
    reasons: parseJson(t.reasons, []),
    person: { name: t.counterpart_name, email: t.counterpart_email },
    waitingSince: t.waiting_since,
    overdue: t.state === 'awaiting_reply' && waitingDays >= settings.followups.awaitingDays,
    messageCount: t.message_count,
    summary: aiFresh ? t.ai_summary : null,
    ask: aiFresh ? t.ai_ask : null,
    nextStep: aiFresh ? t.ai_next_step : null,
    due: aiFresh ? t.ai_due : null,
    preview: truncate(stripQuoted(t.last_body || '').replace(/\s+/g, ' '), 220),
    webLink: safeLink(t.web_link),
  };
}

export function getThread(id) {
  return get(
    `SELECT t.*, a.email AS account_email, a.kind AS account_kind, m.body AS last_body, m.web_link AS web_link
     FROM threads t JOIN accounts a ON a.id = t.account_id LEFT JOIN messages m ON m.id = t.last_message_id
     WHERE t.id = ?`,
    id,
  );
}
