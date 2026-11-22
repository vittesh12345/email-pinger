import { useRef, useState } from 'preact/hooks';
import {
  api, dueLabel, fmtDateTime, fmtTime, go, html, Icon, localDate, Modal, oops, relativeDay, Spinner, toast, useAction, useData, useStore,
} from '../lib.js';

/* ------------------------------------------------------------ add meeting */

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error('The file could not be read.'));
    reader.readAsDataURL(file);
  });
}

function AddMeeting({ onClose }) {
  const [title, setTitle] = useState('');
  const [date, setDate] = useState(localDate());
  const [text, setText] = useState('');
  const [attendees, setAttendees] = useState('');
  const [file, setFile] = useState(null);
  const [over, setOver] = useState(false);
  const [busy, run] = useAction();
  const input = useRef(null);

  const startedAt = () => new Date(`${date || localDate()}T${new Date().toTimeString().slice(0, 5)}:00`).toISOString();
  const people = () => attendees.split(',').map((s) => s.trim()).filter(Boolean);

  const sample = () =>
    run(async () => {
      const s = await api('/api/meetings/sample');
      setTitle(s.title);
      setText(s.transcript);
      setAttendees(s.attendees.join(', '));
      setFile(null);
    });

  const save = () =>
    run(async () => {
      let res;
      if (file) {
        if (file.size > 12 * 1024 * 1024) throw new Error('The file is larger than 12 MB.');
        res = await api('/api/meetings/import', {
          method: 'POST',
          body: { filename: file.name, dataBase64: await readAsBase64(file), title, startedAt: startedAt(), attendees: people() },
        });
      } else {
        res = await api('/api/meetings', { method: 'POST', body: { title, transcript: text, startedAt: startedAt(), attendees: people() } });
      }
      onClose();
      go(`/meetings/${res.meeting.id}`);
    });

  const drop = (e) => {
    e.preventDefault();
    setOver(false);
    const f = e.dataTransfer?.files?.[0];
    if (f) setFile(f);
  };

  return html`<${Modal} onClose=${onClose} wide title="Add transcript">
    <div class="modal-body">
      <div class="row top wrap">
        <div class="field grow" style="flex:1 1 240px">
          <label for="m-title">Title</label>
          <input id="m-title" type="text" placeholder="Q4 planning with Dana" value=${title} onInput=${(e) => setTitle(e.target.value)} />
        </div>
        <div class="field">
          <label for="m-date">Date</label>
          <input id="m-date" type="date" class="inline" value=${date} onInput=${(e) => setDate(e.target.value)} />
        </div>
      </div>
      <div class="field">
        <label for="m-people">Attendees <span class="muted" style="font-weight:400">optional, comma-separated</span></label>
        <input id="m-people" type="text" value=${attendees} onInput=${(e) => setAttendees(e.target.value)} />
      </div>
      ${file
        ? html`<div class="account">
            <${Icon} name="upload" />
            <div class="grow truncate">${file.name}</div>
            <span class="mono faint">${Math.max(1, Math.round(file.size / 1024))} KB</span>
            <button class="btn sm" onClick=${() => setFile(null)}>Remove</button>
          </div>`
        : html`<div class="field">
              <label for="m-text">Transcript or notes</label>
              <textarea id="m-text" style="min-height:160px" placeholder="Paste the transcript" value=${text} onInput=${(e) => setText(e.target.value)}></textarea>
            </div>
            <div
              class=${`dropzone${over ? ' over' : ''}`}
              role="button"
              tabindex="0"
              onClick=${() => input.current.click()}
              onKeyDown=${(e) => e.key === 'Enter' && input.current.click()}
              onDragOver=${(e) => {
                e.preventDefault();
                setOver(true);
              }}
              onDragLeave=${() => setOver(false)}
              onDrop=${drop}
            >
              <${Icon} name="upload" />
              <span>Or choose a file: <span class="mono">.vtt .docx .srt .txt</span> — the formats Teams, Zoom and Meet export.</span>
              <input ref=${input} type="file" accept=".vtt,.srt,.txt,.md,.docx,text/plain" hidden onChange=${(e) => setFile(e.target.files[0] || null)} />
            </div>`}
    </div>
    <div class="modal-foot">
      <button class="btn ghost" style="margin-right:auto" disabled=${busy} onClick=${sample}>Load sample</button>
      <button class="btn" onClick=${onClose}>Cancel</button>
      <button class="btn primary" disabled=${busy || (!file && !text.trim())} onClick=${save}>${busy ? html`<${Spinner} />` : null} Save</button>
    </div>
  <//>`;
}

