// The mini panel: a compact view that floats above other windows (your mail app, a meeting)
// so Pinger stays in sight while you work somewhere else.

import {
  api, dueLabel, fmtTime, html, Icon, openInMain, personName, Spinner, timeAgo, Toasts, update, useAction, useData, useStore, waitingFor,
} from '../lib.js';
import { OutlookWebStatus } from './parts.js';

function ThreadRow({ t, waiting }) {
  const [busy, run] = useAction();
  const open = () => openInMain(`/emails${waiting ? '/waiting' : ''}?open=${t.id}`);
  const done = (e) => {
    e.stopPropagation();
    run(() => api(`/api/threads/${t.id}/action`, { method: 'POST', body: { action: 'done' } }));
  };
  return html`<div class="item clickable" role="button" tabindex="0" onClick=${open} onKeyDown=${(e) => e.key === 'Enter' && open()}>
    <div class="item-head">
      <span class=${`dot ${t.priority}`} title=${`${t.priority} priority`}></span>
      <span class="who truncate">${personName(t.person)}</span>
      <span class="subject"></span>
      <span class="row-actions">
        <button class="btn sm" disabled=${busy} onClick=${done}>Done</button>
      </span>
      <span class="when">${waitingFor(t.waitingSince)}</span>
    </div>
    <div class="truncate">${t.subject}</div>
    <p class="summary">${t.ask || t.summary || t.preview}</p>
  </div>`;
}

export function MiniPanel() {
  const { state, meetingPrompt, offline } = useStore();
  const { data } = useData(() => api('/api/overview'), ['threads', 'followups', 'digest', 'events', 'meetings', 'accounts']);
  const [busy, run] = useAction();

  const sync = () => run(() => api('/api/sync', { method: 'POST' }));
  const complete = (f) => run(() => api(`/api/followups/${f.id}`, { method: 'PATCH', body: { status: 'done' } }));
  const lastSync = state.accounts.map((a) => a.lastSyncAt).filter(Boolean).sort().at(-1);

  const prompt = meetingPrompt?.data;
  const skip = () => {
    if (prompt?.eventId) api(`/api/events/${prompt.eventId}/skip`, { method: 'POST' }).catch(() => {});
    update({ meetingPrompt: null });
  };
  const takeNotes = () => {
    update({ meetingPrompt: null });
    openInMain(`/live?event=${prompt.eventId}`);
  };

  const now = data?.now;
  const c = state.counts;
  return html`<div class="mini">
    <div class="mini-head">
      <img src="/icon.svg" alt="" />
      <span class="grow">Pinger</span>
      <button class="btn ghost sm icon" title="Check mail now" aria-label="Check mail now" disabled=${busy || state.status.syncing} onClick=${sync}>
        ${state.status.syncing ? html`<${Spinner} />` : html`<${Icon} name="refresh" />`}
      </button>
      <button class="btn ghost sm" title="Open the full window" onClick=${() => openInMain('/')}>Open <${Icon} name="external" /></button>
    </div>

    <${OutlookWebStatus} compact />
    ${prompt &&
    html`<div class="mini-alert" role="alert">
      <div class="title">${prompt.title || 'Your meeting'} is starting</div>
      <div class="small muted">Record a transcript and take notes?</div>
      <div class="row">
        <button class="btn sm primary" onClick=${takeNotes}><${Icon} name="mic" /> Take notes</button>
        <button class="btn sm" onClick=${skip}>Skip</button>
        ${prompt.joinUrl && html`<a class="small" href=${prompt.joinUrl} target="_blank" rel="noreferrer">Join</a>`}
      </div>
    </div>`}

    ${offline && html`<div class="banner error" style="border-radius:0;border-width:0 0 1px">Pinger is not running. Start it again.</div>`}
    ${!state.accounts.length && html`<div class="empty">No mailbox connected. <a href="#" onClick=${(e) => { e.preventDefault(); openInMain('/settings'); }}>Open Settings</a>.</div>`}
    ${state.accounts.length > 0 && !now && html`<div class="empty"><${Spinner} /></div>`}

    ${now &&
    html`<div class="list">
      <div class="group-label">Reply <span class="mono">${c.needsReply}</span>
        <a href="#" onClick=${(e) => { e.preventDefault(); openInMain('/emails'); }}>All</a>
      </div>
      ${now.needsReply.slice(0, 6).map((t) => html`<${ThreadRow} key=${t.id} t=${t} />`)}
      ${!now.needsReply.length && html`<div class="item muted">Nothing needs a reply.</div>`}

      ${now.nudges.length > 0 &&
      html`<div class="group-label">No answer yet <span class="mono">${c.nudges}</span>
          <a href="#" onClick=${(e) => { e.preventDefault(); openInMain('/emails/waiting'); }}>All</a>
        </div>
        ${now.nudges.slice(0, 4).map((t) => html`<${ThreadRow} key=${t.id} t=${t} waiting />`)}`}

      ${now.followupsDue.length > 0 &&
      html`<div class="group-label">Follow-ups due <span class="mono">${c.followupsDue}</span>
          <a href="#" onClick=${(e) => { e.preventDefault(); openInMain('/followups'); }}>All</a>
        </div>
        ${now.followupsDue.slice(0, 5).map((f) => {
          const due = dueLabel(f.dueOn);
          return html`<div class="item row top">
            <input type="checkbox" class="check" aria-label=${`Mark “${f.title}” done`} onChange=${() => complete(f)} />
            <div class="grow">
              <div>${f.title}</div>
              ${due && html`<span class=${`chip ${due.cls}`}>${due.text}</span>`}
            </div>
          </div>`;
        })}`}

      ${now.meetings.length > 0 &&
      html`<div class="group-label">Today</div>
        ${now.meetings.map(
          (e) => html`<div class="item row">
            <span class="mono nowrap">${fmtTime(e.startAt)}</span>
            <span class="grow truncate">${e.title}</span>
            <button class="btn sm" onClick=${() => openInMain(e.meetingId ? `/meetings/${e.meetingId}` : `/live?event=${e.id}`)}>${e.meetingId ? 'Notes' : 'Take notes'}</button>
          </div>`,
        )}`}
    </div>`}

    <div class="mini-foot">
      <span class="grow">${state.accounts.length ? `Checked ${lastSync ? timeAgo(lastSync) + (timeAgo(lastSync) === 'just now' ? '' : ' ago') : '—'}` : ''}</span>
      <span>${state.ai.enabled ? 'AI on' : 'AI off'}</span>
    </div>
    <${Toasts} onOpen=${openInMain} />
  </div>`;
}
