// Shared front-end plumbing: API calls, a tiny store, routing, formatting and small components.

import { h } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import htm from 'htm';

export const html = htm.bind(h);

/* -------------------------------------------------------------------- api */

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/* ------------------------------------------------------------------ store */

const listeners = new Set();

export function parseRoute() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, query = ''] = raw.split('?');
  return { path, parts: path.split('/').filter(Boolean), query: new URLSearchParams(query) };
}

export const store = { state: null, toasts: [], meetingPrompt: null, offline: false, mini: null, route: parseRoute() };

export function update(patch) {
  Object.assign(store, patch);
  for (const l of listeners) l();
}

export function useStore() {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => listeners.delete(l);
  }, []);
  return store;
}

export const go = (path) => {
  location.hash = path;
};

export async function refreshState() {
  update({ state: await api('/api/state') });
}

/** True in the stand-alone mini window (opened as its own browser window at #/mini). */
export const isMiniWindow = () => parseRoute().parts[0] === 'mini';

/**
 * Show a route in the main Pinger window and bring it forward. Works from the floating
 * mini panel (which shares this page) and from a stand-alone mini window.
 */
export function openInMain(route) {
  if (!isMiniWindow()) {
    go(route);
    window.focus();
    return;
  }
  if (window.opener && !window.opener.closed) {
    window.opener.location.hash = route;
    window.opener.focus();
  } else {
    window.open(`/#${route}`, 'pinger-main');
  }
}

/* ------------------------------------------------------------- live data */

const topicListeners = new Set();

/** Called when the server says some kind of data changed. */
export function emitChanged(topics) {
  for (const l of topicListeners) l(topics);
}

/**
 * Load data now, again whenever `deps` change, and again whenever the server reports a change
 * to one of `topics`.
 */
export function useData(loader, topics = [], deps = []) {
  const [st, set] = useState({ data: null, error: null, loading: true });
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const seq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const data = await loaderRef.current();
      if (mine === seq.current) set({ data, error: null, loading: false });
    } catch (error) {
      if (mine === seq.current) set((s) => ({ ...s, error, loading: false }));
    }
  }, []);
  useEffect(() => {
    load();
  }, deps);
  useEffect(() => {
    const l = (changedTopics) => {
      if (topics.some((t) => changedTopics.includes(t))) load();
    };
    topicListeners.add(l);
    return () => topicListeners.delete(l);
  }, []);
  return { ...st, reload: load };
}

/* ----------------------------------------------------------------- toasts */

let toastSeq = 0;

export function dismissToast(id) {
  update({ toasts: store.toasts.filter((t) => t.id !== id) });
}

export function toast(title, { body = '', kind = '', url = null, ms = 6000 } = {}) {
  const id = ++toastSeq;
  update({ toasts: [...store.toasts.slice(-3), { id, title, body, kind, url }] });
  if (ms) setTimeout(() => dismissToast(id), ms);
}

export const oops = (err) => toast(err?.message || 'Something went wrong', { kind: 'error', ms: 9000 });

/* ------------------------------------------------------------- formatting */

export function timeAgo(iso, now = Date.now()) {
  const mins = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export function waitingFor(iso) {
  const t = timeAgo(iso);
  return t === 'just now' ? t : `${t} ago`;
}

export const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
export const fmtDay = (iso) => new Date(iso).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
export const fmtDateTime = (iso) => `${fmtDay(iso)}, ${fmtTime(iso)}`;

const pad = (n) => String(n).padStart(2, '0');
export const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** "YYYY-MM-DD" → a friendly label and whether it is late. */
export function dueLabel(dueOn) {
  if (!dueOn) return null;
  const today = localDate();
  const tomorrow = localDate(new Date(Date.now() + 86_400_000));
  const date = new Date(`${dueOn}T12:00:00`);
  const nice = date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  if (dueOn < today) return { text: `Was due ${nice}`, cls: 'high' };
  if (dueOn === today) return { text: 'Due today', cls: 'medium' };
  if (dueOn === tomorrow) return { text: 'Due tomorrow', cls: '' };
  return { text: `Due ${nice}`, cls: '' };
}

export function relativeDay(iso) {
  const d = localDate(new Date(iso));
  if (d === localDate()) return 'Today';
  if (d === localDate(new Date(Date.now() + 86_400_000))) return 'Tomorrow';
  if (d === localDate(new Date(Date.now() - 86_400_000))) return 'Yesterday';
  return fmtDay(iso);
}

export const initials = (name) =>
  String(name || '?')
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');

export const personName = (p) => p?.name || p?.email || 'Someone';

export function snoozeChoices() {
  const now = new Date();
  const later = new Date(now.getTime() + 3 * 3_600_000);
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  const monday = new Date(now);
  monday.setDate(now.getDate() + (((8 - now.getDay()) % 7) || 7));
  monday.setHours(9, 0, 0, 0);
  return [
    { label: 'In 3 hours', until: later.toISOString() },
    { label: 'Tomorrow morning', until: tomorrow.toISOString() },
    { label: 'Next Monday', until: monday.toISOString() },
  ];
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied', { kind: 'good', ms: 2500 });
  } catch {
    toast('Could not copy — select the text and copy it manually.', { kind: 'error' });
  }
}

