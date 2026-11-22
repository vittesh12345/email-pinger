import { useEffect, useState } from 'preact/hooks';
import { api, go, html, Icon, oops, refreshState, timeAgo, toast, useAction, useStore } from '../lib.js';
import { popOut } from '../popout.js';
import { AiKeyForm, ConnectEmail, NotificationSetup, OverviewSchedule } from './parts.js';

const KIND_LABEL = { outlook: 'Outlook', imap: 'IMAP', demo: 'Sample' };

function Section({ id, title, sub, children }) {
  return html`<section class="card section" id=${id}>
    <div class="card-head"><h2>${title}</h2>${sub && html`<span class="small faint truncate">${sub}</span>`}</div>
    <div class="section-body">${children}</div>
  </section>`;
}

async function saveSettings(patch) {
  try {
    await api('/api/settings', { method: 'PUT', body: patch });
    await refreshState();
  } catch (err) {
    oops(err);
  }
}

function Profile() {
  const { state } = useStore();
  const p = state.settings.profile;
  const [name, setName] = useState(p.name);
  const [emails, setEmails] = useState(p.emails.join(', '));
  const dirty = name !== p.name || emails !== p.emails.join(', ');
  return html`<${Section} id="you" title="You" sub="Identifies you in transcripts; signs drafted replies">
    <div class="row top wrap">
      <div class="field" style="flex:1 1 200px">
        <label for="p-name">Name</label>
        <input id="p-name" type="text" value=${name} onInput=${(e) => setName(e.target.value)} />
      </div>
      <div class="field" style="flex:2 1 280px">
        <label for="p-emails">Other addresses you send from <span class="muted" style="font-weight:400">optional, comma-separated</span></label>
        <input id="p-emails" type="text" placeholder="alias@example.com" value=${emails} onInput=${(e) => setEmails(e.target.value)} />
      </div>
      <button
        class="btn primary"
        style="align-self:flex-end"
        disabled=${!dirty}
        onClick=${async () => {
          await saveSettings({ profile: { name, emails: emails.split(',').map((s) => s.trim()).filter(Boolean) } });
          toast('Saved', { ms: 2000 });
        }}
      >
        Save
      </button>
    </div>
  <//>`;
}

function Accounts() {
  const { state } = useStore();
  const [busy, run] = useAction();
  const remove = (a) => {
    if (!confirm(`Disconnect ${a.email}? Its mail is removed from Pinger. The mailbox itself is not changed.`)) return;
    run(async () => {
      await api(`/api/accounts/${a.id}`, { method: 'DELETE' });
      await refreshState();
    });
  };
  const changeAppId = async () => {
    if (!confirm('Remove the Outlook app ID? It must be entered again before connecting Outlook accounts.')) return;
    try {
      await api('/api/outlook-setup', { method: 'PUT', body: { clientId: '' } });
      await refreshState();
    } catch (err) {
      oops(err);
    }
  };
  return html`<${Section} id="accounts" title="Email accounts" sub="Read-only. Pinger cannot send, delete or change mail">
    ${state.accounts.map((a) => {
      const age = a.lastSyncAt ? timeAgo(a.lastSyncAt) : null;
      return html`<div class="account">
        <span class="chip plain">${KIND_LABEL[a.kind] || a.kind}</span>
        <div class="grow truncate">${a.email}</div>
        ${a.status === 'ok'
          ? html`<span class="small faint">${age ? html`checked <span class="mono">${age}</span>${age === 'just now' ? '' : ' ago'}` : 'reading mail'}</span>`
          : html`<span class="small" style="color:var(--danger)">${a.statusDetail || 'Account error'}</span>`}
        ${a.kind === 'outlook' && a.status === 'needs_auth' && html`<a class="btn sm primary" href="/auth/microsoft/start">Sign in again</a>`}
        <button class="btn sm danger" disabled=${busy} onClick=${() => remove(a)}>Disconnect</button>
      </div>`;
    })}
    <div class="stack tight">
      <span class="label">${state.accounts.length ? 'Add account' : 'Connect email'}</span>
      <${ConnectEmail} />
    </div>
    ${state.outlook.clientId &&
    html`<p class="hint">Outlook app ID <code>${state.outlook.clientId}</code> <a href="#" onClick=${(e) => { e.preventDefault(); changeAppId(); }}>Change</a></p>`}
  <//>`;
}

