import { all, get, run, tx } from './db.js';
import { formatHM, HttpError, parseHM, parseJson } from './util.js';

export const MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', note: 'Best judgement (default)' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', note: 'Faster, about half the cost' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', note: 'Fastest and cheapest' },
  { id: 'claude-fable-5-2', label: 'Claude Fable 5.2', note: 'Most capable, highest cost' },
];

export const DEFAULTS = {
  profile: { name: '', emails: [] },
  overview: { enabled: true, times: ['09:00', '13:00', '17:00'], weekdaysOnly: true },
  followups: { awaitingDays: 3, remindEveryHours: 24, pingUrgent: true },
  pingHours: { start: '08:00', end: '20:00' },
  meetings: { prompt: true, leadMinutes: 1, language: 'en-US' },
  calendar: { icsUrls: [] },
  ai: { apiKey: '', model: MODELS[0].id },
  sync: { intervalMinutes: 10, lookbackDays: 14 },
  onboarded: false,
};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

function merge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v;
  }
  return out;
}

export function getSettings() {
  const stored = {};
  for (const row of all('SELECT key, value FROM settings')) stored[row.key] = parseJson(row.value, undefined);
  return merge(DEFAULTS, stored);
}

/** Evenly spread `count` overview times across the working day. */
export function spreadTimes(count, start = '09:00', end = '17:00') {
  count = Math.max(0, Math.min(12, Math.floor(count)));
  if (count === 0) return [];
  if (count === 1) return [start];
  const a = parseHM(start);
  const b = parseHM(end);
  const out = [];
  for (let i = 0; i < count; i++) {
    const raw = a + ((b - a) * i) / (count - 1);
    out.push(formatHM(Math.round(raw / 15) * 15));
  }
  return [...new Set(out)];
}

function clampInt(v, min, max, name) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new HttpError(400, `${name} must be a number`);
  return Math.max(min, Math.min(max, Math.round(n)));
}

function cleanTimes(times) {
  if (!Array.isArray(times)) throw new HttpError(400, 'times must be a list');
  const mins = times.map((t) => {
    const m = parseHM(t);
    if (m == null) throw new HttpError(400, `"${t}" is not a valid time (use HH:MM)`);
    return m;
  });
  return [...new Set(mins)].sort((x, y) => x - y).slice(0, 12).map(formatHM);
}

/** Validate a partial settings object from the UI and return the cleaned patch. */
export function validatePatch(patch) {
  if (!isObj(patch)) throw new HttpError(400, 'Settings must be an object');
  const out = {};
  if (isObj(patch.profile)) {
    out.profile = {};
    if (patch.profile.name != null) out.profile.name = String(patch.profile.name).trim().slice(0, 120);
    if (patch.profile.emails != null) {
      if (!Array.isArray(patch.profile.emails)) throw new HttpError(400, 'emails must be a list');
      out.profile.emails = patch.profile.emails
        .map((e) => String(e).trim().toLowerCase())
        .filter((e) => /^[^\s@]+@[^\s@]+$/.test(e))
        .slice(0, 20);
    }
  }
  if (isObj(patch.overview)) {
    out.overview = {};
    if (patch.overview.enabled != null) out.overview.enabled = !!patch.overview.enabled;
    if (patch.overview.weekdaysOnly != null) out.overview.weekdaysOnly = !!patch.overview.weekdaysOnly;
    if (patch.overview.times != null) out.overview.times = cleanTimes(patch.overview.times);
  }
  if (isObj(patch.followups)) {
    out.followups = {};
    if (patch.followups.awaitingDays != null) {
      out.followups.awaitingDays = clampInt(patch.followups.awaitingDays, 1, 30, 'awaitingDays');
    }
    if (patch.followups.remindEveryHours != null) {
      out.followups.remindEveryHours = clampInt(patch.followups.remindEveryHours, 1, 168, 'remindEveryHours');
    }
    if (patch.followups.pingUrgent != null) out.followups.pingUrgent = !!patch.followups.pingUrgent;
  }
  if (isObj(patch.pingHours)) {
    out.pingHours = {};
    for (const k of ['start', 'end']) {
      if (patch.pingHours[k] != null) {
        if (parseHM(patch.pingHours[k]) == null) throw new HttpError(400, `pingHours.${k} must be HH:MM`);
        out.pingHours[k] = formatHM(parseHM(patch.pingHours[k]));
      }
    }
  }
  if (isObj(patch.meetings)) {
    out.meetings = {};
    if (patch.meetings.prompt != null) out.meetings.prompt = !!patch.meetings.prompt;
    if (patch.meetings.leadMinutes != null) {
      out.meetings.leadMinutes = clampInt(patch.meetings.leadMinutes, 0, 15, 'leadMinutes');
    }
    if (patch.meetings.language != null) {
      const lang = String(patch.meetings.language).trim();
      if (!/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(lang)) throw new HttpError(400, 'Invalid language code');
      out.meetings.language = lang;
    }
  }
  if (isObj(patch.calendar) && patch.calendar.icsUrls != null) {
    if (!Array.isArray(patch.calendar.icsUrls)) throw new HttpError(400, 'icsUrls must be a list');
    out.calendar = {
      icsUrls: patch.calendar.icsUrls
        .map((u) => String(u).trim().replace(/^webcal:/i, 'https:'))
        .filter(Boolean)
        .map((u) => {
          let parsed;
          try {
            parsed = new URL(u);
          } catch {
            throw new HttpError(400, `"${u}" is not a valid calendar link`);
          }
          if (!['http:', 'https:'].includes(parsed.protocol)) {
            throw new HttpError(400, 'Calendar links must start with https://');
          }
          return parsed.toString();
        })
        .slice(0, 5),
    };
  }
  if (isObj(patch.ai)) {
    out.ai = {};
    if (patch.ai.apiKey != null) out.ai.apiKey = String(patch.ai.apiKey).trim();
    if (patch.ai.model != null) {
      if (!MODELS.some((m) => m.id === patch.ai.model)) throw new HttpError(400, 'Unknown model');
      out.ai.model = patch.ai.model;
    }
  }
  if (isObj(patch.sync)) {
    out.sync = {};
    if (patch.sync.intervalMinutes != null) {
      out.sync.intervalMinutes = clampInt(patch.sync.intervalMinutes, 2, 240, 'intervalMinutes');
    }
    if (patch.sync.lookbackDays != null) out.sync.lookbackDays = clampInt(patch.sync.lookbackDays, 3, 60, 'lookbackDays');
  }
  if (patch.onboarded != null) out.onboarded = !!patch.onboarded;
  return out;
}

export function updateSettings(patch) {
  const clean = validatePatch(patch);
  const current = getSettings();
  tx(() => {
    for (const [key, value] of Object.entries(clean)) {
      const next = isObj(value) ? merge(current[key] ?? {}, value) : value;
      run(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        key,
        JSON.stringify(next),
      );
    }
  });
  return getSettings();
}

/** Settings as the UI may see them: the API key is reduced to a hint. */
export function publicSettings(settings = getSettings()) {
  const key = settings.ai.apiKey || '';
  return {
    ...settings,
    ai: {
      model: settings.ai.model,
      apiKeySet: !!key,
      apiKeyHint: key ? `${key.slice(0, 7)}…${key.slice(-4)}` : '',
    },
  };
}

export function hasSetting(key) {
  return !!get('SELECT 1 AS x FROM settings WHERE key = ?', key);
}
