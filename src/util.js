export const nowIso = (d = new Date()) => d.toISOString();

const pad = (n) => String(n).padStart(2, '0');

/** YYYY-MM-DD in the machine's local time zone. */
export function localDate(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** HH:MM in the machine's local time zone. */
export function localTime(d = new Date()) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "09:30" -> minutes since midnight, or null if malformed. */
export function parseHM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export function formatHM(minutes) {
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/** Local Date for today (relative to `now`) at the given "HH:MM". */
export function atLocalTime(now, hm) {
  const mins = parseHM(hm);
  const d = new Date(now);
  d.setHours(Math.floor(mins / 60), mins % 60, 0, 0);
  return d;
}

export const lower = (s) => String(s || '').trim().toLowerCase();

export function truncate(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
}

export function parseJson(s, fallback) {
  if (s == null || s === '') return fallback;
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

export function daysBetween(fromIso, to = new Date()) {
  return (to.getTime() - new Date(fromIso).getTime()) / 86_400_000;
}

/** Human "3 days", "5 hours", "20 minutes". */
export function ago(fromIso, now = new Date()) {
  const mins = Math.max(0, Math.round((now.getTime() - new Date(fromIso).getTime()) / 60000));
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'}`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

export function plural(n, word, pluralWord) {
  return `${n} ${n === 1 ? word : pluralWord || word + 's'}`;
}

/** Only http(s) and mailto links are ever handed to the UI. */
export function safeLink(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    return ['http:', 'https:', 'mailto:'].includes(u.protocol) ? u.toString() : null;
  } catch {
    return null;
  }
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
