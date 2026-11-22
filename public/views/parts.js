// Setup pieces shared by the first-run wizard and the Settings page.

import { useEffect, useState } from 'preact/hooks';
import { api, copyText, html, Icon, Modal, oops, refreshState, Spinner, toast, useAction, useStore, waitingFor } from '../lib.js';

/* ---------------------------------------------------------- connect email */

function OutlookSetup({ onSaved }) {
  const { state } = useStore();
  const [clientId, setClientId] = useState(state.outlook.clientId);
  const [busy, run] = useAction();
  const save = () =>
    run(async () => {
      await api('/api/outlook-setup', { method: 'PUT', body: { clientId: clientId.trim(), tenant: state.outlook.tenant } });
      await refreshState();
      toast('App ID saved. Choose Outlook again to sign in.');
      onSaved?.();
    });
  return html`<div class="stack">
    <p class="muted">
      Microsoft requires an app registration before any program can read Outlook mail. It is free and done once; the ID is saved in the app
      folder, so people you share Pinger with skip this step.
    </p>
    <ol class="steps">
      <li>
        Open${' '}
        <a href="https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" target="_blank" rel="noreferrer"
          >Microsoft Entra → App registrations</a
        >${' '} and choose <strong>New registration</strong>.
      </li>
      <li>Name: <strong>Pinger</strong>. Supported account types: <strong>Accounts in any organizational directory and personal Microsoft accounts</strong>.</li>
      <li>
        Redirect URI: platform <strong>Public client/native (mobile & desktop)</strong>, value <code>${state.outlook.redirectUri}</code>
      </li>
      <li>Choose <strong>Register</strong>, then copy the <strong>Application (client) ID</strong> into the field below.</li>
    </ol>
    <div class="row">
      <input
        type="text"
        class="mono"
        placeholder="00000000-0000-0000-0000-000000000000"
        aria-label="Application (client) ID"
        value=${clientId}
        onInput=${(e) => setClientId(e.target.value)}
      />
      <button class="btn primary" disabled=${busy || !clientId.trim()} onClick=${save}>Save</button>
    </div>
    <p class="hint">Permissions requested: read mail, read calendar. Nothing is sent, deleted or changed. Work accounts may need IT approval.</p>
  </div>`;
}