/* ------------------------------------------------------------------ icons */

const ICONS = {
  home: ['M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', 'M9 22V12h6v10'],
  mail: ['M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z', 'M22 6l-10 7L2 6'],
  tasks: ['M9 11l3 3L22 4', 'M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11'],
  mic: ['M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z', 'M19 10v2a7 7 0 0 1-14 0v-2', 'M12 19v4', 'M8 23h8'],
  calendar: ['M19 4H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z', 'M16 2v4', 'M8 2v4', 'M3 10h18'],
  settings: ['M4 21v-7', 'M4 10V3', 'M12 21v-9', 'M12 8V3', 'M20 21v-5', 'M20 12V3', 'M1 14h6', 'M9 8h6', 'M17 16h6'],
  check: ['M20 6L9 17l-5-5'],
  x: ['M18 6L6 18', 'M6 6l12 12'],
  clock: ['M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z', 'M12 6v6l4 2'],
  external: ['M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6', 'M15 3h6v6', 'M10 14L21 3'],
  refresh: ['M23 4v6h-6', 'M1 20v-6h6', 'M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15'],
  plus: ['M12 5v14', 'M5 12h14'],
  trash: ['M3 6h18', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2'],
  panel: ['M3 4h18v16H3z', 'M15 4v16'],
  edit: ['M12 20h9', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z'],
  bell: ['M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9', 'M13.73 21a2 2 0 0 1-3.46 0'],
  upload: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M17 8l-5-5-5 5', 'M12 3v12'],
  search: ['M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16z', 'M21 21l-4.35-4.35'],
  pause: ['M6 4h4v16H6z', 'M14 4h4v16h-4z'],
  play: ['M5 3l14 9-14 9V3z'],
  stop: ['M5 5h14v14H5z'],
  copy: ['M20 9h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2z', 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1'],
  down: ['M6 9l6 6 6-6'],
  back: ['M19 12H5', 'M12 19l-7-7 7-7'],
  reply: ['M9 14L4 9l5-5', 'M20 20v-7a4 4 0 0 0-4-4H4'],
};

export function Icon({ name }) {
  return html`<svg
    class="icon-svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    ${(ICONS[name] || []).map((d) => html`<path d=${d} />`)}
  </svg>`;
}

/* ------------------------------------------------------------- components */

export const Spinner = () => html`<span class="spinner" role="status" aria-label="Working"></span>`;

/** A button that opens a small menu of choices. */
export function Menu({ label, icon, items, cls = 'btn sm' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => {
      if (!ref.current?.contains(e.target)) setOpen(false);
    };
    const esc = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('click', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  return html`<span class="menu-wrap" ref=${ref}>
    <button
      class=${cls}
      aria-haspopup="menu"
      aria-expanded=${open}
      onClick=${(e) => {
        e.stopPropagation();
        setOpen(!open);
      }}
    >
      ${icon && html`<${Icon} name=${icon} />`}${label}
    </button>
    ${open &&
    html`<div class="menu" role="menu">
      ${items.map(
        (item) =>
          html`<button
            role="menuitem"
            onClick=${(e) => {
              e.stopPropagation();
              setOpen(false);
              item.onSelect();
            }}
          >
            ${item.label}
          </button>`,
      )}
    </div>`}
  </span>`;
}

export function Modal({ children, onClose, wide = false, label, title, aside }) {
  useEffect(() => {
    if (!onClose) return undefined;
    const esc = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);
  return html`<div class="overlay" onMouseDown=${(e) => e.target === e.currentTarget && onClose?.()}>
    <div class=${`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label=${label || title}>
      ${title && html`<div class="modal-head"><h2>${title}</h2>${aside}</div>`}
      ${children}
    </div>
  </div>`;
}

/** Run an async action with a busy flag and error toast. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (fn) => {
    setBusy(true);
    try {
      return await fn();
    } catch (err) {
      oops(err);
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return [busy, run];
}

export function Toasts({ onOpen = go }) {
  const { toasts } = useStore();
  return html`<div class="toasts" role="status" aria-live="polite">
    ${toasts.map(
      (t) => html`<div
        key=${t.id}
        class=${`toast ${t.kind}`}
        onClick=${() => {
          if (t.url) onOpen(t.url);
          dismissToast(t.id);
        }}
      >
        <div class="grow">
          <div class="title">${t.title}</div>
          ${t.body && html`<div class="body">${t.body}</div>`}
        </div>
        <button
          class="btn ghost sm icon"
          aria-label="Dismiss"
          onClick=${(e) => {
            e.stopPropagation();
            dismissToast(t.id);
          }}
        >
          <${Icon} name="x" />
        </button>
      </div>`,
    )}
  </div>`;
}

/** A count or time set in the monospace face. */
export const Mono = ({ children }) => html`<span class="mono">${children}</span>`;
