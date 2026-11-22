import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import express from 'express';

import { createAccount, deleteAccount, getAccount, listAccounts, publicAccount } from './accounts.js';
import { aiConfig, aiEnabled } from './ai/client.js';
import { draftEmail } from './ai/tasks.js';
import { APP_ROOT, dataDir, EXTENSION_DIR, EXTENSION_ID, readSharedConfig, VERSION, writeSharedConfig } from './config.js';
import { getEvent, setPromptState, upcomingEvents } from './core/calendar.js';
import { createFollowup, deleteFollowup, dueFollowups, listFollowups, updateFollowup } from './core/followups.js';
import {
  analyzeMeetingById,
  askMeetings,
  createMeeting,
  deleteMeeting,
  getMeeting,
  listMeetings,
  searchMeetings,
  updateMeeting,
  userProfile,
} from './core/meetings.js';
import { buildDigest, collectOverview, digestHistory, latestDigest, ruleBrief } from './core/overview.js';
import { getThread, listThreads, publicThread, threadForAi } from './core/sync.js';
import { parseTranscriptFile } from './core/transcripts.js';
import { diagnostics, ingest, outlookWebAccount, outlookWebStatus, requestDiagnostics, requestScan, resetOutlookWeb } from './core/outlook-web.js';
import { all, run, tx } from './db.js';
import { addClient, changed, runtime } from './events.js';
import { ping, recentPings } from './pings.js';
import { DEMO_EMAIL, demoIdentity, sampleTranscript } from './providers/demo.js';
import { createOutlookDesktopProvider, outlookDesktopAvailable } from './providers/outlook-desktop.js';
import { createImapProvider, imapDefaults } from './providers/imap.js';
import { authorizeUrl, createOutlookProvider, pkcePair, redeemCode } from './providers/outlook.js';
import { calendarStale, nextOverviewAt, syncAll, tick } from './scheduler.js';
import { getSettings, MODELS, publicSettings, updateSettings } from './settings.js';
import { HttpError, nowIso } from './util.js';

const require = createRequire(import.meta.url);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const UPLOAD_LIMIT = 12 * 1024 * 1024;

const intParam = (value) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'Invalid id');
  return n;
};

/** Run work in the background; the UI hears about the result over the live channel. */
const background = (promise) => promise.catch((err) => console.error('[pinger]', err.message));