function ImapForm({ onConnected }) {
  const [form, setForm] = useState({ email: '', password: '', host: '', port: 993, username: '' });
  const [defaults, setDefaults] = useState(null);
  const [advanced, setAdvanced] = useState(false);
  const [busy, run] = useAction();
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });

  const lookup = async () => {
    if (!form.email.includes('@')) return;
    try {
      const d = await api(`/api/accounts/imap-defaults?email=${encodeURIComponent(form.email)}`);
      setDefaults(d);
      if (!d.known) setAdvanced(true);
      setForm((f) => ({ ...f, host: f.host || d.host, port: f.port || d.port }));
    } catch {
      /* the server validates on submit */
    }
  };

  const submit = (e) => {
    e.preventDefault();
    run(async () => {
      await api('/api/accounts/imap', { method: 'POST', body: form });
      await refreshState();
      toast('Mailbox connected', { body: 'Reading recent mail.' });
      onConnected?.();
    });
  };

  const gmail = /@(gmail|googlemail)\.com$/i.test(form.email);
  return html`<form class="stack" onSubmit=${submit}>
    <div class="field">
      <label for="imap-email">Email address</label>
      <input id="imap-email" type="email" required autocomplete="username" value=${form.email} onInput=${set('email')} onBlur=${lookup} />
    </div>
    ${defaults?.microsoft && html`<div class="banner">Outlook.com, Hotmail and Microsoft 365 no longer accept app passwords. Use the Outlook option.</div>`}
    <div class="field">
      <label for="imap-pass">App password</label>
      <input id="imap-pass" type="password" required autocomplete="off" value=${form.password} onInput=${set('password')} />
      <span class="hint">
        ${gmail
          ? html`Gmail requires an app password: turn on 2-Step Verification, then create one at${' '}
              <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">myaccount.google.com/apppasswords</a>.`
          : 'Most providers require an app password created in the account security settings. The normal password usually fails.'}
      </span>
    </div>
    ${advanced
      ? html`<div class="row top">
            <div class="field grow">
              <label for="imap-host">IMAP server</label>
              <input id="imap-host" type="text" class="mono" value=${form.host} onInput=${set('host')} placeholder="imap.example.com" />
            </div>
            <div class="field" style="width:90px">
              <label for="imap-port">Port</label>
              <input id="imap-port" type="number" value=${form.port} onInput=${set('port')} />
            </div>
          </div>
          <div class="field">
            <label for="imap-user">Username <span class="muted" style="font-weight:400">if different from the address</span></label>
            <input id="imap-user" type="text" value=${form.username} onInput=${set('username')} />
          </div>`
      : html`<button type="button" class="btn ghost sm" style="align-self:flex-start" onClick=${() => setAdvanced(true)}>Server settings</button>`}
    <div class="row wrap">
      <button class="btn primary" disabled=${busy}>${busy ? html`<${Spinner} /> Checking` : 'Connect'}</button>
      <span class="hint">Opened read-only. The password is stored on this computer only.</span>
    </div>
  </form>`;
}

function OutlookWebSetup({ onConnected }) {
  const { state } = useStore();
  const [email, setEmail] = useState(state.settings.profile.emails[0] || '');
  const [busy, run] = useAction();
  const connect = (e) => {
    e.preventDefault();
    run(async () => {
      await api('/api/accounts/outlook-web', { method: 'POST', body: { email } });
      await refreshState();
      toast('Outlook in the browser connected', { body: 'Open Outlook on the web in this browser. Pinger reads it as you use it.' });
      onConnected?.();
    });
  };
  return html`<form class="stack" onSubmit=${connect}>
    <p class="muted">
      Pinger's browser extension reads Outlook on the web as you use it and passes what is on screen to Pinger on this computer. No
      Microsoft registration, and nothing goes anywhere else.
    </p>
    <ol class="steps">
      <li>
        Install the extension in Chrome or Edge: open <code>chrome://extensions</code> (Edge: <code>edge://extensions</code>), turn on
        <strong>Developer mode</strong>, choose <strong>Load unpacked</strong>, and select <code>${state.extensionDir}</code>. Already
        installed? Press its reload button so it picks up Outlook reading.
      </li>
      <li>Enter the address of the mailbox you use in Outlook, below.</li>
      <li>Open Outlook on the web (outlook.office.com or outlook.live.com) in that browser and look at your Inbox.</li>
    </ol>
    <div class="row">
      <input type="email" required placeholder="you@company.com" aria-label="Mailbox address" value=${email} onInput=${(e) => setEmail(e.target.value)} />
      <button class="btn primary" disabled=${busy || !email.includes('@')}>Connect</button>
    </div>
    <p class="hint">
      Pinger reads the messages Outlook has loaded, and the full text of conversations you open. It never opens messages itself, because
      that would mark them as read. Use <strong>Scan inbox</strong> to read further back.
    </p>
  </form>`;
}

const FOLDER_NAME = { inbox: 'Inbox', sent: 'Sent Items', other: 'another folder', skip: 'a folder Pinger skips' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Live status of Outlook-in-the-browser reading, with Scan and diagnostics. */
export function OutlookWebStatus({ compact = false }) {
  const { state } = useStore();
  const ow = state.outlookWeb;
  const [busy, run] = useAction();
  const [diag, setDiag] = useState(null);
  if (!ow?.connected) return null;

  const scanning = ow.scan.state !== 'idle';
  const scan = () =>
    run(async () => {
      await api('/api/outlook-web/scan', { method: 'POST' });
      await refreshState();
    });
  const collect = () =>
    run(async () => {
      await api('/api/outlook-web/diagnose', { method: 'POST' });
      for (let i = 0; i < 25; i++) {
        await sleep(1000);
        const d = await api('/api/outlook-web/diagnostics');
        if (d.structure) {
          setDiag(JSON.stringify(d, null, 1));
          return;
        }
      }
      throw new Error('Outlook did not answer. Keep Outlook on the web open in this browser, with the Pinger extension installed.');
    });

  let text;
  if (scanning) text = ow.scan.state === 'requested' ? 'Starting scan…' : `Scanning the message list… (${ow.scan.pages} screens)`;
  else if (ow.live) text = `Reading Outlook · ${FOLDER_NAME[ow.folder] || 'Outlook'} · ${ow.rows} messages on screen${ow.pane ? `, ${ow.pane} open` : ''}`;
  else if (ow.lastSeenAt) text = `Outlook last seen ${waitingFor(ow.lastSeenAt)}. Open Outlook on the web in this browser.`;
  else text = 'Waiting for Outlook. Open Outlook on the web in Chrome or Edge, with the Pinger extension installed.';

  const scanButton = html`<button class="btn sm" disabled=${busy || scanning || !ow.live} title=${ow.live ? 'Scroll back through the message list to read older mail' : 'Open Outlook first'} onClick=${scan}>
    ${scanning ? html`<${Spinner} />` : null} Scan inbox
  </button>`;

  if (compact) {
    return html`<div class="row" style="padding:5px 10px;border-bottom:1px solid var(--border);font-size:12px">
      <span class=${`dot ${ow.live ? 'high' : ''}`} style=${ow.live ? 'background:var(--ok)' : ''}></span>
      <span class="grow truncate muted">${text}</span>
      ${scanButton}
    </div>`;
  }
  return html`<div class="stack tight">
    <div class="row wrap">
      <span class=${`dot`} style=${ow.live ? 'background:var(--ok)' : ''}></span>
      <span class="grow">${text}</span>
      ${scanButton}
      <button class="btn sm" disabled=${busy} title="Page structure and counts only — no email text, names or addresses" onClick=${collect}>Diagnostic info</button>
    </div>
    ${ow.scan.error && html`<div class="banner error">${ow.scan.error}</div>`}
    ${ow.scan.finishedAt && !scanning && !ow.scan.error && html`<span class="hint">Last scan finished ${waitingFor(ow.scan.finishedAt)}.</span>`}
    ${diag &&
    html`<${Modal} wide title="Diagnostic info" onClose=${() => setDiag(null)}>
      <div class="modal-body">
        <p class="muted">
          How Outlook's page is built, and how much of it Pinger could read. It contains no email text, names or addresses. Send it to whoever
          maintains your copy of Pinger if Outlook reading stops working.
        </p>
        <textarea readonly style="min-height:260px;font-family:var(--mono);font-size:11.5px" value=${diag}></textarea>
      </div>
      <div class="modal-foot">
        <button class="btn" onClick=${() => setDiag(null)}>Close</button>
        <button class="btn primary" onClick=${() => copyText(diag)}><${Icon} name="copy" /> Copy</button>
      </div>
    <//>`}
  </div>`;
}

export function ConnectEmail({ onConnected }) {
  const { state } = useStore();
  const [mode, setMode] = useState(null);
  const [busy, run] = useAction();
  const hasDemo = state.accounts.some((a) => a.kind === 'demo');

  const demo = () =>
    run(async () => {
      await api('/api/accounts/demo', { method: 'POST' });
      await refreshState();
      toast('Sample mailbox added', { body: 'A sample meeting starts in two minutes.', ms: 9000 });
      onConnected?.();
    });

  const outlook = () => {
    if (state.outlook.clientId) location.href = '/auth/microsoft/start';
    else setMode(mode === 'outlook' ? null : 'outlook');
  };

  const desktop = () =>
    run(async () => {
      await api('/api/accounts/outlook-desktop', { method: 'POST' });
      await refreshState();
      toast('Outlook connected', { body: 'Reading your mailbox from the Outlook app.' });
      onConnected?.();
    });

  return html`<div class="stack">
    <div class="options">
      ${state.outlookDesktop &&
      html`<button class="option" disabled=${busy} onClick=${desktop}>
        <strong>${busy ? 'Connecting…' : 'Outlook app on this PC'}</strong>
        <span class="small muted">Reads the Outlook desktop app you're already signed into. No setup, no IT approval.</span>
      </button>`}
      <button class="option" onClick=${outlook}>
        <strong>Outlook${state.outlookDesktop ? ' (sign in)' : ''}</strong>
        <span class="small muted">Outlook.com, Hotmail, Microsoft 365, via Microsoft sign-in. Mail and calendar.</span>
      </button>
      <button class="option" disabled=${!!state.outlookWeb?.connected} onClick=${() => setMode(mode === 'owa' ? null : 'owa')}>
        <strong>${state.outlookWeb?.connected ? 'Outlook in the browser added' : 'Outlook in the browser'}</strong>
        <span class="small muted">Reads Outlook on the web as you use it, through Pinger's browser extension. No Microsoft setup.</span>
      </button>
      <button class="option" onClick=${() => setMode(mode === 'imap' ? null : 'imap')}>
        <strong>Gmail and others</strong>
        <span class="small muted">Gmail, iCloud, Yahoo, Fastmail, any IMAP mailbox.</span>
      </button>
      <button class="option" disabled=${busy || hasDemo} onClick=${demo}>
        <strong>${busy ? 'Adding…' : hasDemo ? 'Sample data added' : 'Sample data'}</strong>
        <span class="small muted">A made-up mailbox and calendar for trying Pinger.</span>
      </button>
    </div>
    ${mode === 'outlook' && html`<div class="card pad"><${OutlookSetup} onSaved=${() => setMode(null)} /></div>`}
    ${mode === 'owa' &&
    html`<div class="card pad">
      <${OutlookWebSetup}
        onConnected=${() => {
          setMode(null);
          onConnected?.();
        }}
      />
    </div>`}
    ${mode === 'imap' &&
    html`<div class="card pad">
      <${ImapForm}
        onConnected=${() => {
          setMode(null);
          onConnected?.();
        }}
      />
    </div>`}
  </div>`;
}

/* ------------------------------------------------------- overview schedule */

const pad = (n) => String(n).padStart(2, '0');

function spreadTimes(count) {
  if (count <= 0) return [];
  if (count === 1) return ['09:00'];
  const start = 9 * 60;
  const end = 17 * 60;
  const out = [];
  for (let i = 0; i < count; i++) {
    const m = Math.round((start + ((end - start) * i) / (count - 1)) / 15) * 15;
    out.push(`${pad(Math.floor(m / 60))}:${pad(m % 60)}`);
  }
  return [...new Set(out)];
}

export function OverviewSchedule() {
  const { state } = useStore();
  const overview = state.settings.overview;
  const [times, setTimes] = useState(overview.times);
  useEffect(() => setTimes(overview.times), [overview.times.join(',')]);

  const save = async (patch) => {
    try {
      await api('/api/settings', { method: 'PUT', body: { overview: patch } });
      await refreshState();
    } catch (err) {
      oops(err);
    }
  };
  const setCount = (n) => {
    const count = Math.max(0, Math.min(8, n));
    const next = spreadTimes(count);
    setTimes(next);
    save({ times: next, enabled: count > 0 });
  };
  const editTime = (i, value) => {
    if (!value) return;
    const next = times.map((t, j) => (j === i ? value : t));
    setTimes(next);
    save({ times: next });
  };

  const count = overview.enabled ? times.length : 0;
  return html`<div class="stack">
    <div class="row wrap">
      <div class="stepper" role="group" aria-label="Overviews per day">
        <button aria-label="Fewer overviews" onClick=${() => setCount(count - 1)}>−</button>
        <span class="value" aria-live="polite">${count}</span>
        <button aria-label="More overviews" onClick=${() => setCount(count + 1)}>+</button>
      </div>
      <span>${count === 0 ? 'Scheduled overviews off' : count === 1 ? 'overview per day' : 'overviews per day'}</span>
    </div>
    ${count > 0 &&
    html`<div class="times">
        ${times.map(
          (t, i) => html`<input type="time" aria-label=${`Overview ${i + 1} time`} value=${t} onChange=${(e) => editTime(i, e.target.value)} />`,
        )}
      </div>
      <label class="checkline">
        <input type="checkbox" checked=${overview.weekdaysOnly} onChange=${(e) => save({ weekdaysOnly: e.target.checked })} />
        Weekdays only
      </label>`}
  </div>`;
}

/* ------------------------------------------------------------------ AI key */

export function AiKeyForm() {
  const { state } = useStore();
  const [key, setKey] = useState('');
  const [busy, run] = useAction();
  const [test, setTest] = useState(null);
  const { apiKeySet, apiKeyHint, model } = state.settings.ai;

  const save = (apiKey) =>
    run(async () => {
      await api('/api/settings', { method: 'PUT', body: { ai: { apiKey } } });
      await refreshState();
      setKey('');
      setTest(null);
      toast(apiKey ? 'AI key saved' : 'AI key removed');
    });

  const check = () =>
    run(async () => {
      setTest({ state: 'testing' });
      const r = await api('/api/ai/test', { method: 'POST' });
      setTest(r.ok ? { state: 'ok', model: r.model } : { state: 'fail', error: r.error });
    });

  return html`<div class="stack">
    ${apiKeySet
      ? html`<div class="stack tight">
          <div class="row wrap">
            <span class="chip good">AI on</span>
            <code>${apiKeyHint}</code>
            <button class="btn sm" disabled=${busy} onClick=${check}>${test?.state === 'testing' ? html`<${Spinner} /> Testing` : 'Test key'}</button>
            <button class="btn sm danger" disabled=${busy} onClick=${() => save('')}>Remove key</button>
          </div>
          ${test?.state === 'ok' && html`<div class="banner good">Your key works. Replies and summaries are on.</div>`}
          ${test?.state === 'fail' && html`<div class="banner error">${test.error}</div>`}
        </div>`
      : html`<div class="row">
          <input
            type="password"
            class="mono"
            autocomplete="off"
            placeholder="sk-ant-…"
            aria-label="Claude API key"
            value=${key}
            onInput=${(e) => setKey(e.target.value)}
          />
          <button class="btn primary" disabled=${busy || key.trim().length < 20} onClick=${() => save(key.trim())}>Save key</button>
        </div>`}
    ${state.ai.enabled && !apiKeySet && html`<p class="hint">Using the key in the <code>ANTHROPIC_API_KEY</code> environment variable.</p>`}
    <div class="field">
      <label for="ai-model">Model</label>
      <select
        id="ai-model"
        class="inline"
        value=${model}
        onChange=${(e) => run(async () => {
          await api('/api/settings', { method: 'PUT', body: { ai: { model: e.target.value } } });
          await refreshState();
        })}
      >
        ${state.models.map((m) => html`<option value=${m.id}>${m.label} — ${m.note}</option>`)}
      </select>
    </div>
    ${(apiKeySet || state.ai.enabled) &&
    html`<label class="checkline">
      <input
        type="checkbox"
        checked=${state.settings.ai.autoDraft}
        onChange=${(e) => run(async () => {
          await api('/api/settings', { method: 'PUT', body: { ai: { autoDraft: e.target.checked } } });
          await refreshState();
          toast(e.target.checked ? 'Auto-draft on. Pinger will write a reply for each new email that needs one.' : 'Auto-draft off.');
        })}
      />
      <span>Auto-draft replies <span class="muted" style="font-weight:400">— pre-write a reply for each email that needs one, ready to edit. Uses your key on each new email.</span></span>
    </label>`}
    <p class="hint">
      Keys are issued at <a href="https://platform.claude.com" target="_blank" rel="noreferrer">platform.claude.com</a>. With a key, the text of
      emails that may need a reply and of your meeting transcripts is sent to Anthropic's Claude API, billed to you by Anthropic. Without a
      key, built-in rules are used and nothing leaves this computer.
    </p>
  </div>`;
}

/* ----------------------------------------------------------- notifications */

export function notificationPermission() {
  return 'Notification' in window ? Notification.permission : 'unsupported';
}

export function NotificationSetup({ onChange }) {
  const [permission, setPermission] = useState(notificationPermission());
  const [busy, run] = useAction();

  const enable = async () => {
    const result = await Notification.requestPermission();
    setPermission(result);
    onChange?.(result);
    window.dispatchEvent(new Event('pinger:notify-permission'));
    if (result === 'granted') toast('Notifications on');
  };
  const test = () => run(() => api('/api/pings/test', { method: 'POST' }));

  return html`<div class="stack">
    ${permission === 'granted' && html`<div class="row wrap"><span class="chip good">Browser notifications on</span></div>`}
    ${permission === 'default' &&
    html`<div class="row wrap">
      <button class="btn primary" onClick=${enable}><${Icon} name="bell" /> Turn on notifications</button>
      <span class="hint">The browser asks for permission.</span>
    </div>`}
    ${permission === 'denied' &&
    html`<div class="banner">
      Notifications are blocked for this page. Allow them from the icon left of the address bar. Until then, pings use the system notification
      centre only while this tab is closed.
    </div>`}
    ${permission === 'unsupported' && html`<div class="banner">This browser does not support notifications.</div>`}
    <div class="row wrap">
      <button class="btn sm" disabled=${busy} onClick=${test}>Send test ping</button>
      <span class="hint">Pings show in this window, and as desktop notifications when another window has focus.</span>
    </div>
  </div>`;
}
