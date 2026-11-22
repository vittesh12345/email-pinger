import { popOut } from '../popout.js';
import { api, dueLabel, fmtTime, go, html, Icon, personName, Spinner, timeAgo, toast, useAction, useData, useStore, waitingFor } from '../lib.js';

function MiniThread({ t, waiting }) {
  return html`<a class="item clickable" href=${`#/emails${waiting ? '/waiting' : ''}?open=${t.id}`}>
    <div class="item-head">
      <span class=${`dot ${t.priority}`} title=${`${t.priority} priority`}></span>
      <span class="who">${personName(t.person)}</span>
      <span class="subject">${t.subject}</span>
      <span class="when">${waiting ? `sent ${waitingFor(t.waitingSince)}` : waitingFor(t.waitingSince)}</span>
    </div>
    <p class="summary">${t.ask || t.summary || t.preview}</p>
  </a>`;
}

function Section({ title, count, href, children }) {
  return html`<section class="card">
    <div class="card-head">
      <h2>${title}${count != null ? html` <span class="mono">${count}</span>` : ''}</h2>
      ${href && html`<a class="small" href=${href}>View all</a>`}
    </div>
    <div class="list">${children}</div>
  </section>`;
}

function nextLabel(iso) {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return `${sameDay ? '' : `${d.toLocaleDateString([], { weekday: 'short' })} `}${fmtTime(iso)}`;
}

export function Overview() {
  const { state } = useStore();
  const { data } = useData(() => api('/api/overview'), ['threads', 'followups', 'digest', 'events', 'meetings', 'accounts']);
  const [busy, run] = useAction();
  const today = new Date().toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });

  const head = html`<div class="page-head">
    <div class="grow">
      <h1>Overview</h1>
      <p class="sub">
        ${today} · ${state.nextOverviewAt ? html`next overview <span class="mono">${nextLabel(state.nextOverviewAt)}</span>` : 'scheduled overviews off'}
      </p>
    </div>
    <button class="btn" title="A small window that stays on top of your mail app" onClick=${popOut}><${Icon} name="panel" /> Mini window</button>
    <button
      class="btn"
      disabled=${busy || state.status.syncing || !state.accounts.length}
      onClick=${() =>
        run(async () => {
          await api('/api/sync', { method: 'POST' });
          await api('/api/overview', { method: 'POST' });
          toast('Overview updated', { ms: 2500 });
        })}
    >
      ${busy || state.status.syncing ? html`<${Spinner} />` : html`<${Icon} name="refresh" />`} Refresh
    </button>
  </div>`;

  if (!state.accounts.length) {
    return html`<div class="page">
      ${head}
      <div class="card pad row">
        <span class="grow">No mailbox connected.</span>
        <a class="btn primary" href="#/settings">Connect email</a>
      </div>
    </div>`;
  }
  if (!data) return html`<div class="page">${head}<div class="empty"><${Spinner} /></div></div>`;

  const { now, brief } = data;
  const c = now.counts;
  const complete = (f) => run(() => api(`/api/followups/${f.id}`, { method: 'PATCH', body: { status: 'done' } }));
  const age = timeAgo(brief.createdAt);

  return html`<div class="page">
    ${head}

    <div class="strip">
      <a href="#/emails"><span class="n">${c.needsReply}</span><span class="k">Need your reply</span><span class="extra">${c.highPriority ? `${c.highPriority} high priority` : ''}</span></a>
      <a href="#/emails/waiting"><span class="n">${c.waiting}</span><span class="k">Waiting on others</span><span class="extra">${c.nudges ? `${c.nudges} to nudge` : ''}</span></a>
      <a href="#/followups"><span class="n">${c.followupsOpen}</span><span class="k">Open follow-ups</span><span class="extra">${c.followupsDue ? `${c.followupsDue} due` : ''}</span></a>
      <a href="#/meetings"><span class="n">${c.meetingsToday}</span><span class="k">Meetings left today</span><span class="extra"></span></a>
    </div>

    <section class="card brief">
      <p class="text">${brief.text}</p>
      <p class="meta-line">
        ${brief.source === 'ai' ? 'AI summary' : 'Summary'} · <span class="mono">${brief.trigger === 'live' ? 'now' : age === 'just now' ? 'now' : `${age} ago`}</span>
        ${!state.ai.enabled && html` · <a href="#/settings?focus=ai">Add an AI key</a> for written summaries and AI triage`}
      </p>
    </section>

    ${now.needsReply.length > 0 &&
    html`<${Section} title="Reply" count=${c.needsReply} href="#/emails">
      ${now.needsReply.slice(0, 6).map((t) => html`<${MiniThread} t=${t} />`)}
    <//>`}

    ${now.nudges.length > 0 &&
    html`<${Section} title="No answer yet" count=${c.nudges} href="#/emails/waiting">
      ${now.nudges.slice(0, 5).map((t) => html`<${MiniThread} t=${t} waiting />`)}
    <//>`}

    ${now.followupsDue.length > 0 &&
    html`<${Section} title="Follow-ups due" count=${c.followupsDue} href="#/followups">
      ${now.followupsDue.slice(0, 6).map((f) => {
        const due = dueLabel(f.dueOn);
        return html`<div class="item row top">
          <input type="checkbox" class="check" aria-label=${`Mark “${f.title}” done`} onChange=${() => complete(f)} />
          <div class="grow">
            <div>${f.title}</div>
            <div class="meta" style="margin-top:2px">
              ${due && html`<span class=${`chip ${due.cls}`}>${due.text}</span>`}
              ${f.kind === 'waiting' && html`<span class="chip plain">Waiting on ${f.person || 'someone'}</span>`}
              ${f.meetingTitle && html`<a class="small" href=${`#/meetings/${f.meetingId}`}>${f.meetingTitle}</a>`}
            </div>
          </div>
        </div>`;
      })}
    <//>`}

    ${now.meetings.length > 0 &&
    html`<${Section} title="Today">
      ${now.meetings.map(
        (e) => html`<div class="item row">
          <span class="mono nowrap" style="width:64px">${fmtTime(e.startAt)}</span>
          <span class="grow truncate">${e.title}</span>
          ${e.joinUrl && html`<a class="btn sm ghost" href=${e.joinUrl} target="_blank" rel="noreferrer">Join <${Icon} name="external" /></a>`}
          ${e.meetingId
            ? html`<a class="btn sm" href=${`#/meetings/${e.meetingId}`}>Open notes</a>`
            : html`<button class="btn sm" onClick=${() => go(`/live?event=${e.id}`)}><${Icon} name="mic" /> Take notes</button>`}
        </div>`,
      )}
    <//>`}
  </div>`;
}