/* ------------------------------------------------------------------- ask */

function Ask() {
  const { state } = useStore();
  const [q, setQ] = useState('');
  const [result, setResult] = useState(null);
  const [busy, run] = useAction();
  const ask = (e) => {
    e.preventDefault();
    if (!q.trim()) return;
    run(async () => setResult(await api('/api/ask', { method: 'POST', body: { question: q } })));
  };
  return html`<section class="card pad stack">
    <form class="row" onSubmit=${ask}>
      <input
        type="search"
        placeholder=${state.ai.enabled ? 'Ask about past meetings, e.g. What did we decide about the launch date?' : 'Search past meetings'}
        aria-label="Ask or search your meetings"
        value=${q}
        onInput=${(e) => setQ(e.target.value)}
      />
      <button class="btn" disabled=${busy || !q.trim()}>
        ${busy ? html`<${Spinner} />` : html`<${Icon} name="search" />`} ${state.ai.enabled ? 'Ask' : 'Search'}
      </button>
    </form>
    ${result &&
    html`<div class="stack tight">
      ${result.answer && html`<p class="pre">${result.answer}</p>`}
      ${result.needsAi && !result.sources.length && html`<p class="muted">No matches.</p>`}
      ${result.sources.length > 0 &&
      html`<div class="stack tight">
        <span class="label muted">${result.answer ? 'Sources' : 'Matches'}</span>
        ${result.sources.map(
          (s) => html`<a href=${`#/meetings/${s.id}`}>
            ${s.title} <span class="mono faint">${relativeDay(s.startedAt)}</span>${!result.answer && s.snippet ? html` <span class="muted">${s.snippet}</span>` : ''}
          </a>`,
        )}
      </div>`}
      ${result.needsAi && html`<p class="hint">Search only. Written answers require an AI key (Settings → AI).</p>`}
    </div>`}
  </section>`;
}

/* ------------------------------------------------------------------ list */

