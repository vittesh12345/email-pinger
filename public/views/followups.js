import { useState } from 'preact/hooks';
import { api, dueLabel, fmtDateTime, html, Icon, Menu, snoozeChoices, Spinner, useAction, useData } from '../lib.js';

function AddForm() {
  const blank = { title: '', dueOn: '', person: '', kind: 'todo' };
  const [form, setForm] = useState(blank);
  const [busy, run] = useAction();
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const submit = (e) => {
    e.preventDefault();
    if (!form.title.trim()) return;
    run(async () => {
      await api('/api/followups', { method: 'POST', body: { ...form, dueOn: form.dueOn || null } });
      setForm(blank);
    });
  };
  return html`<form class="card pad row wrap" onSubmit=${submit}>
    <input style="flex:3 1 240px;width:auto" type="text" placeholder="New follow-up, e.g. Send Priya the signed contract" aria-label="Follow-up" value=${form.title} onInput=${set('title')} />
    <select class="inline" aria-label="Type" value=${form.kind} onChange=${set('kind')}>
      <option value="todo">Mine to do</option>
      <option value="waiting">Waiting on someone</option>
    </select>
    <input type="text" placeholder="Who" aria-label="Person" value=${form.person} onInput=${set('person')} style="flex:1 1 110px;width:auto" />
    <input class="inline" type="date" aria-label="Due date" value=${form.dueOn} onInput=${set('dueOn')} />
    <button class="btn primary" disabled=${busy || !form.title.trim()}><${Icon} name="plus" /> Add</button>
  </form>`;
}

function Row({ f }) {
  const [busy, run] = useAction();
  const patch = (body) => run(() => api(`/api/followups/${f.id}`, { method: 'PATCH', body }));
  const due = dueLabel(f.dueOn);
  const done = f.status !== 'open';
  return html`<div class="item row top">
    <input
      type="checkbox"
      class="check"
      checked=${done}
      disabled=${busy}
      aria-label=${`Mark “${f.title}” ${done ? 'not done' : 'done'}`}
      onChange=${() => patch({ status: done ? 'open' : 'done' })}
    />
    <div class="grow">
      <div class=${done ? 'done-text' : ''}>${f.title}</div>
      ${f.detail && html`<div class="muted small">${f.detail}</div>`}
      <div class="meta">
        ${!done && due && html`<span class=${`chip ${due.cls}`}>${due.text}</span>`}
        ${f.kind === 'waiting'
          ? html`<span class="chip plain">Waiting on ${f.person || 'someone'}</span>`
          : f.person && html`<span class="chip plain">${f.person}</span>`}
        ${f.snoozed && html`<span class="chip">Snoozed until ${fmtDateTime(f.snoozeUntil)}</span>`}
        ${f.meetingTitle && html`<a class="small" href=${`#/meetings/${f.meetingId}`}>${f.meetingTitle}</a>`}
        <div class="actions">
          ${!done &&
          html`<input
              class="inline"
              type="date"
              aria-label="Due date"
              style="height:24px"
              value=${f.dueOn || ''}
              onChange=${(e) => patch({ dueOn: e.target.value || null })}
            />
            ${f.snoozed
              ? html`<button class="btn sm" onClick=${() => patch({ snoozeUntil: null })}>Wake</button>`
              : html`<${Menu} label="Snooze" icon="clock" items=${snoozeChoices().map((c) => ({ label: c.label, onSelect: () => patch({ snoozeUntil: c.until }) }))} />`}`}
          <button class="btn sm ghost icon" aria-label="Delete follow-up" title="Delete" disabled=${busy} onClick=${() => run(() => api(`/api/followups/${f.id}`, { method: 'DELETE' }))}>
            <${Icon} name="trash" />
          </button>
        </div>
      </div>
    </div>
  </div>`;
}

const GROUPS = [
  ['overdue', 'Overdue'],
  ['today', 'Today'],
  ['upcoming', 'Upcoming'],
  ['none', 'No date'],
];

const Group = ({ label, cls = '', rows }) =>
  rows.length > 0 &&
  html`<div class=${`group-label ${cls}`}>${label}<span class="mono">${rows.length}</span></div>
    ${rows.map((f) => html`<${Row} key=${f.id} f=${f} />`)}`;

export function Followups() {
  const [showDone, setShowDone] = useState(false);
  const { data, error } = useData(() => api(`/api/followups?status=${showDone ? 'all' : 'open'}`), ['followups', 'meetings'], [showDone]);
  const all = data?.followups || [];
  const open = all.filter((f) => f.status === 'open' && !f.snoozed);
  const snoozed = all.filter((f) => f.status === 'open' && f.snoozed);
  const closed = all.filter((f) => f.status !== 'open');

  return html`<div class="page">
    <div class="page-head">
      <div class="grow">
        <h1>Follow-ups</h1>
        <p class="sub">What you promised and what you are owed. Added from meetings, or by hand.</p>
      </div>
    </div>
    <${AddForm} />
    <section class="card">
      <div class="list">
        ${error && html`<div class="empty">Failed to load: ${error.message}</div>`}
        ${!data && !error && html`<div class="empty"><${Spinner} /></div>`}
        ${data && !open.length && !snoozed.length && html`<div class="empty">No open follow-ups.</div>`}
        ${GROUPS.map(([key, label]) => html`<${Group} label=${label} cls=${key} rows=${open.filter((f) => f.dueState === key)} />`)}
        <${Group} label="Snoozed" rows=${snoozed} />
        ${showDone && html`<${Group} label="Completed" rows=${closed} />`}
      </div>
    </section>
    <label class="checkline small muted">
      <input type="checkbox" checked=${showDone} onChange=${(e) => setShowDone(e.target.checked)} />
      Show completed
    </label>
  </div>`;
}
