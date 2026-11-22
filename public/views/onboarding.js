// First-run setup: name → email → AI (optional) → overview schedule → notifications.

import { useEffect, useState } from 'preact/hooks';
import { api, html, Modal, oops, refreshState, useStore } from '../lib.js';
import { AiKeyForm, ConnectEmail, NotificationSetup, OverviewSchedule } from './parts.js';

const KEY = 'pinger.wizard';
const TITLES = ['Your name', 'Connect email', 'AI (optional)', 'Overview schedule', 'Notifications'];

export function Onboarding() {
  const { state } = useStore();
  const [step, setStep] = useState(() => Math.min(TITLES.length - 1, Number(localStorage.getItem(KEY)) || 0));
  const [name, setName] = useState(state.settings.profile.name);

  useEffect(() => localStorage.setItem(KEY, String(step)), [step]);

  const next = async () => {
    try {
      if (step === 0 && name.trim() !== state.settings.profile.name) {
        await api('/api/settings', { method: 'PUT', body: { profile: { name: name.trim() } } });
        await refreshState();
      }
      if (step === TITLES.length - 1) {
        await api('/api/settings', { method: 'PUT', body: { onboarded: true } });
        localStorage.removeItem(KEY);
        await refreshState();
        return;
      }
      setStep(step + 1);
    } catch (err) {
      oops(err);
    }
  };

  const connected = state.accounts.length > 0;
  const body = [
    html`<p class="muted">
        Pinger reads your inbox and your meeting transcripts and tells you what still needs a follow-up: emails waiting on your reply, people
        who have not answered you, and things you promised in meetings.
      </p>
      <div class="field">
        <label for="ob-name">Name</label>
        <input id="ob-name" type="text" autocomplete="name" placeholder="First and last name" value=${name} onInput=${(e) => setName(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && next()} />
        <span class="hint">Identifies you in meeting transcripts and signs drafted replies.</span>
      </div>
      <p class="hint">Data stays on this computer. Nothing is sent anywhere unless you add an AI key in step 3.</p>`,
    html`<p class="muted">Read-only. Pinger cannot send, delete or change anything in the mailbox.</p>
      ${state.accounts.map(
        (a) => html`<div class="account">
          <div class="grow truncate">${a.email}</div>
          <span class="chip good">Connected</span>
        </div>`,
      )}
      <${ConnectEmail} />`,
    html`<p class="muted">
        Without a key, mail is sorted by built-in rules. With a Claude API key, Pinger also writes summaries, judges what needs a reply, drafts
        responses and turns transcripts into meeting notes.
      </p>
      <${AiKeyForm} />`,
    html`<p class="muted">Each overview lists what needs a reply, who has not answered, and which follow-ups are due. Change this any time in Settings.</p>
      <${OverviewSchedule} />`,
    html`<p class="muted">Lets overviews, nudges and the meeting-start prompt reach you while another window has focus.</p>
      <${NotificationSetup} />
      <p class="hint">Leave Pinger running. Use “Mini window” to keep it on top of your mail app.</p>`,
  ][step];

  return html`<${Modal} wide label="Set up Pinger" title=${`Set up Pinger — ${TITLES[step]}`} aside=${html`<span class="mono muted">${step + 1}/${TITLES.length}</span>`}>
    <div class="modal-body">${body}</div>
    <div class="modal-foot">
      ${step > 0 && html`<button class="btn ghost" style="margin-right:auto" onClick=${() => setStep(step - 1)}>Back</button>`}
      ${step === 1 && !connected && html`<button class="btn" onClick=${next}>Skip</button>`}
      ${step === 2 && !state.ai.enabled && html`<button class="btn" onClick=${next}>Skip</button>`}
      ${!(step === 1 && !connected) && !(step === 2 && !state.ai.enabled) &&
      html`<button class="btn primary" onClick=${next}>${step === TITLES.length - 1 ? 'Finish' : 'Continue'}</button>`}
    </div>
  <//>`;
}