function Calendars() {
  const { state } = useStore();
  const urls = state.settings.calendar.icsUrls;
  const [url, setUrl] = useState('');
  const add = async (e) => {
    e.preventDefault();
    if (!url.trim()) return;
    await saveSettings({ calendar: { icsUrls: [...urls, url.trim()] } });
    setUrl('');
  };
  return html`<${Section} id="calendar" title="Calendar" sub="Used for the meeting-start prompt. Outlook calendars are included with the account">
    ${state.status.calendarError && html`<div class="banner error">Calendar failed to load: ${state.status.calendarError}</div>`}
    ${urls.map(
      (u, i) => html`<div class="account">
        <${Icon} name="calendar" />
        <div class="grow truncate mono">${u.replace(/^(https?:\/\/[^/]+\/).*$/, '$1…')}</div>
        <button class="btn sm danger" onClick=${() => saveSettings({ calendar: { icsUrls: urls.filter((_, j) => j !== i) } })}>Remove</button>
      </div>`,
    )}
    <form class="row" onSubmit=${add}>
      <input type="url" placeholder="Private calendar link (.ics)" aria-label="Calendar link" value=${url} onInput=${(e) => setUrl(e.target.value)} />
      <button class="btn" disabled=${!url.trim()}>Add</button>
    </form>
    <p class="hint">Google Calendar: Settings → your calendar → “Secret address in iCal format”. The link works like a password; it is stored on this computer only.</p>
  <//>`;
}

function Rules() {
  const { state } = useStore();
  const f = state.settings.followups;
  const hours = state.settings.pingHours;
  const m = state.settings.meetings;
  const num = (value, fallback) => (Number.isFinite(Number(value)) && value !== '' ? Number(value) : fallback);
  return html`
    <${Section} id="followup-rules" title="Reminders" sub="Pings between overviews">
      <div>
        <div class="setting-row">
          <div class="text"><strong>Nudge when someone has not replied after</strong></div>
          <input class="inline" type="number" min="1" max="30" style="width:60px" aria-label="Days before a nudge" value=${f.awaitingDays}
            onChange=${(e) => saveSettings({ followups: { awaitingDays: num(e.target.value, f.awaitingDays) } })} />
          <span class="muted">days</span>
        </div>
        <div class="setting-row">
          <label class="checkline text">
            <input type="checkbox" checked=${f.pingUrgent} onChange=${(e) => saveSettings({ followups: { pingUrgent: e.target.checked } })} />
            <span>Ping immediately for high-priority mail that needs a reply</span>
          </label>
        </div>
        <div class="setting-row">
          <div class="text"><strong>Repeat reminders for due follow-ups every</strong></div>
          <input class="inline" type="number" min="1" max="168" style="width:60px" aria-label="Hours between reminders" value=${f.remindEveryHours}
            onChange=${(e) => saveSettings({ followups: { remindEveryHours: num(e.target.value, f.remindEveryHours) } })} />
          <span class="muted">hours</span>
        </div>
        <div class="setting-row">
          <div class="text"><strong>Ping only between</strong> <span class="muted">(meeting prompts follow the calendar instead)</span></div>
          <input class="inline" type="time" aria-label="Pings start" value=${hours.start} onChange=${(e) => e.target.value && saveSettings({ pingHours: { start: e.target.value } })} />
          <span class="muted">and</span>
          <input class="inline" type="time" aria-label="Pings end" value=${hours.end} onChange=${(e) => e.target.value && saveSettings({ pingHours: { end: e.target.value } })} />
        </div>
      </div>
    <//>
    <${Section} id="meeting-rules" title="Meetings">
      <div>
        <div class="setting-row">
          <label class="checkline text">
            <input type="checkbox" checked=${m.prompt} onChange=${(e) => saveSettings({ meetings: { prompt: e.target.checked } })} />
            <span>When a meeting starts, ask whether to record and take notes</span>
          </label>
        </div>
        <div class="setting-row">
          <div class="text"><strong>Ask this many minutes before the start</strong></div>
          <input class="inline" type="number" min="0" max="15" style="width:60px" aria-label="Minutes before start" value=${m.leadMinutes}
            onChange=${(e) => saveSettings({ meetings: { leadMinutes: num(e.target.value, m.leadMinutes) } })} />
        </div>
        <div class="setting-row">
          <div class="text"><strong>Spoken language</strong> <span class="muted">(live transcription)</span></div>
          <select class="inline" aria-label="Spoken language" value=${m.language} onChange=${(e) => saveSettings({ meetings: { language: e.target.value } })}>
            ${[
              ['en-US', 'English (US)'], ['en-GB', 'English (UK)'], ['en-IN', 'English (India)'], ['en-AU', 'English (Australia)'],
              ['es-ES', 'Spanish (Spain)'], ['es-MX', 'Spanish (Mexico)'], ['fr-FR', 'French'], ['de-DE', 'German'], ['it-IT', 'Italian'],
              ['pt-BR', 'Portuguese (Brazil)'], ['nl-NL', 'Dutch'], ['hi-IN', 'Hindi'], ['te-IN', 'Telugu'], ['ta-IN', 'Tamil'],
              ['ja-JP', 'Japanese'], ['ko-KR', 'Korean'], ['zh-CN', 'Chinese (Mandarin)'], ['ar-SA', 'Arabic'],
            ].map(([code, label]) => html`<option value=${code}>${label}</option>`)}
          </select>
        </div>
      </div>
    <//>
  `;
}

