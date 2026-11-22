import { render } from 'preact';
import { useEffect } from 'preact/hooks';
import {
  api, emitChanged, fmtTime, go, html, Icon, isMiniWindow, Modal, parseRoute, refreshState, Spinner, store, timeAgo, toast, Toasts, update, useStore,
} from './lib.js';
import { Emails } from './views/emails.js';
import { Followups } from './views/followups.js';
import { Live } from './views/live.js';
import { MeetingDetail, Meetings } from './views/meetings.js';
import { floatingPanelOpen, popOut } from './popout.js';
import { MiniPanel } from './views/mini.js';
import { Onboarding } from './views/onboarding.js';
import { Overview } from './views/overview.js';
import { Settings } from './views/settings.js';

/* ------------------------------------------------------- server connection */

let source = null;
let stateTimer = null;

const canNotify = () => 'Notification' in window && Notification.permission === 'granted';

function scheduleStateRefresh() {
  clearTimeout(stateTimer);
  stateTimer = setTimeout(() => refreshState().catch(() => {}), 150);
}

/** Ping URLs look like "/#/emails?open=3"; turn them into an in-app route. */
const routeOf = (url) => String(url || '/').replace(/^\/?#?/, '') || '/';

function handlePing(p) {
  if (p.type === 'meeting') update({ meetingPrompt: p });
  else toast(p.title, { body: p.body, url: routeOf(p.url), ms: 12000 });

  // The stand-alone mini window leaves desktop notifications to the main window.
  const away = document.hidden || !document.hasFocus();
  if (away && canNotify() && !(isMiniWindow() && window.opener && !window.opener.closed)) {
    try {
      const n = new Notification(p.title, { body: p.body, tag: `pinger-${p.id}`, icon: '/icon-192.png', requireInteraction: p.type === 'meeting' });
      n.onclick = () => {
        window.focus();
        go(routeOf(p.url));
        n.close();
      };
    } catch {
      /* the in-page message is still there */
    }
  }
}

function connect() {
  source?.close();
  source = new EventSource(`/api/stream?notify=${canNotify() ? 1 : 0}`);
  source.onopen = () => {
    if (store.offline) {
      update({ offline: false });
      emitChanged(['threads', 'followups', 'meetings', 'events', 'digest', 'accounts']);
    }
    scheduleStateRefresh();
  };
  source.onerror = () => update({ offline: true });
  source.addEventListener('changed', (e) => {
    emitChanged(JSON.parse(e.data).topics || []);
    scheduleStateRefresh();
  });
  source.addEventListener('ping', (e) => handlePing(JSON.parse(e.data)));
}

window.addEventListener('pinger:notify-permission', connect);
window.addEventListener('hashchange', () => update({ route: parseRoute() }));

/* ------------------------------------------------------------------ shell */

const SECTIONS = [
  ['overview', '#/', 'home', 'Overview'],
  ['emails', '#/emails', 'mail', 'Emails'],
  ['followups', '#/followups', 'tasks', 'Follow-ups'],
  ['meetings', '#/meetings', 'mic', 'Meetings'],
  ['settings', '#/settings', 'settings', 'Settings'],
];

// 1–5 switch sections, unless the user is typing somewhere.
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || isMiniWindow()) return;
  const el = e.target;
  if (el instanceof HTMLElement && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))) return;
  if (document.querySelector('.overlay')) return;
  const section = SECTIONS[Number(e.key) - 1];
  if (section) location.hash = section[1];
});