export function Meetings() {
  const [adding, setAdding] = useState(false);
  const { data } = useData(() => api('/api/meetings'), ['meetings', 'followups']);
  const events = useData(() => api('/api/events'), ['events', 'meetings']);
  const upcoming = events.data?.events || [];
  const meetings = data?.meetings || [];

  return html`<div class="page">
    <div class="page-head">
      <div class="grow">
        <h1>Meetings</h1>
        <p class="sub">Transcripts, notes, and the follow-ups that came out of them.</p>
      </div>
      <button class="btn" onClick=${() => setAdding(true)}><${Icon} name="plus" /> Add transcript</button>
      <button class="btn primary" onClick=${() => go('/live')}><${Icon} name="mic" /> Record</button>
    </div>

    <section class="card">
      <div class="card-head"><h2>Upcoming</h2><span class="small faint">Pinger asks about notes when each one starts</span></div>
      <div class="list">
        ${upcoming.slice(0, 6).map(
          (e) => html`<div class="item row">
            <span class="mono nowrap" style="width:132px">${relativeDay(e.startAt)} ${fmtTime(e.startAt)}</span>
            <span class="grow truncate">${e.title}</span>
            ${e.joinUrl && html`<a class="btn sm ghost" href=${e.joinUrl} target="_blank" rel="noreferrer">Join <${Icon} name="external" /></a>`}
            ${e.meetingId
              ? html`<a class="btn sm" href=${`#/meetings/${e.meetingId}`}>Open notes</a>`
              : html`<button class="btn sm" onClick=${() => go(`/live?event=${e.id}`)}><${Icon} name="mic" /> Take notes</button>`}
          </div>`,
        )}
        ${events.data && !upcoming.length && html`<div class="empty">Nothing in the next 36 hours, or no calendar connected. Outlook calendars connect with the account; add others under <a href="#/settings?focus=calendar">Settings → Calendar</a>.</div>`}
      </div>
    </section>

    <${Ask} />

    <section class="card">
      <div class="card-head"><h2>Past meetings <span class="mono">${data ? meetings.length : ''}</span></h2></div>
      <div class="list">
        ${!data && html`<div class="empty"><${Spinner} /></div>`}
        ${data && !meetings.length && html`<div class="empty">No meetings saved. Record one, or add a transcript.</div>`}
        ${meetings.map(
          (m) => html`<a class="item clickable" href=${m.status === 'live' ? `#/live/${m.id}` : `#/meetings/${m.id}`}>
            <div class="item-head">
              <span class="who">${m.title}</span>
              <span class="subject"></span>
              ${m.status === 'live' && html`<span class="chip high">Recording</span>`}
              ${m.openFollowups > 0 && html`<span class="chip plain"><span class="mono">${m.openFollowups}</span> follow-up${m.openFollowups === 1 ? '' : 's'}</span>`}
              ${m.analysisStatus === 'error' && html`<span class="chip medium">Summary failed</span>`}
              <span class="when">${relativeDay(m.startedAt)}</span>
            </div>
            <p class="summary">
              ${m.status === 'live' ? 'In progress. Open to continue.' : m.analysisStatus === 'pending' ? 'Reading the transcript…' : m.summary || (m.hasTranscript ? 'Transcript saved.' : 'Notes saved.')}
            </p>
          </a>`,
        )}
      </div>
    </section>
    ${adding && html`<${AddMeeting} onClose=${() => setAdding(false)} />`}
  </div>`;
}

/* ---------------------------------------------------------------- detail */

function List({ title, items }) {
  if (!items?.length) return null;
  return html`<div class="stack tight">
    <h2>${title}</h2>
    <ul class="clean">${items.map((i) => html`<li>${i}</li>`)}</ul>
  </div>`;
}

