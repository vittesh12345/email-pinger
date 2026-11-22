// Interprets what Pinger's browser extension reads off Outlook on the web.
//
// The extension (extension/outlook-reader.js) sends only raw text from the page: the message-list
// rows Outlook has drawn and the conversation open in the reading pane. Every guess about what
// that text means — sender, subject, dates, who wrote what — is made here, where it can be tested.

import crypto from 'node:crypto';
import { normalizeName, normalizeSubject } from './triage.js';

export const OUTLOOK_HOSTS = new Set(['outlook.office.com', 'outlook.office365.com', 'outlook.live.com', 'outlook.cloud.microsoft']);

const DAY = 86_400_000;
const EMAIL = /[A-Z0-9._%+'-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/i;
const EN_WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const EN_MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_RE = EN_MONTHS.map((m) => m.slice(0, 3)).join('|');
const AUTOMATED_NAME = /\b(no[- ]?reply|do[- ]?not[- ]?reply|notifications?|newsletter|mailer[- ]daemon|postmaster)\b/i;
const ROW_NOISE = /^(\(?\d{1,3}\)?|[!•·*]+|draft|\[draft\]|external|extern|new|has attachments?|attachment)$/i;

const TO_LABEL = /^(to|an|à|a|para|aan|til|till|do)\s*:\s*/i;
const CC_LABEL = /^(cc|kopie|copie)\s*:\s*/i;
const FROM_LABEL = /^(from|von|de|da|van)\s*:\s*/i;
const BARE_LABEL = /^(to|an|à|a|para|aan|til|till|do|cc|kopie|copie|from|von|de|da|van)\s*:?$/i;

export const hash = (...parts) => crypto.createHash('sha1').update(parts.map(String).join('\u0001')).digest('hex').slice(0, 16);
const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* ------------------------------------------------------------------ dates */

function weekdayNames(locale) {
  const out = [];
  const add = (list) =>
    (Array.isArray(list) ? list : []).slice(0, 7).forEach((n, i) => {
      const k = squash(n).toLowerCase().replace(/\.$/, '');
      if (k) out.push([k, i]);
    });
  add(locale.weekdaysLong);
  add(locale.weekdays);
  EN_WEEKDAYS.forEach((n, i) => out.push([n, i], [n.slice(0, 3), i]));
  return out.sort((a, b) => b[0].length - a[0].length);
}

/**
 * Read a date as Outlook on the web writes it: "9:42 AM", "Fri 3:15 PM", "11/14", "Sat 11/21/2026 11:42 PM",
 * "17.11.2026", "Yesterday", "November 22, 2026" … Times are local to this computer.
 *
 * @param {string} text
 * @param {{locale?: {order?: string, weekdays?: string[], weekdaysLong?: string[], yesterday?: string, today?: string}, now?: Date}} ctx
 * @returns {{date: Date, precision: 'minute'|'day', explicit: boolean, residue: string} | null}
 *   `residue` is whatever text was left over; a real date label leaves (almost) nothing.
 */
export function parseOwaDate(text, { locale = {}, now = new Date() } = {}) {
  const raw = squash(text);
  if (!raw || raw.length > 80) return null;
  let s = ` ${raw.toLowerCase()} `;
  const cut = (m) => {
    s = `${s.slice(0, m.index)} ${s.slice(m.index + m[0].length)}`;
  };

  let hours = null;
  let minutes = null;
  const tm = /(\d{1,2}):(\d{2})(?::\d{2})?(?:\s*([ap])\.?\s*m\b\.?)?/.exec(s);
  if (tm) {
    hours = Number(tm[1]);
    minutes = Number(tm[2]);
    const pm = tm[3] === 'p' || /下午|오후/.test(s);
    const am = tm[3] === 'a' || /上午|오전/.test(s);
    if (pm && hours < 12) hours += 12;
    if (am && hours === 12) hours = 0;
    if (hours > 23 || minutes > 59) return null;
    cut(tm);
    s = s.replace(/下午|上午|오후|오전/g, ' ');
  }

  let year = null;
  let month = null;
  let day = null;
  let m;
  if ((m = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s))) {
    year = +m[1];
    month = +m[2];
    day = +m[3];
    cut(m);
  } else if ((m = /(?<!\d)(\d{1,2})[./-](\d{1,2})(?:[./-](\d{4}|\d{2}))?\.?/.exec(s))) {
    const order = String(locale.order || 'MDY').toUpperCase();
    const a = +m[1];
    const b = +m[2];
    if (order.indexOf('D') < order.indexOf('M')) [day, month] = [a, b];
    else [month, day] = [a, b];
    if (month > 12 && day <= 12) [month, day] = [day, month];
    if (m[3]) year = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    cut(m);
  } else {
    // (?!\\d): a day is one or two digits, never the start of a year.
    const a = new RegExp(`\\b(${MONTH_RE})[a-z]*\\.?\\s+(\\d{1,2})(?!\\d)(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?`).exec(s);
    const b = !a && new RegExp(`(?<!\\d)(\\d{1,2})\\.?\\s+(${MONTH_RE})[a-z]*\\.?(?:,?\\s+(\\d{4}))?`).exec(s);
    if (a) {
      month = EN_MONTHS.findIndex((x) => x.startsWith(a[1])) + 1;
      day = +a[2];
      if (a[3]) year = +a[3];
      cut(a);
    } else if (b) {
      day = +b[1];
      month = EN_MONTHS.findIndex((x) => x.startsWith(b[2])) + 1;
      if (b[3]) year = +b[3];
      cut(b);
    }
  }

  let relative = null;
  for (const [words, offset] of [
    [[locale.yesterday, 'yesterday'], -1],
    [[locale.today, 'today'], 0],
  ]) {
    if (relative !== null) break;
    for (const w of words.map((x) => squash(x).toLowerCase()).filter(Boolean)) {
      if (s.includes(w)) {
        relative = offset;
        s = s.replace(w, ' ');
        break;
      }
    }
  }

  let weekday = null;
  for (const [name, idx] of weekdayNames(locale)) {
    const wm = new RegExp(`(^|[\\s,])${escapeRe(name)}\\.?(?=$|[\\s,])`).exec(s);
    if (wm) {
      weekday = idx;
      cut(wm);
      break;
    }
  }

  const residue = s.replace(/[\s,.\-/|()]+/g, '');
  if (hours === null && month === null && weekday === null && relative === null) return null;

  const hasTime = hours !== null;
  const at = (base) => {
    const d = new Date(base);
    if (hasTime) d.setHours(hours, minutes, 0, 0);
    else d.setHours(12, 0, 0, 0);
    return d;
  };
  let date;
  if (month !== null) {
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const y = year ?? now.getFullYear();
    let base = new Date(y, month - 1, day);
    if (base.getMonth() !== month - 1) return null; // e.g. 31 November
    if (year === null && base.getTime() > now.getTime() + DAY) base = new Date(y - 1, month - 1, day);
    date = at(base);
  } else if (relative !== null) {
    const base = new Date(now);
    base.setDate(base.getDate() + relative);
    date = at(base);
  } else if (weekday !== null) {
    // Outlook labels today's mail with a time only, so a weekday always means an earlier day.
    const base = new Date(now);
    base.setDate(base.getDate() - ((now.getDay() - weekday + 7) % 7 || 7));
    date = at(base);
  } else {
    date = at(now);
    if (date.getTime() > now.getTime() + 5 * 60_000) date.setDate(date.getDate() - 1);
  }
  if (!hasTime && date.getTime() > now.getTime()) date = new Date(now);
  return { date, precision: hasTime ? 'minute' : 'day', explicit: month !== null, residue };
}

