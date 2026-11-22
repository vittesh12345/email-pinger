import { useEffect, useState } from 'preact/hooks';
import {
  api, copyText, dueLabel, fmtDateTime, html, Icon, Menu, oops, personName, snoozeChoices, Spinner, toast, useAction, useData, useStore, waitingFor,
} from '../lib.js';

function Draft({ thread, waiting }) {
  const [instruction, setInstruction] = useState('');
  // A draft Pinger wrote ahead of time (auto-draft) shows immediately, ready to edit.
  const ready = thread.draft ? { draft: thread.draft, to: thread.person.email, subject: `Re: ${thread.subject}` } : null;
  const [result, setResult] = useState(ready);
  const [text, setText] = useState(thread.draft || '');
  const [busy, run] = useAction();

  const make = () =>
    run(async () => {
      const r = await api(`/api/threads/${thread.id}/draft`, { method: 'POST', body: { instruction } });
      setResult(r);
      setText(r.draft);
    });

  const mailto = result
    ? `mailto:${encodeURIComponent(result.to || '')}?subject=${encodeURIComponent(result.subject)}&body=${encodeURIComponent(text.slice(0, 1800))}`
    : null;

  return html`<div class="draft stack" style="margin-top:8px">
    <div class="row">
      <input
        type="text"
        placeholder=${waiting ? 'Optional: anything to add' : 'Optional: what to say, e.g. “yes, but not before the 15th”'}
        aria-label="Direction for the draft"
        value=${instruction}
        onInput=${(e) => setInstruction(e.target.value)}
        onKeyDown=${(e) => e.key === 'Enter' && make()}
      />
      <button class="btn primary" disabled=${busy} onClick=${make}>${busy ? html`<${Spinner} />` : null} ${result ? 'Redraft' : 'Draft'}</button>
    </div>
    ${result &&
    html`<textarea aria-label="Draft" value=${text} onInput=${(e) => setText(e.target.value)}></textarea>
      <div class="row wrap">
        <button class="btn sm" onClick=${() => copyText(text)}><${Icon} name="copy" /> Copy</button>
        <a class="btn sm" href=${mailto}><${Icon} name="mail" /> Open in mail app</a>
        ${thread.webLink && html`<a class="btn sm" href=${thread.webLink} target="_blank" rel="noreferrer">Open conversation <${Icon} name="external" /></a>`}
        <span class="hint">Pinger does not send email. Review the draft and send it from your mail app.</span>
      </div>`}
  </div>`;
}

function Conversation({ id }) {
  const { data, error } = useData(() => api(`/api/threads/${id}`), [], [id]);
  if (error) return html`<p class="muted">Conversation failed to load.</p>`;
  if (!data) return html`<${Spinner} />`;
  return html`<div>
    ${data.messages.map(
      (m) => html`<div class="msg">
        <div class="row">
          <span class="from">${m.fromMe ? 'You' : personName(m.from)}</span>
          <span class="mono faint">${fmtDateTime(m.sentAt)}</span>
        </div>
        <div class="body pre">${m.body || '(no text)'}</div>
      </div>`,
    )}
  </div>`;
}

function ThreadItem({ t, waiting, open, onToggle, aiOn }) {
  const [busy, run] = useAction();
  const [drafting, setDrafting] = useState(!!t.draft);
  const act = (action, until) => run(() => api(`/api/threads/${t.id}/action`, { method: 'POST', body: { action, until } }));
  const due = dueLabel(t.due);
  const handled = t.status !== 'open';
  const replyHref = t.webLink || `mailto:${encodeURIComponent(t.person.email || '')}?subject=${encodeURIComponent(`Re: ${t.subject}`)}`;

  return html`<div class=${`item${open ? ' open' : ''}`} id=${`thread-${t.id}`}>
    <div class="clickable" role="button" tabindex="0" aria-expanded=${open} onClick=${onToggle} onKeyDown=${(e) => e.key === 'Enter' && onToggle()}>
      <div class="item-head">
        <span class=${`dot ${t.priority}`} title=${`${t.priority} priority`}></span>
        <span class="who">${personName(t.person)}</span>
        <span class="subject">${t.subject}</span>
        <span class="when">${waiting ? `sent ${waitingFor(t.waitingSince)}` : waitingFor(t.waitingSince)}</span>
      </div>
      <p class="summary">${t.summary || t.preview || '(no preview)'}</p>
    </div>

    <div class="meta">
      ${t.priority === 'high' && html`<span class="chip high">High</span>`}
      ${t.draft && !handled && html`<span class="chip good">Draft ready</span>`}
      ${waiting && t.overdue && html`<span class="chip medium">No reply</span>`}
      ${due && html`<span class=${`chip ${due.cls}`}>${due.text}</span>`}
      ${t.source === 'ai' ? html`<span class="chip plain">AI</span>` : t.reasons.slice(0, 2).map((r) => html`<span class="chip plain">${r}</span>`)}
      ${t.messageCount > 1 && html`<span class="small faint"><span class="mono">${t.messageCount}</span> messages</span>`}
      ${handled && html`<span class="chip">${t.status === 'snoozed' ? `Snoozed until ${fmtDateTime(t.snoozeUntil)}` : t.status === 'done' ? 'Done' : 'Dismissed'}</span>`}
      <div class="actions">
        ${handled
          ? html`<button class="btn sm" disabled=${busy} onClick=${() => act('open')}>Restore</button>`
          : html`
              <a class="btn sm" href=${replyHref} target=${t.webLink ? '_blank' : undefined} rel="noreferrer">
                <${Icon} name=${t.webLink || waiting ? 'external' : 'reply'} /> ${t.webLink ? 'Open' : waiting ? 'Email' : 'Reply'}
              </a>
              <button
                class="btn sm"
                title=${aiOn ? '' : 'Requires an AI key (Settings → AI)'}
                disabled=${!aiOn}
                onClick=${() => {
                  setDrafting(!drafting);
                  if (!open) onToggle();
                }}
              >
                <${Icon} name="edit" /> ${waiting ? 'Draft nudge' : 'Draft reply'}
              </button>
              <button class="btn sm" disabled=${busy} onClick=${() => act('done')}><${Icon} name="check" /> Done</button>
              <${Menu} label="Snooze" icon="clock" items=${snoozeChoices().map((c) => ({ label: c.label, onSelect: () => act('snooze', c.until) }))} />
              <button class="btn sm ghost" disabled=${busy} title=${waiting ? 'Stop tracking this conversation' : 'No reply needed'} onClick=${() => act('dismissed')}>
                <${Icon} name="x" /> Dismiss
              </button>
            `}
      </div>
    </div>

    ${open &&
    html`<div class="detail">
      ${(t.ask || t.nextStep) &&
      html`<dl class="kv" style="margin-bottom:8px">
        ${t.ask && html`<dt>${waiting ? 'Waiting for' : 'Asked of you'}</dt><dd>${t.ask}</dd>`}
        ${t.nextStep && html`<dt>Next step</dt><dd>${t.nextStep}</dd>`}
      </dl>`}
      <${Conversation} id=${t.id} />
      ${drafting && aiOn && html`<${Draft} thread=${t} waiting=${waiting} />`}
    </div>`}
  </div>`;
}

