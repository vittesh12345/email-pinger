// Live meeting notes: transcribes what the microphone hears (in Chrome and Edge) next to a notes box.

import { useEffect, useRef, useState } from 'preact/hooks';
import { api, go, html, Icon, oops, Spinner, toast, useAction, useData, useStore } from '../lib.js';

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const AUTOSTART_KEY = 'pinger.live.autostart';

const pad = (n) => String(n).padStart(2, '0');
function clock(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  return `${h ? `${h}:` : ''}${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

export function Live({ route }) {
  const id = Number(route.parts[1]) || null;
  return id ? html`<${Recorder} key=${id} id=${id} />` : html`<${StartLive} eventId=${Number(route.query.get('event')) || null} />`;
}

/* ------------------------------------------------------------------ start */

function StartLive({ eventId }) {
  const events = useData(() => api('/api/events'), ['events']);
  const event = events.data?.events.find((e) => e.id === eventId) || null;
  const [title, setTitle] = useState('');
  const [busy, run] = useAction();

  useEffect(() => {
    if (event && !title) setTitle(event.title);
  }, [event?.id]);

  const begin = (record) =>
    run(async () => {
      const fallback = `Meeting on ${new Date().toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}`;
      const { meeting } = await api('/api/meetings', {
        method: 'POST',
        body: { live: true, eventId: event?.id, title: title.trim() || event?.title || fallback },
      });
      sessionStorage.setItem(AUTOSTART_KEY, record ? 'record' : 'notes');
      go(`/live/${meeting.id}`);
    });

  return html`<div class="page">
    <div class="page-head">
      <div class="grow">
        <h1>Record a meeting</h1>
        <p class="sub">Live transcript on the left, your notes on the right. Follow-ups are listed when you end the meeting.</p>
      </div>
    </div>
    <section class="card pad stack">
      <div class="field">
        <label for="live-title">Meeting</label>
        <input id="live-title" type="text" placeholder="Meeting title" value=${title} onInput=${(e) => setTitle(e.target.value)} />
      </div>
      ${event?.joinUrl && html`<a href=${event.joinUrl} target="_blank" rel="noreferrer">Join the meeting <${Icon} name="external" /></a>`}
      ${!SpeechRecognition &&
      html`<div class="banner">Live transcription requires Chrome or Edge. In this browser you can type notes and add the meeting's transcript afterwards.</div>`}
      <div class="row wrap">
        <button class="btn primary big" disabled=${busy || !SpeechRecognition} onClick=${() => begin(true)}>
          ${busy ? html`<${Spinner} />` : html`<${Icon} name="mic" />`} Start recording
        </button>
        <button class="btn big" disabled=${busy} onClick=${() => begin(false)}>Notes only</button>
      </div>
      <ul class="clean small muted">
        <li>Tell everyone the meeting is being transcribed. Many places require consent to record.</li>
        <li>Pinger hears what the microphone hears: everyone on speakers, only you on headphones. On headphones, add the meeting's own transcript afterwards.</li>
        <li>Speech is converted to text by the browser's speech service (Google in Chrome, Microsoft in Edge). No audio is stored.</li>
      </ul>
    </section>
  </div>`;
}

/* --------------------------------------------------------------- recorder */

function Recorder({ id }) {
  const { state } = useStore();
  const [meeting, setMeeting] = useState(null);
  const [title, setTitle] = useState('');
  const [segments, setSegments] = useState([]);
  const [interim, setInterim] = useState('');
  const [notes, setNotes] = useState('');
  const [recording, setRecording] = useState(false);
  const [problem, setProblem] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const [ending, setEnding] = useState(false);

  // Mutable mirrors, so timers and speech callbacks always see current values.
  const live = useRef({ rec: null, want: false, dirty: false, base: '', segments: [], notes: '', title: '', startMs: Date.now(), quickEnds: 0, startedAt: 0 });
  const pane = useRef(null);

  const transcriptText = () => {
    const lines = live.current.segments.map((s) => `[${clock(s.at)}] ${s.text}`);
    return [live.current.base.trim(), ...lines].filter(Boolean).join('\n');
  };

  const save = async () => {
    if (!live.current.dirty) return;
    live.current.dirty = false;
    try {
      await api(`/api/meetings/${id}`, {
        method: 'PATCH',
        body: { transcript: transcriptText(), notes: live.current.notes, title: live.current.title || undefined, quiet: true },
      });
    } catch {
      live.current.dirty = true; // try again on the next tick
    }
  };

  const startRecognition = () => {
    if (!SpeechRecognition || live.current.rec) return;
    const rec = new SpeechRecognition();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = state.settings.meetings.language || 'en-US';
    rec.onstart = () => {
      live.current.startedAt = Date.now();
      setRecording(true);
      setProblem(null);
    };
    rec.onresult = (e) => {
      let pending = '';
      const finals = [];
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i];
        const text = result[0]?.transcript || '';
        if (result.isFinal) finals.push(text.trim());
        else pending += text;
      }
      const at = (Date.now() - live.current.startMs) / 1000;
      const added = finals.filter(Boolean).map((text) => ({ at, text }));
      if (added.length) {
        live.current.segments = [...live.current.segments, ...added];
        live.current.dirty = true;
        setSegments(live.current.segments);
      }
      setInterim(pending);
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        live.current.want = false;
        setProblem('Microphone access is blocked. Allow the microphone for this page (icon left of the address bar), then press Resume.');
      } else if (e.error === 'audio-capture') {
        live.current.want = false;
        setProblem('No microphone was found. Plug one in or check your sound settings, then press Resume.');
      } else if (e.error === 'network') {
        setProblem('The speech service is unreachable. Retrying. Notes are still saved.');
      }
      // "no-speech" and "aborted" are routine and need no message.
    };
    rec.onend = () => {
      live.current.rec = null;
      setInterim('');
      setRecording(false);
      if (!live.current.want) return;
      // Browsers end recognition after a stretch of silence; start it again. Back off if it keeps dying at once.
      live.current.quickEnds = Date.now() - live.current.startedAt < 1500 ? live.current.quickEnds + 1 : 0;
      if (live.current.quickEnds >= 6) {
        live.current.want = false;
        setProblem('Live transcription keeps stopping. Press Resume to try again, or keep typing notes.');
        return;
      }
      setTimeout(() => live.current.want && startRecognition(), 250 + live.current.quickEnds * 500);
    };
    live.current.rec = rec;
    try {
      rec.start();
    } catch {
      live.current.rec = null;
    }
  };

  const resume = () => {
    live.current.want = true;
    live.current.quickEnds = 0;
    startRecognition();
  };
  const pause = () => {
    live.current.want = false;
    live.current.rec?.stop();
  };

  useEffect(() => {
    let cancelled = false;
    api(`/api/meetings/${id}`)
      .then(({ meeting: m }) => {
        if (cancelled) return;
        if (m.status !== 'live') return go(`/meetings/${id}`);
        live.current.base = m.transcript || '';
        live.current.notes = m.notes || '';
        live.current.title = m.title;
        live.current.startMs = new Date(m.startedAt).getTime();
        setMeeting(m);
        setTitle(m.title);
        setNotes(m.notes || '');
        const auto = sessionStorage.getItem(AUTOSTART_KEY);
        sessionStorage.removeItem(AUTOSTART_KEY);
        if (auto === 'record') resume();
        return undefined;
      })
      .catch((err) => {
        oops(err);
        go('/meetings');
      });

    const saver = setInterval(save, 8000);
    const ticker = setInterval(() => setElapsed((Date.now() - live.current.startMs) / 1000), 1000);
    const warn = (e) => {
      if (live.current.want || live.current.dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      cancelled = true;
      clearInterval(saver);
      clearInterval(ticker);
      window.removeEventListener('beforeunload', warn);
      live.current.want = false;
      live.current.rec?.stop();
      save();
    };
  }, [id]);

  useEffect(() => {
    if (pane.current) pane.current.scrollTop = pane.current.scrollHeight;
  }, [segments.length, interim]);

  const finish = async () => {
    setEnding(true);
    pause();
    await new Promise((r) => setTimeout(r, 700)); // let the last words arrive
    try {
      live.current.dirty = false;
      await api(`/api/meetings/${id}/finish`, {
        method: 'POST',
        body: { transcript: transcriptText(), notes: live.current.notes, title: live.current.title || undefined },
      });
      toast('Meeting saved', { body: 'Listing follow-ups.' });
      go(`/meetings/${id}`);
    } catch (err) {
      setEnding(false);
      oops(err);
    }
  };

  const discard = async () => {
    if (!confirm('Discard this meeting and everything recorded so far?')) return;
    pause();
    live.current.dirty = false;
    try {
      await api(`/api/meetings/${id}`, { method: 'DELETE' });
      go('/meetings');
    } catch (err) {
      oops(err);
    }
  };

  if (!meeting) return html`<div class="page"><div class="empty"><${Spinner} /></div></div>`;

  const baseLines = live.current.base.trim();
  const status = recording ? 'REC' : SpeechRecognition ? 'PAUSED' : 'NOTES';
  return html`<div class="page" style="max-width:1200px">
    <div class="page-head">
      <div class="grow">
        <input
          type="text"
          class="title-input"
          aria-label="Meeting title"
          value=${title}
          onInput=${(e) => {
            setTitle(e.target.value);
            live.current.title = e.target.value;
            live.current.dirty = true;
          }}
        />
        <p class="sub"><span class=${`rec${recording ? '' : ' paused'}`}><span class="pulse"></span>${status} ${clock(elapsed)}</span></p>
      </div>
      ${SpeechRecognition &&
      (recording
        ? html`<button class="btn" onClick=${pause}><${Icon} name="pause" /> Pause</button>`
        : html`<button class="btn" onClick=${resume}><${Icon} name="mic" /> ${segments.length || baseLines ? 'Resume' : 'Start recording'}</button>`)}
      <button class="btn primary" disabled=${ending} onClick=${finish}>${ending ? html`<${Spinner} />` : html`<${Icon} name="stop" />`} End meeting</button>
      <button class="btn ghost danger" disabled=${ending} onClick=${discard}>Discard</button>
    </div>

    ${problem && html`<div class="banner error">${problem}</div>`}
    ${!SpeechRecognition && html`<div class="banner">Live transcription requires Chrome or Edge. Type notes here; add the meeting's transcript later.</div>`}

    <div class="live-grid">
      <section class="card live-pane">
        <div class="card-head"><h2>Transcript</h2><span class="small faint">${segments.length ? 'Saved continuously' : ''}</span></div>
        <div class="body" ref=${pane} aria-live="off">
          ${baseLines && html`<p class="pre muted">${baseLines}</p>`}
          ${segments.map((s) => html`<p><span class="mono faint">${clock(s.at)}</span> ${s.text}</p>`)}
          ${interim && html`<p class="interim">${interim}</p>`}
          ${!baseLines && !segments.length && !interim &&
          html`<p class="muted">${recording ? 'Listening.' : SpeechRecognition ? 'Not recording.' : 'No live transcript in this browser.'}</p>`}
        </div>
      </section>
      <section class="card live-pane">
        <div class="card-head"><h2>Notes</h2></div>
        <textarea
          aria-label="Your notes"
          placeholder="Decisions, promises, who said what"
          value=${notes}
          onInput=${(e) => {
            setNotes(e.target.value);
            live.current.notes = e.target.value;
            live.current.dirty = true;
          }}
        ></textarea>
      </section>
    </div>
    <p class="hint">Tell everyone the meeting is being transcribed.</p>
  </div>`;
}