// The bundled extension, as Chrome and as Edge name extension origins.
const EXTENSION_ORIGINS = new Set([`chrome-extension://${EXTENSION_ID}`, `extension://${EXTENSION_ID}`]);

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  const port = () => app.locals.port;

  // Pinger holds mail and tokens, so it only answers its own page on this computer:
  // the Host check stops DNS-rebinding, the Origin/content-type checks stop cross-site requests.
  app.use((req, res, next) => {
    const hosts = new Set([`localhost:${port()}`, `127.0.0.1:${port()}`, `[::1]:${port()}`]);
    if (!hosts.has(req.headers.host || '')) return res.status(403).type('text').send('Forbidden');
    if (!SAFE_METHODS.has(req.method)) {
      const origin = req.headers.origin;
      const fromExtension = EXTENSION_ORIGINS.has(origin) && req.path.startsWith('/api/outlook-web/');
      if (origin && !fromExtension && ![...hosts].some((h) => origin === `http://${h}`)) {
        return res.status(403).type('text').send('Forbidden');
      }
      // Requiring a JSON content type forces a CORS preflight for any cross-site caller, which we never answer.
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
        return res.status(415).json({ error: 'Send JSON' });
      }
    }
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    next();
  });

  app.use('/api/outlook-web/snapshot', express.json({ limit: '4mb' }));
  app.use('/api/meetings/import', express.json({ limit: '18mb' }));
  app.use('/api/meetings', express.json({ limit: '6mb' }));
  app.use(express.json({ limit: '1mb' }));

  /* ---------------------------------------------------------------- static */

  const vendor = {
    '/vendor/preact.mjs': require.resolve('preact').replace(/preact\.js$/, 'preact.mjs'),
    '/vendor/preact-hooks.mjs': path.join(path.dirname(require.resolve('preact/hooks')), 'hooks.mjs'),
    '/vendor/htm.mjs': path.join(path.dirname(require.resolve('htm')), 'htm.mjs'),
  };
  for (const [route, file] of Object.entries(vendor)) {
    app.get(route, (req, res) => res.type('text/javascript').sendFile(file));
  }
  app.use(
    express.static(path.join(APP_ROOT, 'public'), {
      setHeaders: (res) => {
        res.set('Cache-Control', 'no-cache');
        res.set(
          'Content-Security-Policy',
          `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors chrome-extension://${EXTENSION_ID} extension://${EXTENSION_ID}; base-uri 'none'; form-action 'none'`,
        );
      },
    }),
  );

  /* ----------------------------------------------------------------- state */

  function state(now = new Date()) {
    const settings = getSettings();
    const shared = readSharedConfig();
    const overview = collectOverview(now);
    const next = nextOverviewAt(now, settings.overview);
    return {
      version: VERSION,
      settings: publicSettings(settings),
      models: MODELS,
      accounts: listAccounts().map(publicAccount),
      ai: { enabled: aiEnabled(), model: aiConfig().model, error: runtime.aiError },
      outlook: {
        clientId: shared.microsoftClientId || '',
        tenant: shared.microsoftTenant || 'common',
        redirectUri: `http://localhost:${port()}/auth/microsoft/callback`,
      },
      status: { syncing: runtime.syncing, syncError: runtime.lastSyncError, calendarError: runtime.calendarError },
      counts: overview.counts,
      nextOverviewAt: next ? next.toISOString() : null,
      dataDir: dataDir(),
      extensionDir: EXTENSION_DIR,
      platform: process.platform,
      outlookDesktop: outlookDesktopAvailable(),
      outlookWeb: outlookWebStatus(),
      demoEmail: DEMO_EMAIL,
    };
  }

  app.get('/api/health', (req, res) => res.json({ app: 'pinger', version: VERSION }));
  app.get('/api/state', (req, res) => res.json(state()));

  app.put('/api/settings', (req, res) => {
    const before = getSettings();
    const after = updateSettings(req.body);
    if (JSON.stringify(before.calendar) !== JSON.stringify(after.calendar)) {
      calendarStale();
      background(tick());
    }
    if (before.ai.apiKey !== after.ai.apiKey || before.ai.model !== after.ai.model) runtime.aiError = null;
    changed('status');
    res.json(state());
  });

  app.put('/api/outlook-setup', (req, res) => {
    const clientId = String(req.body?.clientId || '').trim();
    const tenant = String(req.body?.tenant || 'common').trim() || 'common';
    if (clientId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId)) {
      throw new HttpError(400, 'That does not look like an Application (client) ID. It should look like 1b2c3d4e-0000-1111-2222-333344445555.');
    }
    if (!/^[a-z0-9.-]+$/i.test(tenant)) throw new HttpError(400, 'Invalid tenant');
    try {
      writeSharedConfig({ microsoftClientId: clientId, microsoftTenant: tenant });
    } catch (err) {
      throw new HttpError(500, `Could not save pinger.config.json: ${err.message}`);
    }
    res.json(state());
  });

  /* -------------------------------------------------------------- accounts */

  app.post('/api/accounts/demo', async (req, res) => {
    const settings = getSettings();
    const account = createAccount({
      kind: 'demo',
      email: DEMO_EMAIL,
      name: demoIdentity(settings.profile.name).name,
      config: { seedAt: Date.now() },
    });
    calendarStale();
    await syncAll({ force: true });
    background(tick());
    res.json({ account: publicAccount(getAccount(account.id)) });
  });

  app.post('/api/accounts/outlook-desktop', async (req, res) => {
    if (!outlookDesktopAvailable()) {
      throw new HttpError(400, 'Reading the Outlook desktop app is available on Windows only. On a Mac, use Gmail/IMAP or the Outlook sign-in option.');
    }
    let me;
    try {
      me = await createOutlookDesktopProvider({ config: {} }).test();
    } catch (err) {
      throw new HttpError(400, err.message);
    }
    const account = createAccount({ kind: 'outlook_desktop', email: me.email, name: me.name, config: {} });
    calendarStale();
    background(syncAll({ force: true }).then(() => tick()));
    res.json({ account: publicAccount(account) });
  });

  app.post('/api/accounts/outlook-web', async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter the email address of the mailbox you use in Outlook.');
    if (outlookWebAccount()) throw new HttpError(400, 'Outlook in the browser is already connected. Disconnect it first to change the address.');
    const account = createAccount({ kind: 'outlook_web', email, name: getSettings().profile.name || null, config: {} });
    resetOutlookWeb();
    res.json({ account: publicAccount(account) });
  });

  // From the browser extension: what Outlook on the web shows right now.
  app.post('/api/outlook-web/snapshot', (req, res) => {
    const origin = req.headers.origin;
    if (origin && !EXTENSION_ORIGINS.has(origin)) throw new HttpError(403, 'Forbidden');
    res.json(ingest(req.body || {}));
  });

  app.post('/api/outlook-web/scan', (req, res) => res.json({ scan: requestScan() }));

  app.post('/api/outlook-web/diagnose', (req, res) => {
    requestDiagnostics();
    res.json({ ok: true });
  });

  app.get('/api/outlook-web/diagnostics', (req, res) => res.json(diagnostics()));

  app.get('/api/accounts/imap-defaults', (req, res) => res.json(imapDefaults(String(req.query.email || ''))));

  app.post('/api/accounts/imap', async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address');
    if (!password) throw new HttpError(400, 'Enter the app password for this mailbox');
    const defaults = imapDefaults(email);
    const host = String(req.body?.host || defaults.host).trim().toLowerCase();
    const portNumber = Number(req.body?.port || defaults.port);
    if (!/^[a-z0-9.-]+$/.test(host)) throw new HttpError(400, 'Enter a valid mail server name');
    if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) throw new HttpError(400, 'Invalid port');
    const config = { host, port: portNumber, user: String(req.body?.username || email).trim(), pass: password };
    try {
      await createImapProvider({ config }).test();
    } catch (err) {
      throw new HttpError(400, err.message);
    }
    const account = createAccount({ kind: 'imap', email, name: String(req.body?.name || '').trim() || null, config });
    background(syncAll({ force: true }));
    res.json({ account: publicAccount(account) });
  });

  app.delete('/api/accounts/:id', (req, res) => {
    const id = intParam(req.params.id);
    if (getAccount(id)?.kind === 'outlook_web') resetOutlookWeb();
    deleteAccount(id);
    changed('threads', 'accounts', 'events', 'status');
    res.json({ ok: true });
  });

  // Outlook sign-in (OAuth authorization code + PKCE, public client, loopback redirect).
  const pendingLogins = new Map();

  app.get('/auth/microsoft/start', (req, res) => {
    const shared = readSharedConfig();
    if (!shared.microsoftClientId) return res.redirect('/#/settings?outlook=setup');
    for (const [key, value] of pendingLogins) if (Date.now() - value.at > 15 * 60_000) pendingLogins.delete(key);
    const { verifier, challenge } = pkcePair();
    const stateToken = crypto.randomBytes(24).toString('hex');
    const redirectUri = `http://localhost:${port()}/auth/microsoft/callback`;
    pendingLogins.set(stateToken, { verifier, at: Date.now(), clientId: shared.microsoftClientId, tenant: shared.microsoftTenant, redirectUri });
    res.redirect(authorizeUrl({ clientId: shared.microsoftClientId, tenant: shared.microsoftTenant, redirectUri, state: stateToken, challenge }));
  });

  app.get('/auth/microsoft/callback', async (req, res) => {
    const fail = (message) => res.redirect(`/#/settings?error=${encodeURIComponent(message)}`);
    const login = pendingLogins.get(String(req.query.state || ''));
    pendingLogins.delete(String(req.query.state || ''));
    if (req.query.error) {
      const description = String(req.query.error_description || req.query.error).split(/\r?\n/)[0];
      return fail(req.query.error === 'access_denied' ? 'Outlook sign-in was cancelled.' : `Microsoft said: ${description}`);
    }
    if (!login || !req.query.code) return fail('That sign-in link expired. Please try connecting Outlook again.');
    try {
      const config = await redeemCode({ ...login, code: String(req.query.code) });
      const me = await createOutlookProvider({ config }).whoAmI();
      if (!me.email) return fail('Signed in, but Microsoft did not return a mailbox address for this account.');
      createAccount({ kind: 'outlook', email: me.email, name: me.name, config });
      calendarStale();
      background(syncAll({ force: true }).then(() => tick()));
      res.redirect('/#/settings?connected=outlook');
    } catch (err) {
      fail(err.message);
    }
  });

  app.post('/api/sync', async (req, res) => {
    calendarStale();
    const result = await syncAll({ force: true });
    background(tick());
    res.json(result);
  });

  /* --------------------------------------------------------------- threads */

  app.get('/api/threads', (req, res) => {
    const settings = getSettings();
    const now = new Date();
    const view = String(req.query.view || 'needs_reply');
    const stateName = view === 'waiting' ? 'awaiting_reply' : 'needs_reply';
    const rows = listThreads({ state: stateName, includeHandled: req.query.handled === '1', now });
    res.json({ threads: rows.map((t) => publicThread(t, settings, now)) });
  });

  app.get('/api/threads/:id', (req, res) => {
    const thread = getThread(intParam(req.params.id));
    if (!thread) throw new HttpError(404, 'Conversation not found');
    const messages = all(
      'SELECT * FROM messages WHERE account_id = ? AND thread_key = ? ORDER BY sent_at DESC, id DESC LIMIT 12',
      thread.account_id,
      thread.thread_key,
    )
      .reverse()
      .map((m) => ({
        id: m.id,
        fromMe: m.direction === 'out',
        from: { name: m.from_name, email: m.from_email },
        sentAt: m.sent_at,
        body: m.body || '',
      }));
    res.json({ thread: publicThread({ ...thread, status: thread.user_status }), messages });
  });

  app.post('/api/threads/:id/action', (req, res) => {
    const id = intParam(req.params.id);
    if (!getThread(id)) throw new HttpError(404, 'Conversation not found');
    const { action, until } = req.body || {};
    if (action === 'snooze') {
      if (!until || Number.isNaN(Date.parse(until))) throw new HttpError(400, 'Pick a time to snooze until');
      run("UPDATE threads SET user_status = 'snoozed', snooze_until = ? WHERE id = ?", new Date(until).toISOString(), id);
    } else if (['done', 'dismissed', 'open'].includes(action)) {
      run('UPDATE threads SET user_status = ?, snooze_until = NULL WHERE id = ?', action, id);
    } else {
      throw new HttpError(400, 'Unknown action');
    }
    changed('threads');
    res.json({ ok: true });
  });

  app.post('/api/threads/:id/draft', async (req, res) => {
    const thread = getThread(intParam(req.params.id));
    if (!thread) throw new HttpError(404, 'Conversation not found');
    if (!aiEnabled()) throw new HttpError(400, 'Add an AI key in Settings to draft replies.');
    const kind = thread.last_direction === 'out' ? 'nudge' : 'reply';
    const draft = await draftEmail(
      {
        kind,
        subject: thread.subject,
        messages: threadForAi(thread, 5),
        instruction: String(req.body?.instruction || '').trim().slice(0, 1000) || undefined,
      },
      userProfile(),
    );
    const subject = `Re: ${thread.subject}`;
    const mailto = `mailto:${encodeURIComponent(thread.counterpart_email || '')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(draft.slice(0, 1800))}`;
    res.json({ draft, kind, to: thread.counterpart_email, subject, mailto });
  });

  /* ------------------------------------------------------------- followups */

  app.get('/api/followups', (req, res) => {
    const status = ['open', 'done', 'dismissed', 'all'].includes(req.query.status) ? req.query.status : 'open';
    res.json({ followups: listFollowups({ status }) });
  });

  app.post('/api/followups', (req, res) => {
    const followup = createFollowup(req.body || {});
    changed('followups');
    res.json({ followup });
  });

  app.patch('/api/followups/:id', (req, res) => {
    const followup = updateFollowup(intParam(req.params.id), req.body || {});
    changed('followups');
    res.json({ followup });
  });

  app.delete('/api/followups/:id', (req, res) => {
    deleteFollowup(intParam(req.params.id));
    changed('followups');
    res.json({ ok: true });
  });

  /* -------------------------------------------------------------- meetings */

  app.get('/api/meetings', (req, res) => {
    const q = String(req.query.q || '').trim();
    res.json({ meetings: listMeetings(), matches: q ? searchMeetings(q, 20) : null });
  });

  app.get('/api/meetings/sample', (req, res) => res.json(sampleTranscript(getSettings().profile.name)));

  app.post('/api/meetings/import', (req, res) => {
    const { filename, dataBase64, title } = req.body || {};
    if (typeof dataBase64 !== 'string' || !dataBase64) throw new HttpError(400, 'No file received');
    const buffer = Buffer.from(dataBase64, 'base64');
    if (buffer.length > UPLOAD_LIMIT) throw new HttpError(413, 'That file is larger than 12 MB.');
    const { text } = parseTranscriptFile(String(filename || ''), buffer);
    if (!text.trim()) throw new HttpError(400, 'That file has no text in it.');
    const fallbackTitle = String(filename || 'Meeting').replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').trim();
    const meeting = createMeeting({
      title: String(title || '').trim() || fallbackTitle,
      transcript: text,
      source: 'upload',
      startedAt: req.body?.startedAt,
      attendees: req.body?.attendees,
    });
    background(analyzeMeetingById(meeting.id));
    changed('meetings');
    res.json({ meeting });
  });

  app.post('/api/meetings', (req, res) => {
    const body = req.body || {};
    const event = body.eventId ? getEvent(intParam(body.eventId)) : null;
    const live = !!body.live;
    if (!live && !String(body.transcript || '').trim() && !String(body.notes || '').trim()) {
      throw new HttpError(400, 'Paste a transcript or some notes first');
    }
    const meeting = createMeeting({
      title: body.title || event?.title,
      startedAt: body.startedAt || (live ? nowIso() : event?.startAt),
      attendees: body.attendees?.length ? body.attendees : event?.attendees,
      transcript: body.transcript,
      notes: body.notes,
      source: live ? 'live' : 'paste',
      status: live ? 'live' : 'ready',
      eventId: event?.id,
    });
    if (event) setPromptState(event.id, 'accepted');
    if (!live) background(analyzeMeetingById(meeting.id));
    changed('meetings', 'events');
    res.json({ meeting });
  });

  app.get('/api/meetings/:id', (req, res) => {
    const id = intParam(req.params.id);
    const meeting = getMeeting(id);
    if (!meeting) throw new HttpError(404, 'Meeting not found');
    const followups = listFollowups({ status: 'all' }).filter((f) => f.meetingId === id);
    res.json({ meeting, followups });
  });

  app.patch('/api/meetings/:id', (req, res) => {
    const meeting = updateMeeting(intParam(req.params.id), req.body || {});
    if (!req.body?.quiet) changed('meetings');
    res.json({ meeting: { id: meeting.id, title: meeting.title, status: meeting.status } });
  });

  app.post('/api/meetings/:id/finish', (req, res) => {
    const id = intParam(req.params.id);
    const meeting = updateMeeting(id, { ...(req.body || {}), status: 'ready', endedAt: nowIso() });
    background(analyzeMeetingById(id));
    changed('meetings');
    res.json({ meeting: { id: meeting.id } });
  });

  app.post('/api/meetings/:id/analyze', (req, res) => {
    const id = intParam(req.params.id);
    if (!getMeeting(id)) throw new HttpError(404, 'Meeting not found');
    background(analyzeMeetingById(id));
    res.json({ ok: true });
  });

  app.delete('/api/meetings/:id', (req, res) => {
    deleteMeeting(intParam(req.params.id));
    changed('meetings', 'followups');
    res.json({ ok: true });
  });

  app.post('/api/ask', async (req, res) => {
    res.json(await askMeetings(req.body?.question));
  });

  app.get('/api/events', (req, res) => res.json({ events: upcomingEvents(new Date(), 36) }));

  app.post('/api/events/:id/skip', (req, res) => {
    setPromptState(intParam(req.params.id), 'skipped');
    res.json({ ok: true });
  });

  /* -------------------------------------------------------------- overview */

  app.get('/api/overview', (req, res) => {
    const latest = latestDigest();
    const current = collectOverview();
    res.json({
      now: current,
      // Until the first overview has been generated, describe the current state with the built-in rules.
      brief: latest
        ? { text: latest.brief, source: latest.briefSource, createdAt: latest.createdAt, trigger: latest.trigger }
        : { text: ruleBrief(current), source: 'rules', createdAt: current.generatedAt, trigger: 'live' },
      history: digestHistory(10),
      followupsDue: dueFollowups(),
    });
  });

  app.post('/api/overview', async (req, res) => {
    const digest = await buildDigest({ trigger: 'manual' });
    changed('digest');
    res.json({ digest });
  });

  /* ----------------------------------------------------------------- pings */

  app.get('/api/pings', (req, res) => res.json({ pings: recentPings(30) }));

  app.post('/api/pings/test', (req, res) => {
    res.json({ ping: ping({ type: 'test', title: 'Pinger is working', body: 'This is what a ping looks like.', url: '/#/settings' }) });
  });

  app.get('/api/stream', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const remove = addClient(res, { canNotify: req.query.notify === '1' });
    const beat = setInterval(() => res.write(': keep-alive\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(beat);
      remove();
    });
  });

  /* ------------------------------------------------------------------ data */

  app.post('/api/data/wipe', (req, res) => {
    if (req.body?.confirm !== 'DELETE') throw new HttpError(400, 'Confirmation required');
    tx(() => {
      for (const table of ['followups', 'meetings_fts', 'meetings', 'calendar_events', 'threads', 'messages', 'web_items', 'accounts', 'digests', 'pings', 'settings']) {
        run(`DELETE FROM ${table}`);
      }
    });
    Object.assign(runtime, { lastSyncError: null, aiError: null, calendarError: null });
    resetOutlookWeb();
    changed('threads', 'accounts', 'meetings', 'followups', 'events', 'digest', 'status');
    res.json({ ok: true });
  });

  if (process.env.PINGER_DEV) {
    // Test hook: run the scheduler now, optionally pretending it is a different time.
    app.post('/api/dev/tick', async (req, res) => {
      await tick(req.body?.now ? new Date(req.body.now) : new Date(), { forceCalendar: true });
      res.json({ ok: true });
    });
  }

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error('[pinger]', err);
    const message = err.type === 'entity.too.large' ? 'That is too large to upload.' : err.message || 'Something went wrong';
    if (req.path.startsWith('/api')) res.status(status).json({ error: message });
    else res.status(status).type('text').send(message);
  });

  return app;
}

/** Start listening on localhost only. Resolves with the http.Server. */
export function listen(app, port) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1');
    server.once('listening', () => {
      app.locals.port = server.address().port;
      resolve(server);
    });
    server.once('error', reject);
  });
}
