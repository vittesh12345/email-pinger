// Outlook / Microsoft 365 via Microsoft Graph. Read-only: mail and calendar are only ever read.
//
// Sign-in uses the OAuth authorization-code flow with PKCE as a public client (no secret),
// redirecting back to this app on localhost.

import crypto from 'node:crypto';
import { htmlToText } from '../core/text.js';
import { sleep } from '../util.js';

const AUTHORITY = 'https://login.microsoftonline.com';
const GRAPH = 'https://graph.microsoft.com/v1.0';
export const SCOPES = ['offline_access', 'User.Read', 'Mail.Read', 'Calendars.Read'];
const MAX_MESSAGES = 600;

const MESSAGE_FIELDS = [
  'id', 'conversationId', 'internetMessageId', 'subject', 'from', 'sender', 'toRecipients', 'ccRecipients',
  'receivedDateTime', 'sentDateTime', 'isRead', 'isDraft', 'importance', 'webLink', 'parentFolderId',
  'inferenceClassification', 'body', 'bodyPreview',
].join(',');
const EVENT_FIELDS = [
  'id', 'subject', 'start', 'end', 'isAllDay', 'isCancelled', 'attendees', 'onlineMeeting', 'onlineMeetingUrl',
  'location', 'responseStatus',
].join(',');

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function pkcePair() {
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function authorizeUrl({ clientId, tenant = 'common', redirectUri, state, challenge }) {
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: SCOPES.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return `${AUTHORITY}/${encodeURIComponent(tenant)}/oauth2/v2.0/authorize?${params}`;
}

export class OutlookError extends Error {
  constructor(message, { needsAuth = false } = {}) {
    super(message);
    this.needsAuth = needsAuth;
  }
}

async function tokenRequest(tenant, params, fetchImpl) {
  const res = await fetchImpl(`${AUTHORITY}/${encodeURIComponent(tenant || 'common')}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const expired = json.error === 'invalid_grant' || json.error === 'interaction_required';
    throw new OutlookError(
      expired
        ? 'Your Outlook sign-in has expired. Connect the account again.'
        : `Microsoft sign-in failed: ${json.error_description?.split('\r\n')[0] || json.error || res.status}`,
      { needsAuth: expired },
    );
  }
  return json;
}

/** Trade the code from the sign-in redirect for tokens. */
export async function redeemCode({ clientId, tenant, redirectUri, code, verifier, fetchImpl = fetch }) {
  const t = await tokenRequest(
    tenant,
    { client_id: clientId, grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier },
    fetchImpl,
  );
  return {
    clientId,
    tenant: tenant || 'common',
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    expiresAt: Date.now() + (t.expires_in || 3600) * 1000,
  };
}

const person = (r) => ({ name: r?.emailAddress?.name || '', email: (r?.emailAddress?.address || '').toLowerCase() });

// Graph returns "2026-11-22T15:00:00.0000000" (UTC, because we ask for it) with no zone marker.
const graphUtc = (s) => (s ? new Date(`${String(s).slice(0, 23)}Z`).toISOString() : null);

/**
 * @param {{config: object}} account
 * @param {{saveConfig?: (cfg: object) => void, fetchImpl?: typeof fetch, sleepImpl?: typeof sleep}} [deps]
 */
export function createOutlookProvider(account, { saveConfig, fetchImpl = fetch, sleepImpl = sleep } = {}) {
  let cfg = { ...account.config };

  async function accessToken() {
    if (cfg.accessToken && cfg.expiresAt - 60_000 > Date.now()) return cfg.accessToken;
    if (!cfg.refreshToken) throw new OutlookError('Connect your Outlook account again.', { needsAuth: true });
    const t = await tokenRequest(
      cfg.tenant,
      { client_id: cfg.clientId, grant_type: 'refresh_token', refresh_token: cfg.refreshToken, scope: SCOPES.join(' ') },
      fetchImpl,
    );
    cfg = {
      ...cfg,
      accessToken: t.access_token,
      refreshToken: t.refresh_token || cfg.refreshToken,
      expiresAt: Date.now() + (t.expires_in || 3600) * 1000,
    };
    saveConfig?.(cfg);
    return cfg.accessToken;
  }

  async function graph(pathOrUrl, prefer, attempt = 0) {
    const token = await accessToken();
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : GRAPH + pathOrUrl;
    const res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}`, ...(prefer ? { Prefer: prefer } : {}) },
    });
    if (res.status === 401 && attempt === 0) {
      cfg = { ...cfg, accessToken: null };
      return graph(pathOrUrl, prefer, attempt + 1);
    }
    if ((res.status === 429 || res.status === 503 || res.status === 504) && attempt < 3) {
      const wait = Math.min(Number(res.headers.get('retry-after')) || 2, 20);
      await sleepImpl(wait * 1000);
      return graph(pathOrUrl, prefer, attempt + 1);
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const message = body?.error?.message || `HTTP ${res.status}`;
      throw new OutlookError(`Outlook could not be read: ${message}`, { needsAuth: res.status === 401 });
    }
    return res.json();
  }

  async function folderId(wellKnownName) {
    try {
      return (await graph(`/me/mailFolders/${wellKnownName}?$select=id`, 'IdType="ImmutableId"')).id;
    } catch (err) {
      if (err.needsAuth) throw err;
      return null; // a missing well-known folder is not fatal
    }
  }

  return {
    async whoAmI() {
      const me = await graph('/me?$select=displayName,mail,userPrincipalName');
      return { name: me.displayName || '', email: (me.mail || me.userPrincipalName || '').toLowerCase() };
    },

    /** Everything received or sent since `since`, in any folder except Junk, Deleted and Drafts. */
    async fetchMessages({ since }) {
      const [sent, junk, deleted] = await Promise.all(['sentitems', 'junkemail', 'deleteditems'].map(folderId));
      const query = new URLSearchParams({
        $filter: `receivedDateTime ge ${since.toISOString()}`,
        $orderby: 'receivedDateTime desc',
        $top: '50',
        $select: MESSAGE_FIELDS,
      });
      const prefer = 'IdType="ImmutableId", outlook.body-content-type="text"';
      const messages = [];
      let complete = true;
      let url = `/me/messages?${query}`;
      while (url) {
        const page = await graph(url, prefer);
        for (const m of page.value || []) {
          if (m.isDraft || (junk && m.parentFolderId === junk) || (deleted && m.parentFolderId === deleted)) continue;
          const raw = m.body?.content ?? m.bodyPreview ?? '';
          messages.push({
            providerId: m.id,
            threadKey: m.conversationId ? `c:${m.conversationId}` : undefined,
            messageIdHeader: m.internetMessageId || null,
            from: person(m.from || m.sender),
            to: (m.toRecipients || []).map(person),
            cc: (m.ccRecipients || []).map(person),
            subject: m.subject || '',
            body: m.body?.contentType === 'html' ? htmlToText(raw) : raw,
            sentAt: new Date(m.sentDateTime || m.receivedDateTime).toISOString(),
            isRead: m.isRead !== false,
            importance: m.importance || 'normal',
            webLink: m.webLink || null,
            folderHint: sent && m.parentFolderId === sent ? 'sent' : 'other',
            focused: m.inferenceClassification ? m.inferenceClassification === 'focused' : undefined,
            isMeetingMessage: /eventMessage/i.test(m['@odata.type'] || ''),
          });
        }
        url = page['@odata.nextLink'] || null;
        if (url && messages.length >= MAX_MESSAGES) {
          complete = false;
          break;
        }
      }
      return { messages, complete };
    },

    async fetchEvents({ from, to }) {
      const query = new URLSearchParams({
        startDateTime: from.toISOString(),
        endDateTime: to.toISOString(),
        $top: '100',
        $orderby: 'start/dateTime',
        $select: EVENT_FIELDS,
      });
      const events = [];
      let url = `/me/calendarView?${query}`;
      while (url && events.length < 500) {
        const page = await graph(url, 'outlook.timezone="UTC"');
        for (const e of page.value || []) {
          events.push({
            providerId: e.id,
            title: e.subject || '(no title)',
            startAt: graphUtc(e.start?.dateTime),
            endAt: graphUtc(e.end?.dateTime),
            attendees: (e.attendees || []).map(person).filter((p) => p.email || p.name),
            joinUrl: e.onlineMeeting?.joinUrl || e.onlineMeetingUrl || null,
            location: e.location?.displayName || null,
            isAllDay: !!e.isAllDay,
            isCancelled: !!e.isCancelled,
            declined: e.responseStatus?.response === 'declined',
          });
        }
        url = page['@odata.nextLink'] || null;
      }
      return events.filter((e) => e.startAt);
    },
  };
}
