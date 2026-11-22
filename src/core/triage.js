// Rule-based email triage. Pure functions, no I/O.
//
// These rules run for everyone, with or without an AI key. They (a) throw out obvious noise,
// (b) decide which threads are worth a closer look, and (c) give a usable answer on their own.
// When an AI key is configured, the AI gets the final say on the threads the rules flag.

import { lower } from '../util.js';

/* ------------------------------------------------------------------ text */

const QUOTE_MARKERS = [
  /^[ \t]*On\b[^\n]{5,200}(?:\n[^\n]{0,100})?\bwrote:[ \t]*$/m, // Gmail / Apple Mail
  /^[ \t]*-{2,}[ \t]*Original Message[ \t]*-{2,}[ \t]*$/im,
  /^[ \t]*-{2,}[ \t]*Forwarded message[ \t]*-{2,}/im,
  /^[ \t]*From:[ \t].+\n(?:.*\n){0,3}?[ \t]*(?:Sent|Date):[ \t].+/im, // Outlook header block
  /^[ \t]*_{20,}[ \t]*$/m, // Outlook divider
  /^-- $/m, // signature delimiter
];

/** The part of a message its author actually wrote: no quoted replies, no signature block. */
export function stripQuoted(text) {
  const original = String(text || '').replace(/\r\n?/g, '\n');
  let cut = original.length;
  for (const re of QUOTE_MARKERS) {
    const m = re.exec(original);
    if (m && m.index < cut) cut = m.index;
  }
  const kept = original
    .slice(0, cut)
    .split('\n')
    .filter((line) => !/^\s*>/.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  // A message that is nothing but a forward/quote: keep the original so it isn't read as empty.
  return kept || original.trim();
}

const SUBJECT_PREFIX = /^\s*((re|fw|fwd|aw|sv|wg|tr|antw|rv)\s*(\[\d+\])?\s*:\s*)+/i;

export function normalizeSubject(subject) {
  return String(subject || '').replace(SUBJECT_PREFIX, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

const isReplySubject = (subject) => SUBJECT_PREFIX.test(String(subject || ''));

/* ------------------------------------------------------------- automated */

const STRONG_LOCAL =
  /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|mailer[-_.]?daemon|postmaster|bounces?|notifications?|notify|newsletters?|digest|alerts?|marketing|promo(tions)?|receipts?|automated|auto[-_.]?confirm|mailer)([-+_.].*)?$/i;
const WEAK_LOCAL =
  /^(news|updates?|info|hello|hi|team|support|help|billing|invoices?|sales|contact|admin|service|accounts?|orders?|shipping|security|welcome|community|events?|jobs|careers|feedback|surveys?|announce(ments?)?|email|e-mail)([-+_.].*)?$/i;
const BULK_SUBDOMAIN = /@(e|em|mail|email|news|newsletter|notifications?|mailer|bounce|mktg|marketing|info|reply|updates)\d*\./i;
const BULK_BODY =
  /\bunsubscribe\b|manage (your )?(email |notification )?preferences|view (this )?(email|message) in (your |a )?browser|you(['’]re| are) receiving this (e-?mail|message)|do not reply to this (e-?mail|message)|this is an automated|automatically generated|auto-generated (e-?mail|message)/i;
const MEETING_SUBJECT =
  /^\s*(accepted|declined|tentative(ly accepted)?|cancell?ed|updated invitation|invitation|new event|meeting forward notification|proposed new time)\s*:/i;

/**
 * 0 = looks like a person, 1 = probably automated, 2 = automated.
 * @param {{from?: {email?: string}, body?: string, headers?: object, focused?: boolean}} msg
 */
export function automatedLevel(msg) {
  const email = lower(msg.from?.email);
  const local = email.split('@')[0] || '';
  const h = msg.headers || {};
  if (h.listUnsubscribe || h.autoSubmitted || h.precedence === 'bulk' || h.precedence === 'junk') return 2;
  if (STRONG_LOCAL.test(local)) return 2;
  if (BULK_BODY.test(String(msg.body || '').slice(0, 20000))) return 2;
  if (h.precedence === 'list') return 1;
  if (WEAK_LOCAL.test(local) || BULK_SUBDOMAIN.test(email)) return 1;
  if (msg.focused === false) return 1; // Outlook filed it under "Other"
  return 0;
}

export function isAutomatedAddress(email) {
  const local = lower(email).split('@')[0] || '';
  return STRONG_LOCAL.test(local);
}

export function isMeetingMessage(msg) {
  return !!msg.isMeetingMessage || MEETING_SUBJECT.test(String(msg.subject || ''));
}

/* ------------------------------------------------------------ ask signals */

const REQUEST_RE =
  /\b(can|could|would|will) you\b|\bplease\b|\bpls\b|\blet me know\b|\bget back to me\b|\bwhat do you think\b|\byour thoughts\b|\bthoughts on\b|\bare you (able|available|free|ok|okay|around)\b|\bdo you (have|know|think|want|need|mind)\b|\bneeds? your\b|\bneed you to\b|\bwaiting (on|for) you\b|\bconfirm\b|\bapprov(e|al)\b|\bsign[- ]?off\b|\brsvp\b|\bsend (me|us|over|it)\b|\bfollowing up\b|\bfollow[- ]up\b|\bcircling back\b|\bchecking in\b|\breminder\b|\bany updates?\b/i;
const URGENT_RE =
  /\b(asap|urgent(ly)?|time[- ]sensitive|as soon as (possible|you can)|deadline|overdue|by (eod|cob|end of (the )?day|tomorrow|tonight|noon|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week|this week|the end of the week))\b/i;
const ACK_RE =
  /^(hi[^\n,]{0,30},?\s+)?(thanks|thank you|thx|ty|many thanks|got it|sounds good|sounds great|perfect|great|awesome|will do|noted|ok|okay|cheers|appreciate it|much appreciated|you(['’]re| are) welcome|no problem|no worries|np|done|received|👍)\b/i;

/** What a message's own text asks of its reader. */
export function askSignals(text) {
  const t = String(text || '').replace(/https?:\/\/\S+/g, ' ');
  const question = /\?(\s|$|["')\]])/.test(t);
  const request = REQUEST_RE.test(t);
  const urgent = URGENT_RE.test(t);
  const ackOnly = t.trim().length <= 160 && ACK_RE.test(t.trim()) && !question;
  return { question, request, urgent, ackOnly };
}

/* ---------------------------------------------------------------- threads */

/**
 * Give every message a stable thread key. Providers with native conversation ids (Outlook,
 * Gmail) supply `threadKey` themselves; for plain IMAP the key is derived from the
 * Message-ID / In-Reply-To / References headers, with a subject fallback for replies that
 * arrive without those headers.
 *
 * @param {Array<object>} messages  mutated in place
 * @param {Map<string, string>} known  Message-ID header -> thread key, for messages stored earlier
 */
export function assignThreadKeys(messages, known = new Map()) {
  const parent = new Map();
  const find = (x) => {
    if (!parent.has(x)) parent.set(x, x);
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root);
    while (parent.get(x) !== root) {
      const next = parent.get(x);
      parent.set(x, root);
      x = next;
    }
    return root;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  };

  const pending = messages.filter((m) => !m.threadKey);
  const selfId = (m) => m.messageIdHeader || `pid:${m.providerId}`;
  const bySubject = new Map();

  for (const m of pending) {
    const self = selfId(m);
    find(self);
    for (const ref of [m.inReplyTo, ...(m.references || [])]) if (ref) union(self, ref);
    const subject = normalizeSubject(m.subject);
    if (subject.length >= 4 && !bySubject.has(subject)) bySubject.set(subject, self);
  }
  for (const m of pending) {
    const hasRefs = !!m.inReplyTo || (m.references || []).length > 0;
    if (hasRefs || !isReplySubject(m.subject)) continue;
    const other = bySubject.get(normalizeSubject(m.subject));
    if (other) union(selfId(m), other);
  }

  // A component that touches an already-stored thread keeps that thread's key.
  const adopted = new Map();
  for (const id of [...parent.keys()].sort()) {
    if (!known.has(id)) continue;
    const root = find(id);
    if (!adopted.has(root)) adopted.set(root, known.get(id));
  }
  for (const m of pending) {
    const root = find(selfId(m));
    m.threadKey = adopted.get(root) || `t:${root}`;
  }
  return messages;
}

/* --------------------------------------------------------------- evaluate */

const NONE = { state: 'none', candidate: false, score: 0, priority: 'low', reasons: [] };

/**
 * Decide what a thread needs from the user.
 *
 * @param {Array<object>} messages  the thread, oldest first. Each: {direction, from, to, cc,
 *   body, sentAt, automated, isMeeting, importance}
 * @param {{me: Set<string>}} ctx  the user's own addresses (lower-case)
 */
export function evaluateThread(messages, ctx) {
  const last = messages.at(-1);
  if (!last) return { ...NONE };
  const isMe = (e) => ctx.me.has(lower(e));
  const base = { ...NONE, waitingSince: last.sentAt };
  const text = stripQuoted(last.body);
  const sig = askSignals(text);

  if (last.direction === 'in') {
    const counterpart = { name: last.from?.name || '', email: lower(last.from?.email) };
    if (last.automated >= 2 || last.isMeeting) return { ...base, counterpart };

    const to = (last.to || []).map((r) => lower(r.email));
    const cc = (last.cc || []).map((r) => lower(r.email));
    const inTo = to.some(isMe);
    const inCc = cc.some(isMe);
    const reasons = [];
    let score = 35;

    if (inTo && to.length === 1 && cc.length === 0) {
      score += 15;
      reasons.push('sent only to you');
    } else if (inTo) {
      score += 5;
    } else if (inCc) {
      score -= 25;
      reasons.push("you're only cc'd");
    } else {
      score -= 20;
    }
    if (sig.question) {
      score += 25;
      reasons.push('asks a question');
    }
    if (sig.request) {
      score += 15;
      reasons.push('asks for something');
    }
    if (sig.urgent) {
      score += 10;
      reasons.push('time-sensitive');
    }
    if (last.importance === 'high') {
      score += 10;
      reasons.push('marked important');
    }
    if (sig.ackOnly) score -= 45;
    if (to.length + cc.length > 6) score -= 10;
    if (last.automated === 1) score -= 20;
    if (messages.some((m) => m.direction === 'out')) score += 5; // an ongoing conversation

    // Without AI, "high" is reserved for explicit signals: a stated deadline or an importance flag.
    const flagged = sig.urgent || last.importance === 'high';
    const priority = flagged && score >= 60 ? 'high' : score >= 65 ? 'medium' : 'low';
    return {
      ...base,
      state: score >= 50 ? 'needs_reply' : 'none',
      candidate: score >= 20,
      score,
      priority,
      reasons,
      counterpart,
    };
  }

  // The user wrote last: are they waiting on someone?
  const recipients = [...(last.to || []), ...(last.cc || [])].filter((r) => r.email && !isMe(r.email));
  const people = recipients.filter((r) => !isAutomatedAddress(r.email));
  const first = people[0] || recipients[0];
  const counterpart = { name: first?.name || '', email: lower(first?.email) };
  if (!people.length || last.isMeeting) return { ...base, counterpart };

  const reasons = [];
  let score = 30;
  if (sig.question) {
    score += 30;
    reasons.push('you asked a question');
  }
  if (sig.request) {
    score += 20;
    reasons.push('you asked for something');
  }
  if (sig.urgent) score += 10;
  if (sig.ackOnly) score -= 45;

  return {
    ...base,
    state: score >= 50 ? 'awaiting_reply' : 'none',
    candidate: !sig.ackOnly,
    score,
    priority: sig.urgent ? 'high' : score >= 70 ? 'medium' : 'low',
    reasons,
    counterpart,
  };
}

/** Whether a "waiting on them" thread has been quiet long enough to nudge. */
export function isOverdue(waitingSince, awaitingDays, now = new Date()) {
  if (!waitingSince) return false;
  return now.getTime() - new Date(waitingSince).getTime() >= awaitingDays * 86_400_000;
}