const rank = (p) => (p.precision === 'minute' ? 2 : 1) + (p.explicit ? 1 : 0);

/** A date label on its own, not a sentence that happens to contain a time. */
function asDateLabel(text, ctx) {
  const p = parseOwaDate(text, ctx);
  return p && p.residue.length <= 3 ? p : null;
}

function bestDate(texts, ctx) {
  let best = null;
  for (const t of texts) {
    const p = asDateLabel(t, ctx);
    if (p && (!best || rank(p) > rank(best))) best = p;
  }
  return best;
}

/* ----------------------------------------------------------------- people */

const cleanName = (s) => squash(s).replace(/^["']+|["']+$/g, '');

/** "Priya Raman <priya@x.com>", "priya@x.com", "Priya Raman (3)", "Jordan Kim; Alex" → one person. */
export function person(text) {
  let s = squash(text).replace(/\s*\(\d+\)$/, '');
  if (s.includes(';')) s = s.split(';')[0].trim();
  const angle = /^(.*?)\s*<\s*([^<>\s]+@[^<>\s]+)\s*>$/.exec(s);
  if (angle) return { name: cleanName(angle[1]), email: angle[2].toLowerCase() };
  const bare = EMAIL.exec(s);
  if (bare && bare[0].length >= s.length - 2) return { name: '', email: bare[0].toLowerCase() };
  return { name: cleanName(s), email: '' };
}

function people(text) {
  const s = squash(text).replace(/[;,]$/, '');
  if (!s) return [];
  let parts = [s];
  if (s.includes(';')) parts = s.split(';');
  else if ((s.match(/<[^>]+>/g) || []).length > 1) parts = s.split(/(?<=>)\s*,\s*/);
  return parts
    .map(person)
    .filter((p) => p.name || p.email)
    .filter((p) => !/^\+?\d+\s+(more|others?)$/i.test(p.name));
}

/* ------------------------------------------------------------------- page */

/** The signed-in person, from a tab title like "Mail - Vittesh Maganti - Outlook". */
export function ownerFromTitle(title) {
  const parts = squash(title)
    .replace(/^\(\d+\)\s*/, '')
    .split(/\s+[-–—|]\s+/)
    .filter(Boolean);
  if (parts.length < 3 || !/outlook/i.test(parts.at(-1))) return { name: '', email: '' };
  const who = parts.at(-2);
  const email = EMAIL.exec(who)?.[0];
  return email ? { name: '', email: email.toLowerCase() } : { name: who, email: '' };
}

/**
 * Which kind of folder the page shows, from its address (the same in every language) with the
 * selected folder's name as a fallback. 'skip' covers Junk, Deleted, Drafts and non-mail pages.
 */
export function folderKind({ path = '', label = '' } = {}) {
  const p = String(path).toLowerCase();
  if (!/^\/mail(\/|$)/.test(p)) return 'skip';
  if (/\/(sentitems|sent)(\/|$)/.test(p)) return 'sent';
  if (/\/(junkemail|junk|deleteditems|deleted|drafts|outbox|scheduled)(\/|$)/.test(p)) return 'skip';
  if (/\/inbox(\/|$)/.test(p) || /^\/mail(\/0)?\/?$/.test(p)) return 'inbox';
  const l = String(label).toLowerCase();
  if (/^sent\b/.test(l)) return 'sent';
  if (/^(junk|deleted|drafts?|outbox)\b/.test(l)) return 'skip';
  if (/^inbox\b/.test(l)) return 'inbox';
  return 'other';
}

/**
 * One row of the message list. Outlook draws each row as separate lines — sender, subject, time,
 * preview — so: drop the date and badge lines, then read the rest in order.
 */
export function parseRow(raw, ctx) {
  const lines = (raw.lines || []).map(squash).filter(Boolean);
  const titles = (raw.titles || []).map(squash).filter(Boolean);
  const when = bestDate([...titles, ...lines], ctx);
  const content = lines.filter((l) => !asDateLabel(l, ctx) && !ROW_NOISE.test(l));
  const sender = person(content[0] || '');
  if (!sender.email) {
    const email = titles.map((t) => EMAIL.exec(t)?.[0]).find(Boolean);
    if (email) sender.email = email.toLowerCase();
  }
  return {
    sender,
    subject: content[1] || '',
    preview: content.slice(2).join(' '),
    when,
    unread: /\bunread\b/i.test(raw.aria || ''),
  };
}

/** One message in the open conversation: a header block of text, plus its body. */
export function parseOpenMessage(raw, ctx) {
  const lines = String(raw.header || '')
    .split('\n')
    .map(squash)
    .filter(Boolean)
    .slice(0, 60);
  const extras = [...(raw.titles || []), ...(raw.labels || [])].map(squash).filter(Boolean);
  const looksLikePerson = (l) => l.length <= 80 && !/[?:]/.test(l) && !asDateLabel(l, ctx);

  // Recipients: "To: a; b" on one line, or "To:" with one name per following line.
  let to = null;
  let cc = null;
  const rest = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isTo = TO_LABEL.test(line) || /^(to|an|à|a|para|aan|til|till|do)\s*:?$/i.test(line);
    const isCc = !isTo && (CC_LABEL.test(line) || /^(cc|kopie|copie)\s*:?$/i.test(line));
    if (!isTo && !isCc) {
      rest.push(line);
      continue;
    }
    const list = [];
    const inline = line.replace(isTo ? TO_LABEL : CC_LABEL, '').replace(BARE_LABEL, '');
    if (inline) list.push(...people(inline));
    else {
      while (i + 1 < lines.length && list.length < 50) {
        const next = lines[i + 1];
        if (TO_LABEL.test(next) || CC_LABEL.test(next) || BARE_LABEL.test(next) || !looksLikePerson(next)) break;
        list.push(...people(next));
        i++;
      }
    }
    if (isTo) to = [...(to || []), ...list];
    else cc = [...(cc || []), ...list];
  }

  let from = { name: '', email: '' };
  for (const l of [...rest, ...extras]) {
    const m = /^(.*?)\s*<\s*([^<>\s]+@[^<>\s]+)\s*>/.exec(l.replace(FROM_LABEL, ''));
    if (m) {
      from = { name: cleanName(m[1]), email: m[2].toLowerCase() };
      break;
    }
  }
  if (!from.email && !from.name) {
    const first = rest.find((l) => looksLikePerson(l) && !BARE_LABEL.test(l) && !EMAIL.test(l)) || '';
    from = { name: cleanName(first.replace(FROM_LABEL, '')), email: '' };
  }
  if (!from.email) {
    const taken = new Set([...(to || []), ...(cc || [])].map((p) => p.email).filter(Boolean));
    const email = [...rest, ...extras].map((x) => EMAIL.exec(x)?.[0]?.toLowerCase()).find((e) => e && !taken.has(e));
    if (email) from.email = email;
  }

  return {
    from,
    to,
    cc: cc ?? (to ? [] : null),
    when: bestDate([...rest, ...extras], ctx),
    body: String(raw.body || '').trim(),
  };
}

/* ------------------------------------------------------------ to messages */

/**
 * Everything a snapshot shows, as items: one per visible list row ("L"), one per message in the
 * open conversation ("P"). Items carry what a provider message needs, plus `origin`, `precision`
 * (how much of the date was known) and `subjectKey` for matching threads later.
 *
 * @param {object} snap  a cleaned snapshot (see cleanSnapshot)
 * @param {{now?: Date, me: {email: string, name: string, names: Set<string>}}} ctx
 */
export function snapshotToItems(snap, { now = new Date(), me }) {
  const kind = folderKind(snap.folder);
  if (kind === 'skip') return [];
  const ctx = { locale: snap.locale || {}, now };
  let webLink = null;
  try {
    const u = new URL(snap.url);
    if (OUTLOOK_HOSTS.has(u.hostname)) webLink = `${u.origin}/mail/`;
  } catch {
    /* no link */
  }
  const isMe = (p) => (!!p.email && p.email === me.email) || (!!p.name && me.names.has(normalizeName(p.name)));
  const asMe = (name) => ({ name: name || me.name || '', email: me.email || '' });
  const keyFor = (convId, subject) => (convId ? `w:${hash(convId)}` : `w:s:${hash(normalizeSubject(subject))}`);
  const common = (subject) => ({ subject: squash(subject), subjectKey: normalizeSubject(subject), importance: 'normal', webLink });
  const items = [];

  for (const raw of snap.rows || []) {
    const r = parseRow(raw, ctx);
    if (!r.subject && !r.sender.name && !r.sender.email) continue;
    const threadKey = keyFor(raw.convId, r.subject);
    const fromMe = kind === 'sent' || isMe(r.sender);
    const shown = r.sender; // in Sent Items, the row shows who it went to
    items.push({
      ...common(r.subject),
      origin: 'list',
      providerId: `L:${hash(threadKey, kind === 'sent' ? 'to' : 'from', normalizeName(shown.name), shown.email, squash(r.preview).toLowerCase().slice(0, 300))}`,
      threadKey,
      from: fromMe ? asMe(kind === 'sent' ? '' : shown.name) : shown,
      to: kind === 'sent' ? [shown] : null,
      cc: kind === 'sent' ? [] : null,
      body: r.preview,
      sentAt: (r.when?.date || now).toISOString(),
      precision: r.when?.precision || 'guess',
      isRead: !r.unread,
      folderHint: fromMe ? 'sent' : 'inbox',
      headers: fromMe ? {} : { autoSubmitted: AUTOMATED_NAME.test(shown.name) },
    });
  }

  const open = snap.open;
  if (open?.messages?.length) {
    const selected = (snap.rows || []).find((r) => r.selected);
    const subject = squash(open.subject) || (selected ? parseRow(selected, ctx).subject : '');
    const threadKey = keyFor(selected?.convId, subject);
    open.messages.forEach((raw, i) => {
      const m = parseOpenMessage(raw, ctx);
      if (!m.body && !m.from.name && !m.from.email) return;
      const fromMe = isMe(m.from);
      items.push({
        ...common(subject),
        origin: 'pane',
        // Not tied to the thread key: the same open message must get the same id whether or not
        // its list row happens to be on screen (and so whether its conversation id is known).
        providerId: `P:${hash(normalizeSubject(subject), normalizeName(m.from.name), m.from.email, squash(m.body).toLowerCase().slice(0, 300))}`,
        threadKey,
        from: fromMe ? asMe(m.from.name) : m.from,
        to: m.to,
        cc: m.cc,
        body: m.body,
        // Undated messages: Outlook lists the newest first by default.
        sentAt: (m.when?.date || new Date(now.getTime() - i * 1000)).toISOString(),
        precision: m.when?.precision || 'guess',
        isRead: true,
        folderHint: fromMe ? 'sent' : 'inbox',
        headers: fromMe ? {} : { autoSubmitted: AUTOMATED_NAME.test(m.from.name) },
      });
    });
  }
  return items;
}

const norm = (s) => squash(s).toLowerCase();

/** Whether a message read in full from the reading pane is the same one a list row previewed. */
function covers(pane, row) {
  if ((pane.folderHint === 'sent') !== (row.folderHint === 'sent')) return false;
  if (pane.precision === 'minute' && row.precision === 'minute' && Math.abs(Date.parse(pane.sentAt) - Date.parse(row.sentAt)) <= 3 * 60_000) {
    return true;
  }
  const preview = norm(row.body).slice(0, 60);
  return preview.length >= 12 && norm(pane.body).slice(0, 800).includes(preview);
}

/**
 * Stored items → provider messages. Joins threads that were only known by subject onto the
 * conversation they belong to, and drops list previews of messages that were also read in full.
 */
export function itemsToMessages(items, { since }) {
  const list = items.map((it) => ({ ...it }));
  const bySubject = new Map();
  for (const it of list) {
    if (!it.threadKey.startsWith('w:s:') && it.subjectKey?.length >= 4 && !bySubject.has(it.subjectKey)) bySubject.set(it.subjectKey, it.threadKey);
  }
  for (const it of list) if (it.threadKey.startsWith('w:s:') && bySubject.has(it.subjectKey)) it.threadKey = bySubject.get(it.subjectKey);

  const pane = new Map();
  for (const it of list) if (it.origin === 'pane') pane.set(it.threadKey, [...(pane.get(it.threadKey) || []), it]);

  const cutoff = since.toISOString();
  return list
    .filter((it) => it.origin !== 'list' || !(pane.get(it.threadKey) || []).some((p) => covers(p, it)))
    .filter((it) => it.sentAt >= cutoff)
    .map((it) => ({
      providerId: it.providerId,
      threadKey: it.threadKey,
      messageIdHeader: null,
      from: it.from,
      to: it.to,
      cc: it.cc,
      subject: it.subject,
      body: it.body,
      sentAt: it.sentAt,
      isRead: it.isRead,
      importance: it.importance,
      webLink: it.webLink,
      folderHint: it.folderHint,
      headers: it.headers || {},
      isMeetingMessage: false,
    }));
}

/* -------------------------------------------------------------- hygiene */

const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
const arr = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []);

