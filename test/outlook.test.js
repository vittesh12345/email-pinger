import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { authorizeUrl, createOutlookProvider, pkcePair, redeemCode, SCOPES } from '../src/providers/outlook.js';

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

/** A scripted stand-in for Microsoft's servers. `routes` maps a URL test to a handler. */
function fakeMicrosoft(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    for (const [match, handler] of routes) {
      if (typeof match === 'string' ? String(url).includes(match) : match.test(String(url))) return handler(String(url), init, calls);
    }
    throw new Error(`unexpected request: ${url}`);
  };
  return { fetchImpl, calls };
}

const account = (over = {}) => ({ config: { clientId: 'client-1', tenant: 'common', accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: Date.now() + 3_600_000, ...over } });
const folders = [
  ['/mailFolders/sentitems', () => json({ id: 'SENT' })],
  ['/mailFolders/junkemail', () => json({ id: 'JUNK' })],
  ['/mailFolders/deleteditems', () => json({ id: 'TRASH' })],
];
const graphMessage = (over = {}) => ({
  id: 'id-1',
  conversationId: 'conv-1',
  internetMessageId: '<a@x>',
  subject: 'Renewal',
  from: { emailAddress: { name: 'Priya Raman', address: 'Priya@Northwind.example' } },
  toRecipients: [{ emailAddress: { name: 'Alex', address: 'alex@acme.example' } }],
  ccRecipients: [],
  receivedDateTime: '2026-11-20T10:00:00Z',
  sentDateTime: '2026-11-20T09:59:58Z',
  isRead: false,
  isDraft: false,
  importance: 'high',
  webLink: 'https://outlook.office.com/mail/id-1',
  parentFolderId: 'INBOX',
  inferenceClassification: 'focused',
  body: { contentType: 'text', content: 'Can you confirm?' },
  ...over,
});

test('the sign-in link uses PKCE and asks only to read mail and calendar', () => {
  const { verifier, challenge } = pkcePair();
  assert.equal(challenge, crypto.createHash('sha256').update(verifier).digest('base64url'));
  const url = new URL(authorizeUrl({ clientId: 'client-1', redirectUri: 'http://localhost:4317/auth/microsoft/callback', state: 'st', challenge }));
  assert.equal(url.origin + url.pathname, 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), challenge);
  assert.equal(url.searchParams.get('scope'), 'offline_access User.Read Mail.Read Calendars.Read');
  assert.ok(!SCOPES.some((s) => /Send|ReadWrite/i.test(s)), 'no write or send permissions');
});

test('redeemCode exchanges the code with the PKCE verifier and no client secret', async () => {
  const { fetchImpl, calls } = fakeMicrosoft([['/oauth2/v2.0/token', () => json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 })]]);
  const cfg = await redeemCode({ clientId: 'client-1', tenant: 'common', redirectUri: 'http://localhost:4317/cb', code: 'CODE', verifier: 'VER', fetchImpl });
  const body = new URLSearchParams(calls[0].init.body);
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('code_verifier'), 'VER');
  assert.equal(body.has('client_secret'), false);
  assert.equal(cfg.refreshToken, 'rt');
  assert.ok(cfg.expiresAt > Date.now());
});

test('fetchMessages follows paging, maps fields, and skips drafts, junk and deleted mail', async () => {
  const { fetchImpl, calls } = fakeMicrosoft([
    ...folders,
    ['page=2', () => json({ value: [graphMessage({ id: 'id-4', parentFolderId: 'SENT', from: { emailAddress: { name: 'Alex', address: 'alex@acme.example' } } })] })],
    [
      '/me/messages',
      () =>
        json({
          value: [
            graphMessage(),
            graphMessage({ id: 'id-2', isDraft: true }),
            graphMessage({ id: 'id-3', parentFolderId: 'JUNK' }),
            graphMessage({ id: 'id-5', parentFolderId: 'TRASH' }),
            graphMessage({ id: 'id-6', '@odata.type': '#microsoft.graph.eventMessageRequest', body: { contentType: 'html', content: '<p>Join &amp; meet</p>' } }),
          ],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/messages?page=2',
        }),
    ],
  ]);
  const provider = createOutlookProvider(account(), { fetchImpl });
  const { messages, complete } = await provider.fetchMessages({ since: new Date('2026-11-08T00:00:00Z') });

  assert.equal(complete, true);
  assert.deepEqual(messages.map((m) => m.providerId), ['id-1', 'id-6', 'id-4']);
  const [first, invite, sent] = messages;
  assert.equal(first.threadKey, 'c:conv-1');
  assert.deepEqual(first.from, { name: 'Priya Raman', email: 'priya@northwind.example' });
  assert.equal(first.isRead, false);
  assert.equal(first.importance, 'high');
  assert.equal(first.sentAt, '2026-11-20T09:59:58.000Z');
  assert.equal(first.focused, true);
  assert.equal(first.folderHint, 'other');
  assert.equal(invite.isMeetingMessage, true);
  assert.equal(invite.body, 'Join & meet', 'HTML bodies are reduced to text');
  assert.equal(sent.folderHint, 'sent');

  const list = calls.find((c) => c.url.includes('/me/messages?'));
  const q = new URL(list.url).searchParams;
  assert.equal(q.get('$filter'), 'receivedDateTime ge 2026-11-08T00:00:00.000Z');
  assert.equal(q.get('$orderby'), 'receivedDateTime desc');
  assert.equal(list.init.headers.Authorization, 'Bearer at-1');
  assert.match(list.init.headers.Prefer, /ImmutableId/);
  assert.match(list.init.headers.Prefer, /body-content-type="text"/);
  assert.ok(calls.every((c) => (c.init.method || 'GET') === 'GET'), 'the mailbox is only ever read');
});