export function MeetingDetail({ id }) {
  const { data, error } = useData(() => api(`/api/meetings/${id}`), ['meetings', 'followups'], [id]);
  const [busy, run] = useAction();
  const [showTranscript, setShowTranscript] = useState(false);

  if (error) return html`<div class="page"><a href="#/meetings">Meetings</a><div class="banner error">${error.message}</div></div>`;
  if (!data) return html`<div class="page"><div class="empty"><${Spinner} /></div></div>`;
  const { meeting: m, followups } = data;
  const a = m.analysis;
  const pending = m.analysisStatus === 'pending';

  const reanalyze = () => run(() => api(`/api/meetings/${id}/analyze`, { method: 'POST' }));
  const rename = () => {
    const title = prompt('Meeting title', m.title);
    if (title?.trim()) run(() => api(`/api/meetings/${id}`, { method: 'PATCH', body: { title } }));
  };
  const remove = () => {
    if (!confirm(`Delete “${m.title}” and its follow-ups? This cannot be undone.`)) return;
    run(async () => {
      await api(`/api/meetings/${id}`, { method: 'DELETE' });
      toast('Meeting deleted');
      go('/meetings');
    });
  };
  const setDone = (f, done) => api(`/api/followups/${f.id}`, { method: 'PATCH', body: { status: done ? 'done' : 'open' } }).catch(oops);
  const words = m.transcript?.trim() ? m.transcript.trim().split(/\s+/).length : 0;

  return html`<div class="page">
    <div class="page-head">
      <div class="grow">
        <p class="small"><a href="#/meetings">Meetings</a> <span class="faint">/</span></p>
        <h1>${m.title}</h1>
        <p class="sub"><span class="mono">${fmtDateTime(m.startedAt)}</span>${m.attendees.length ? ` · ${m.attendees.join(', ')}` : ''}</p>
      </div>
      <button class="btn sm" onClick=${rename}>Rename</button>
      <button class="btn sm" disabled=${busy || pending} title="Analyse the transcript again" onClick=${reanalyze}><${Icon} name="refresh" /> Re-analyse</button>
      <button class="btn sm danger" disabled=${busy} onClick=${remove}><${Icon} name="trash" /> Delete</button>
    </div>

    ${pending && html`<div class="banner info busy"><${Spinner} /> Reading the transcript…</div>`}
    ${m.analysisStatus === 'error' && html`<div class="banner error">Summary failed: ${m.analysisError} <a href="#" onClick=${(e) => { e.preventDefault(); reanalyze(); }}>Retry</a></div>`}
    ${a?.empty && html`<div class="banner info">Too little text to summarize. Add the transcript or notes.</div>`}
    ${a && a.source === 'rules' && !a.empty &&
    html`<div class="banner info">
      No AI key: only sentences that read like commitments are listed. <a href="#/settings?focus=ai">Add an AI key</a> for a summary, decisions and dated follow-ups.
    </div>`}

    ${m.summary &&
    html`<section class="card brief">
      <p class="text">${m.summary}</p>
      <p class="meta-line">AI summary. Check anything important against the transcript.</p>
    </section>`}

    ${followups.length > 0 &&
    html`<section class="card">
      <div class="card-head"><h2>Your follow-ups <span class="mono">${followups.length}</span></h2><a class="small" href="#/followups">View all</a></div>
      <div class="list">
        ${followups.map((f) => {
          const due = dueLabel(f.dueOn);
          const done = f.status !== 'open';
          return html`<div class="item row top">
            <input type="checkbox" class="check" checked=${done} aria-label=${`Mark “${f.title}” done`} onChange=${(e) => setDone(f, e.target.checked)} />
            <div class="grow">
              <div class=${done ? 'done-text' : ''}>${f.title}</div>
              ${f.detail && html`<div class="small muted">${f.detail}</div>`}
              ${((!done && due) || f.person) &&
              html`<div class="meta" style="margin-top:2px">
                ${!done && due && html`<span class=${`chip ${due.cls}`}>${due.text}</span>`}
                ${f.kind === 'waiting' ? html`<span class="chip plain">Waiting on ${f.person || 'someone'}</span>` : f.person && html`<span class="chip plain">${f.person}</span>`}
              </div>`}
            </div>
          </div>`;
        })}
      </div>
    </section>`}

    ${a &&
    (a.key_points?.length || a.decisions?.length || a.action_items?.length || a.open_questions?.length) > 0 &&
    html`<section class="card pad stack loose">
      <${List} title="Key points" items=${a.key_points} />
      <${List} title="Decisions" items=${a.decisions} />
      ${a.action_items?.length > 0 &&
      html`<div class="stack tight">
        <h2>${a.source === 'ai' ? 'Action items' : 'Possible commitments'}</h2>
        <table class="simple">
          <thead><tr><th style="width:160px">Owner</th><th>Task</th><th style="width:80px">Due</th></tr></thead>
          <tbody>
            ${a.action_items.map(
              (i) => html`<tr>
                <td>${i.owner}${i.mine && i.owner !== 'You' ? html` <span class="chip plain">you</span>` : ''}</td>
                <td>${i.task}</td>
                <td class="mono nowrap">${i.due ? new Date(`${i.due}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '—'}</td>
              </tr>`,
            )}
          </tbody>
        </table>
      </div>`}
      <${List} title="Open questions" items=${a.open_questions} />
    </section>`}

    ${m.notes?.trim() && html`<section class="card pad stack tight"><h2>Your notes</h2><div class="pre">${m.notes}</div></section>`}

    ${words > 0 &&
    html`<section class="card pad stack">
      <div class="row">
        <h2 class="grow">Transcript <span class="mono">${words} words</span></h2>
        <button class="btn sm" onClick=${() => setShowTranscript(!showTranscript)}>${showTranscript ? 'Hide' : 'Show'}</button>
      </div>
      ${showTranscript && html`<div class="transcript pre">${m.transcript}</div>`}
    </section>`}
  </div>`;
}