/** Coerce a snapshot from the extension into the expected shape and size; null if unusable. */
export function cleanSnapshot(s) {
  if (!s || typeof s !== 'object') return null;
  let host = '';
  try {
    host = new URL(str(s.url, 500)).hostname;
  } catch {
    return null;
  }
  if (!OUTLOOK_HOSTS.has(host)) return null;
  const order = str(s.locale?.order, 3).toUpperCase();
  return {
    url: str(s.url, 500),
    title: str(s.title, 300),
    folder: { path: str(s.folder?.path, 300), label: str(s.folder?.label, 100) },
    locale: {
      order: /^[DMY]{3}$/.test(order) ? order : 'MDY',
      weekdays: arr(s.locale?.weekdays, 7).map((x) => str(x, 24)),
      weekdaysLong: arr(s.locale?.weekdaysLong, 7).map((x) => str(x, 24)),
      yesterday: str(s.locale?.yesterday, 30),
      today: str(s.locale?.today, 30),
    },
    rows: arr(s.rows, 300).map((r) => ({
      convId: str(r?.convId, 400),
      aria: str(r?.aria, 1500),
      lines: arr(r?.lines, 12).map((x) => str(x, 600)),
      titles: arr(r?.titles, 20).map((x) => str(x, 300)),
      selected: r?.selected === true,
    })),
    open:
      s.open && typeof s.open === 'object'
        ? {
            subject: str(s.open.subject, 500),
            messages: arr(s.open.messages, 20).map((m) => ({
              header: str(m?.header, 2000),
              titles: arr(m?.titles, 30).map((x) => str(x, 300)),
              labels: arr(m?.labels, 30).map((x) => str(x, 300)),
              body: str(m?.body, 12000),
            })),
          }
        : null,
  };
}