function Windows() {
  return html`<${Section} id="window" title="Use alongside your mail" sub="Keep Pinger visible while you work in Outlook or another mail app">
    <div class="setting-row">
      <div class="text">
        <strong>Mini window</strong>
        <div class="small muted">A small panel with what needs a reply, nudges, due follow-ups and the meeting-start prompt. In Chrome and Edge it stays on top of other windows.</div>
      </div>
      <button class="btn" onClick=${popOut}><${Icon} name="panel" /> Open mini window</button>
    </div>
    <div class="setting-row">
      <div class="text">
        <strong>Install as an app</strong>
        <div class="small muted">In Chrome or Edge, use the install icon in the address bar (or menu → Install Pinger). Pinger then opens in its own window with a taskbar icon.</div>
      </div>
    </div>
  <//>`;
}

function Sharing() {
  return html`<${Section} id="share" title="Share" sub="Each person runs their own copy; their data stays on their computer">
    <ol class="steps">
      <li>Send the app folder (zipped; <code>node_modules</code> can be left out) or a link to the repository.</li>
      <li>They install <a href="https://nodejs.org" target="_blank" rel="noreferrer">Node.js</a> 22.13 or newer and run <code>start.command</code> (Mac), <code>start.bat</code> (Windows) or <code>./start.sh</code> (Linux).</li>
      <li>Pinger opens in their browser and asks them to connect their own email.</li>
    </ol>
    <p class="hint">
      Your mail, meetings and keys are not in the app folder. The only setting that travels is the Outlook app ID in
      <code>pinger.config.json</code>, which is not a secret.
    </p>
  <//>`;
}

function Data() {
  const { state } = useStore();
  const [busy, run] = useAction();
  const wipe = () => {
    if (prompt('Deletes every account, email, meeting and setting Pinger stores on this computer. Type DELETE to confirm.') !== 'DELETE') return;
    run(async () => {
      await api('/api/data/wipe', { method: 'POST', body: { confirm: 'DELETE' } });
      localStorage.removeItem('pinger.wizard');
      await refreshState();
      toast('All data deleted');
      go('/');
    });
  };
  return html`<${Section} id="data" title="Data" sub=${`Pinger ${state.version}`}>
    <div class="setting-row">
      <div class="text"><strong>Stored at</strong> <code>${state.dataDir}</code></div>
      <button class="btn danger" disabled=${busy} onClick=${wipe}><${Icon} name="trash" /> Delete all data</button>
    </div>
  <//>`;
}

export function Settings({ route }) {
  const { state } = useStore();
  const [busy, run] = useAction();

  useEffect(() => {
    const q = route.query;
    if (q.get('connected')) toast('Outlook connected', { body: 'Reading recent mail and calendar.' });
    if (q.get('error')) toast('Outlook connection failed', { body: q.get('error'), kind: 'error', ms: 15000 });
    if (q.get('outlook') === 'setup') toast('Outlook needs a one-time setup', { body: 'Choose Outlook under Email accounts and follow the steps.' });
    const focus = q.get('focus');
    if (focus) setTimeout(() => document.getElementById(focus)?.scrollIntoView({ block: 'start' }), 100);
    if (q.toString()) history.replaceState(null, '', '#/settings');
  }, []);

  return html`<div class="page">
    <div class="page-head"><div class="grow"><h1>Settings</h1></div></div>
    <${Profile} />
    <${Accounts} />
    <${Section} id="overviews" title="Email overviews" sub="A scheduled summary of what needs a reply and who has not answered">
      <${OverviewSchedule} />
      <div>
        <button
          class="btn"
          disabled=${busy || !state.accounts.length}
          onClick=${() => run(async () => {
            const { digest } = await api('/api/overview', { method: 'POST' });
            toast('Overview ready', { body: digest.brief, url: '/', ms: 9000 });
          })}
        >
          Send one now
        </button>
      </div>
    <//>
    <${Rules} />
    <${Windows} />
    <${Calendars} />
    <${Section} id="ai" title="AI" sub="Optional. Summaries, triage, reply drafts, meeting notes">
      ${state.ai.error && html`<div class="banner error">${state.ai.error}</div>`}
      <${AiKeyForm} />
    <//>
    <${Section} id="notifications" title="Notifications">
      <${NotificationSetup} />
    <//>
    <${Sharing} />
    <${Data} />
  </div>`;
}
