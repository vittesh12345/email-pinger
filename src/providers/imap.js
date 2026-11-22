// Gmail, iCloud, Yahoo, Fastmail and any other IMAP mailbox (usually with an app password).
// Mailboxes are opened read-only: nothing is marked read, moved or deleted.

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { htmlToText } from '../core/text.js';

const MAX_PER_FOLDER = 400;
const SOURCE_BYTES = 64 * 1024;

const PRESETS = {
  'gmail.com': 'imap.gmail.com',
  'googlemail.com': 'imap.gmail.com',
  'yahoo.com': 'imap.mail.yahoo.com',
  'icloud.com': 'imap.mail.me.com',
  'me.com': 'imap.mail.me.com',
  'mac.com': 'imap.mail.me.com',
  'aol.com': 'imap.aol.com',
  'fastmail.com': 'imap.fastmail.com',
  'zoho.com': 'imap.zoho.com',
  'gmx.com': 'imap.gmx.com',
  'gmx.de': 'imap.gmx.net',
  'web.de': 'imap.web.de',
};
const MICROSOFT_DOMAINS = new Set(['outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'office365.com']);

export function imapDefaults(email) {
  const domain = String(email || '').split('@')[1]?.toLowerCase() || '';
  return {
    host: PRESETS[domain] || (domain ? `imap.${domain}` : ''),
    port: 993,
    known: !!PRESETS[domain],
    microsoft: MICROSOFT_DOMAINS.has(domain),
  };
}

export class ImapError extends Error {
  constructor(message, { needsAuth = false } = {}) {
    super(message);
    this.needsAuth = needsAuth;
  }
}

function explain(err, host) {
  if (err instanceof ImapError) return err;
  if (err?.authenticationFailed) {
    return new ImapError(
      'The mail server rejected the sign-in. Most providers need an "app password" here, not your normal password.',
      { needsAuth: true },
    );
  }
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(err?.code)) return new ImapError(`Could not find the mail server "${host}".`);
  if (['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET'].includes(err?.code) || /timeout/i.test(err?.message || '')) {
    return new ImapError(`Could not connect to the mail server "${host}".`);
  }
  return new ImapError(err?.responseText || err?.message || 'The mail server returned an error.');
}

const people = (list) =>
  (list || []).map((a) => ({ name: a.name || '', email: (a.address || '').toLowerCase() })).filter((p) => p.email);

function parseHeaderBlock(buffer) {
  const out = {};
  const unfolded = String(buffer || '').replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

/**
 * @param {{config: {host:string, port:number, user:string, pass:string, secure?:boolean}}} account
 * @param {{clientFactory?: (cfg: object) => any}} [deps]
 */
export function createImapProvider(account, { clientFactory } = {}) {
  const cfg = account.config;

  async function connect() {
    const client = clientFactory
      ? clientFactory(cfg)
      : new ImapFlow({
          host: cfg.host,
          port: cfg.port || 993,
          secure: cfg.secure ?? (cfg.port || 993) === 993,
          auth: { user: cfg.user, pass: cfg.pass },
          logger: false,
          socketTimeout: 60_000,
          ...(cfg.allowInsecure ? { tls: { rejectUnauthorized: false } } : {}),
        });
    // An unhandled 'error' event would take the whole app down with it.
    client.on?.('error', () => {});
    try {
      await client.connect();
    } catch (err) {
      throw explain(err, cfg.host);
    }
    return client;
  }

  async function readFolder(client, folder, { since, knownIds }) {
    const lock = await client.getMailboxLock(folder.path, { readOnly: true });
    const messages = [];
    let complete = true;
    try {
      const validity = String(client.mailbox?.uidValidity ?? '0');
      let uids = (await client.search({ since }, { uid: true })) || [];
      uids = [...uids].sort((a, b) => a - b);
      if (uids.length > MAX_PER_FOLDER) {
        complete = false;
        uids = uids.slice(-MAX_PER_FOLDER);
      }
      if (!uids.length) return { messages, complete };

      const meta = [];
      const query = {
        uid: true,
        envelope: true,
        flags: true,
        internalDate: true,
        threadId: true,
        headers: ['list-unsubscribe', 'precedence', 'auto-submitted', 'references', 'importance', 'x-priority'],
      };
      for await (const msg of client.fetch(uids.join(','), query, { uid: true })) meta.push(msg);

      // Bodies only for messages we have not stored yet.
      const idOf = (uid) => `${folder.path}:${validity}:${uid}`;
      const wanted = meta.filter((m) => !knownIds.has(idOf(m.uid))).map((m) => m.uid);
      const bodies = new Map();
      if (wanted.length) {
        const sourceQuery = { uid: true, source: { start: 0, maxLength: SOURCE_BYTES } };
        for await (const msg of client.fetch(wanted.join(','), sourceQuery, { uid: true })) {
          try {
            const parsed = await simpleParser(msg.source, { skipImageLinks: true, skipTextToHtml: true });
            bodies.set(msg.uid, parsed.text?.trim() || htmlToText(parsed.html || ''));
          } catch {
            bodies.set(msg.uid, '');
          }
        }
      }

      for (const msg of meta) {
        const env = msg.envelope || {};
        const headers = parseHeaderBlock(msg.headers);
        const date = env.date || msg.internalDate || new Date();
        const important = /high/i.test(headers.importance || '') || /^[12]\b/.test(headers['x-priority'] || '');
        messages.push({
          providerId: idOf(msg.uid),
          threadKey: msg.threadId ? `g:${msg.threadId}` : undefined,
          messageIdHeader: env.messageId || null,
          inReplyTo: env.inReplyTo || null,
          references: (headers.references || '').split(/\s+/).filter(Boolean),
          from: people(env.from)[0] || { name: '', email: '' },
          to: people(env.to),
          cc: people(env.cc),
          subject: env.subject || '',
          body: bodies.has(msg.uid) ? bodies.get(msg.uid) : undefined, // undefined = keep what is stored
          sentAt: new Date(date).toISOString(),
          isRead: msg.flags?.has('\\Seen') ?? true,
          importance: important ? 'high' : 'normal',
          webLink:
            /(^|\.)gmail\.com$/i.test(cfg.host || '') && env.messageId
              ? `https://mail.google.com/mail/u/0/#search/rfc822msgid%3A${encodeURIComponent(env.messageId)}`
              : null,
          folderHint: folder.hint,
          headers: {
            listUnsubscribe: !!headers['list-unsubscribe'],
            autoSubmitted: !!headers['auto-submitted'] && !/^no$/i.test(headers['auto-submitted']),
            precedence: (headers.precedence || '').toLowerCase() || undefined,
          },
        });
      }
    } finally {
      lock.release();
    }
    return { messages, complete };
  }

  return {
    async test() {
      const client = await connect();
      await client.logout().catch(() => {});
    },

    async fetchMessages({ since, knownIds = new Set() }) {
      const client = await connect();
      try {
        const boxes = await client.list();
        const allMail = boxes.find((b) => b.specialUse === '\\All');
        const sent = boxes.find((b) => b.specialUse === '\\Sent');
        // Gmail's "All Mail" already holds everything received and sent (minus Spam and Trash).
        const folders = allMail
          ? [{ path: allMail.path, hint: 'other' }]
          : [{ path: 'INBOX', hint: 'inbox' }, ...(sent ? [{ path: sent.path, hint: 'sent' }] : [])];
        const messages = [];
        let complete = true;
        for (const folder of folders) {
          const part = await readFolder(client, folder, { since, knownIds });
          messages.push(...part.messages);
          complete = complete && part.complete;
        }
        return { messages, complete };
      } catch (err) {
        throw explain(err, cfg.host);
      } finally {
        await client.logout().catch(() => {});
      }
    },
  };
}