/**
 * The page-structure outline the extension sends for diagnostics: element names, roles and
 * attribute *names* only. Anything that could carry message content is dropped here as well.
 */
export function cleanStructure(node, budget = { n: 800 }, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 14 || budget.n-- <= 0) return null;
  const word = (v, n) => str(v, n).replace(/[^A-Za-z0-9_-]/g, '');
  const out = {
    tag: word(node.tag, 20).toLowerCase(),
    role: word(node.role, 40),
    attrs: arr(node.attrs, 20)
      .map((a) => word(a, 40))
      .filter(Boolean),
  };
  if (/^[A-Za-z][\w-]{0,60}$/.test(node.id || '')) out.id = node.id;
  if (/^[A-Za-z][\w-]{0,40}$/.test(node.section || '')) out.section = node.section;
  if (Number.isInteger(node.level)) out.level = node.level;
  if (Number.isInteger(node.textLen)) out.textLen = node.textLen;
  const kids = arr(node.kids, 30)
    .map((k) => cleanStructure(k, budget, depth + 1))
    .filter(Boolean);
  if (kids.length) out.kids = kids;
  return out;
}

/** Counts of what parsed, for diagnostics. No content. */
export function parseStats(snap, now = new Date()) {
  const ctx = { locale: snap.locale || {}, now };
  const rows = snap.rows.map((r) => parseRow(r, ctx));
  const pane = (snap.open?.messages || []).map((m) => parseOpenMessage(m, ctx));
  return {
    folder: folderKind(snap.folder),
    owner: !!(ownerFromTitle(snap.title).name || ownerFromTitle(snap.title).email),
    rows: rows.length,
    rowsWithConversationId: snap.rows.filter((r) => r.convId).length,
    rowsWithSender: rows.filter((r) => r.sender.name || r.sender.email).length,
    rowsWithSenderAddress: rows.filter((r) => r.sender.email).length,
    rowsWithSubject: rows.filter((r) => r.subject).length,
    rowsWithPreview: rows.filter((r) => r.preview).length,
    rowsWithDate: rows.filter((r) => r.when).length,
    paneSubject: !!snap.open?.subject,
    paneMessages: pane.length,
    paneWithSender: pane.filter((m) => m.from.name || m.from.email).length,
    paneWithSenderAddress: pane.filter((m) => m.from.email).length,
    paneWithRecipients: pane.filter((m) => m.to).length,
    paneWithDate: pane.filter((m) => m.when).length,
    paneWithBody: pane.filter((m) => m.body).length,
  };
}