test('an expired token is refreshed and the new tokens are saved', async () => {
  let saved = null;
  const { fetchImpl, calls } = fakeMicrosoft([
    ['/oauth2/v2.0/token', () => json({ access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 })],
    ['/me?', (url, init) => (init.headers.Authorization === 'Bearer at-2' ? json({ displayName: 'Alex Morgan', mail: 'Alex@Acme.example' }) : json({}, 401))],
  ]);
  const provider = createOutlookProvider(account({ expiresAt: Date.now() - 1000 }), { fetchImpl, saveConfig: (c) => (saved = c) });
  assert.deepEqual(await provider.whoAmI(), { name: 'Alex Morgan', email: 'alex@acme.example' });
  const body = new URLSearchParams(calls[0].init.body);
  assert.equal(body.get('grant_type'), 'refresh_token');
  assert.equal(body.get('refresh_token'), 'rt-1');
  assert.equal(saved.accessToken, 'at-2');
  assert.equal(saved.refreshToken, 'rt-2');
});

test('a 401 with a seemingly valid token triggers one refresh and a retry', async () => {
  const { fetchImpl, calls } = fakeMicrosoft([
    ['/oauth2/v2.0/token', () => json({ access_token: 'at-2', expires_in: 3600 })],
    ['/me?', (url, init) => (init.headers.Authorization === 'Bearer at-2' ? json({ displayName: 'A', userPrincipalName: 'a@b.example' }) : json({ error: { message: 'expired' } }, 401))],
  ]);
  const me = await createOutlookProvider(account(), { fetchImpl }).whoAmI();
  assert.equal(me.email, 'a@b.example');
  assert.equal(calls.filter((c) => c.url.includes('/token')).length, 1);
});

test('a revoked sign-in is reported as needing re-authentication', async () => {
  const { fetchImpl } = fakeMicrosoft([['/oauth2/v2.0/token', () => json({ error: 'invalid_grant', error_description: 'AADSTS700082: The refresh token has expired.\r\nTrace ID: abc' }, 400)]]);
  const provider = createOutlookProvider(account({ expiresAt: 0 }), { fetchImpl });
  await assert.rejects(provider.whoAmI(), (err) => err.needsAuth === true && /expired/.test(err.message));
});

test('throttling is retried after the wait Microsoft asks for', async () => {
  const waits = [];
  let n = 0;
  const { fetchImpl } = fakeMicrosoft([['/me?', () => (++n < 3 ? json({}, 429, { 'Retry-After': '7' }) : json({ displayName: 'A', mail: 'a@b.example' }))]]);
  const me = await createOutlookProvider(account(), { fetchImpl, sleepImpl: async (ms) => waits.push(ms) }).whoAmI();
  assert.equal(me.email, 'a@b.example');
  assert.deepEqual(waits, [7000, 7000]);
});

test('other Graph errors surface Microsoft\'s message', async () => {
  const { fetchImpl } = fakeMicrosoft([...folders, ['/me/messages', () => json({ error: { code: 'ErrorAccessDenied', message: 'Access is denied.' } }, 403)]]);
  await assert.rejects(createOutlookProvider(account(), { fetchImpl }).fetchMessages({ since: new Date() }), /Access is denied/);
});

test('calendar events are read in UTC and mapped', async () => {
  const { fetchImpl, calls } = fakeMicrosoft([
    [
      '/me/calendarView',
      () =>
        json({
          value: [
            {
              id: 'ev-1',
              subject: 'Weekly sync',
              start: { dateTime: '2026-11-23T15:00:00.0000000', timeZone: 'UTC' },
              end: { dateTime: '2026-11-23T15:30:00.0000000', timeZone: 'UTC' },
              isAllDay: false,
              isCancelled: false,
              attendees: [{ emailAddress: { name: 'Dana', address: 'dana@acme.example' } }],
              onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/abc' },
              location: { displayName: 'Room 4' },
              responseStatus: { response: 'accepted' },
            },
            { id: 'ev-2', subject: 'Declined thing', start: { dateTime: '2026-11-23T16:00:00.0000000' }, end: { dateTime: '2026-11-23T17:00:00.0000000' }, responseStatus: { response: 'declined' } },
          ],
        }),
    ],
  ]);
  const events = await createOutlookProvider(account(), { fetchImpl }).fetchEvents({ from: new Date('2026-11-23T00:00:00Z'), to: new Date('2026-11-24T00:00:00Z') });
  assert.equal(events[0].startAt, '2026-11-23T15:00:00.000Z');
  assert.equal(events[0].endAt, '2026-11-23T15:30:00.000Z');
  assert.equal(events[0].joinUrl, 'https://teams.microsoft.com/l/meetup-join/abc');
  assert.deepEqual(events[0].attendees, [{ name: 'Dana', email: 'dana@acme.example' }]);
  assert.equal(events[1].declined, true);
  assert.equal(calls[0].init.headers.Prefer, 'outlook.timezone="UTC"');
});