function Sidebar({ section }) {
  const { state, offline } = useStore();
  const c = state.counts;
  const counts = { emails: c.needsReply, followups: c.followupsOpen };
  const lastSync = state.accounts.map((a) => a.lastSyncAt).filter(Boolean).sort().at(-1);
  const sync = () => api('/api/sync', { method: 'POST' }).catch((err) => toast(err.message, { kind: 'error' }));

  return html`<aside class="sidebar">
    <a class="brand" href="#/"><img src="/icon.svg" alt="" /><span>Pinger</span></a>
    <nav class="nav" aria-label="Main">
      ${SECTIONS.map(
        ([id, href, icon, label], i) => html`<a href=${href} class=${section === id ? 'active' : ''} aria-current=${section === id ? 'page' : undefined}>
          <${Icon} name=${icon} /><span class="label">${label}</span>
          ${counts[id] ? html`<span class="count">${counts[id]}</span>` : null}
          <kbd aria-hidden="true">${i + 1}</kbd>
        </a>`,
      )}
    </nav>
    <div class="sidebar-foot">
      <button class="btn sm" title="A small window that stays on top of your mail app" onClick=${popOut}><${Icon} name="panel" /> Mini window</button>
      ${offline
        ? html`<span style="color:var(--danger)">Pinger is not running. Start it again to get pings.</span>`
        : html`<div class="row" style="gap:4px">
            ${state.status.syncing
              ? html`<${Spinner} /> Checking mail`
              : state.accounts.length
                ? html`<span>Mail checked <span class="mono">${lastSync ? timeAgo(lastSync) : '—'}</span>${lastSync && timeAgo(lastSync) !== 'just now' ? ' ago' : ''}</span>`
                : 'No mailbox connected'}
            ${state.accounts.length > 0 &&
            !state.status.syncing &&
            html`<button class="btn ghost sm icon" style="margin-left:auto" aria-label="Check mail now" title="Check mail now" onClick=${sync}><${Icon} name="refresh" /></button>`}
          </div>`}
      <div>
        ${state.ai.enabled
          ? html`AI on · <span class="nowrap">${state.models.find((m) => m.id === state.ai.model)?.label || state.ai.model}</span>`
          : html`AI off · <a href="#/settings?focus=ai">add a key</a>`}
      </div>
    </div>
  </aside>`;
}

function MeetingPrompt({ ping }) {
  const { eventId, title, startAt, joinUrl } = ping.data || {};
  const close = () => update({ meetingPrompt: null });
  const skip = () => {
    if (eventId) api(`/api/events/${eventId}/skip`, { method: 'POST' }).catch(() => {});
    close();
  };
  const accept = () => {
    close();
    go(`/live?event=${eventId}`);
  };
  return html`<${Modal} onClose=${skip} title="Meeting starting" aside=${startAt && html`<span class="mono muted">${fmtTime(startAt)}</span>`}>
    <div class="modal-body">
      <h1>${title || 'Your meeting'} is starting</h1>
      <p class="muted">Record a transcript and take notes? Pinger lists your follow-ups when the meeting ends.</p>
      ${joinUrl && html`<a href=${joinUrl} target="_blank" rel="noreferrer">Join the meeting <${Icon} name="external" /></a>`}
    </div>
    <div class="modal-foot">
      <button class="btn" onClick=${skip}>Skip</button>
      <button class="btn primary" onClick=${accept}><${Icon} name="mic" /> Take notes</button>
    </div>
  <//>`;
}

function App() {
  const { state, route, meetingPrompt, mini } = useStore();

  useEffect(() => {
    if (!state) return;
    const n = state.counts.needsReply;
    document.title = n ? `(${n}) Pinger` : 'Pinger';
  }, [state?.counts.needsReply]);

  if (!state) return html`<div class="empty"><${Spinner} /></div>`;

  const section = route.parts[0] || 'overview';
  if (section === 'mini') return html`<${MiniPanel} />`;

  let view;
  if (section === 'emails') view = html`<${Emails} route=${route} />`;
  else if (section === 'followups') view = html`<${Followups} />`;
  else if (section === 'meetings') view = route.parts[1] ? html`<${MeetingDetail} key=${route.parts[1]} id=${Number(route.parts[1])} />` : html`<${Meetings} />`;
  else if (section === 'live') view = html`<${Live} route=${route} />`;
  else if (section === 'settings') view = html`<${Settings} route=${route} />`;
  else view = html`<${Overview} />`;

  // While the floating mini panel is open it shows the meeting prompt itself.
  const floating = mini && floatingPanelOpen();
  return html`
    <div class="shell">
      <${Sidebar} section=${section === 'live' ? 'meetings' : section} />
      <main class="main">${view}</main>
    </div>
    ${!state.settings.onboarded && html`<${Onboarding} />`}
    ${meetingPrompt && state.settings.onboarded && !floating && html`<${MeetingPrompt} ping=${meetingPrompt} />`}
    <${Toasts} />
  `;
}

async function boot() {
  try {
    await refreshState();
  } catch (err) {
    document.getElementById('app').textContent = `Pinger could not start: ${err.message}`;
    return;
  }
  render(html`<${App} />`, document.getElementById('app'));
  connect();
}

boot();