export function Emails({ route }) {
  const { state } = useStore();
  const waiting = route.parts[1] === 'waiting';
  const [showHandled, setShowHandled] = useState(false);
  const [openId, setOpenId] = useState(Number(route.query.get('open')) || null);
  const view = waiting ? 'waiting' : 'needs_reply';
  const { data, error } = useData(() => api(`/api/threads?view=${view}${showHandled ? '&handled=1' : ''}`), ['threads'], [view, showHandled]);

  useEffect(() => {
    const id = Number(route.query.get('open')) || null;
    if (id) {
      setOpenId(id);
      setTimeout(() => document.getElementById(`thread-${id}`)?.scrollIntoView({ block: 'center' }), 250);
    }
  }, [route.query.get('open'), waiting]);

  const c = state.counts;
  const threads = data?.threads || [];
  const days = state.settings.followups.awaitingDays;
  const sync = async () => {
    try {
      await api('/api/sync', { method: 'POST' });
      toast('Mail checked', { ms: 2500 });
    } catch (err) {
      oops(err);
    }
  };

  return html`<div class="page">
    <div class="page-head">
      <div class="grow">
        <h1>Emails</h1>
        <p class="sub">
          ${waiting
            ? html`You wrote last and have no answer. Nudge reminder after <span class="mono">${days}</span> day${days === 1 ? '' : 's'}.`
            : 'Someone wrote last and is waiting on you.'}
        </p>
      </div>
      <button class="btn" disabled=${state.status.syncing || !state.accounts.length} onClick=${sync}>
        ${state.status.syncing ? html`<${Spinner} />` : html`<${Icon} name="refresh" />`} Check mail
      </button>
    </div>

    <nav class="tabs" aria-label="Email views">
      <a class=${waiting ? '' : 'active'} href="#/emails">Needs reply<span class="mono">${c.needsReply}</span></a>
      <a class=${waiting ? 'active' : ''} href="#/emails/waiting">Waiting on others<span class="mono">${c.waiting}</span></a>
    </nav>

    ${state.status.syncError && html`<div class="banner error">Mail check failed: ${state.status.syncError}</div>`}
    ${state.ai.error && html`<div class="banner">AI triage did not run; sorted by built-in rules. ${state.ai.error}</div>`}

    <section class="card">
      <div class="list">
        ${error && html`<div class="empty">Failed to load: ${error.message}</div>`}
        ${!data && !error && html`<div class="empty"><${Spinner} /></div>`}
        ${data &&
        !threads.length &&
        html`<div class="empty">
          ${!state.accounts.length
            ? html`No mailbox connected. <a href="#/settings">Connect email</a>.`
            : waiting
              ? 'Not waiting on anyone.'
              : 'No conversations need a reply.'}
        </div>`}
        ${threads.map(
          (t) =>
            html`<${ThreadItem}
              key=${t.id}
              t=${t}
              waiting=${waiting}
              aiOn=${state.ai.enabled}
              open=${openId === t.id}
              onToggle=${() => setOpenId(openId === t.id ? null : t.id)}
            />`,
        )}
      </div>
    </section>

    <label class="checkline small muted">
      <input type="checkbox" checked=${showHandled} onChange=${(e) => setShowHandled(e.target.checked)} />
      Show done, snoozed and dismissed
    </label>
  </div>`;
}
