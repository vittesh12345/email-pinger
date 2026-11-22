import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createImapProvider, imapDefaults } from '../src/providers/imap.js';

const raw = (lines) => Buffer.from(lines.join('\r\n'));

/** A minimal stand-in for an ImapFlow client, recording how it is used. */
function fakeImap({ boxes, mail }) {
  const log = [];
  let current = null;
  const client = {
    log,
    on() {},
    async connect() {},
    async logout() {
      log.push('logout');
    },
    async list() {
      return boxes;
    },
    async getMailboxLock(path, opts) {
      log.push(`lock ${path} readOnly=${!!opts?.readOnly}`);
      current = path;
      client.mailbox = { uidValidity: 77n };
      return { release: () => log.push(`release ${path}`) };
    },
    async search(query) {
      assert.ok(query.since instanceof Date);
      return (mail[current] || []).map((m) => m.uid);
    },
    async *fetch(range, query) {
      const wanted = new Set(String(range).split(',').map(Number));
      log.push(`fetch ${current} ${query.source ? 'source' : 'meta'} ${[...wanted].join('+')}`);
      for (const m of mail[current] || []) {
        if (!wanted.has(m.uid)) continue;
        if (query.source) {
          assert.equal(query.source.maxLength, 64 * 1024);
          yield { uid: m.uid, source: m.source };
        } else {
          yield { uid: m.uid, envelope: m.envelope, flags: new Set(m.flags || []), internalDate: m.envelope.date, threadId: m.threadId, headers: m.headers };
        }
      }
    },
  };
  return client;
}

const question = {
  uid: 5,
  envelope: {
    date: new Date('2026-11-20T10:00:00Z'),
    subject: 'Renewal',
    messageId: '<q1@northwind.example>',
    inReplyTo: null,
    from: [{ name: 'Priya Raman', address: 'Priya@Northwind.example' }],
    to: [{ name: 'Alex', address: 'alex@acme.example' }],
    cc: [],
  },
  flags: [],
  headers: raw(['References: <a@x>', '  <b@x>', 'Importance: High', '']),
  source: raw(['From: Priya <priya@northwind.example>', 'Subject: Renewal', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable', '', 'Can you confirm the 40=E2=80=91seat plan?', '']),
};
const newsletter = {
  uid: 6,
  envelope: { date: new Date('2026-11-21T08:00:00Z'), subject: 'Weekly', messageId: '<n1@brief.example>', from: [{ name: 'Brief', address: 'hello@brief.example' }], to: [{ address: 'alex@acme.example' }] },
  flags: ['\\Seen'],
  headers: raw(['List-Unsubscribe: <mailto:u@brief.example>', 'Precedence: bulk', '']),
  source: raw(['From: Brief <hello@brief.example>', 'Subject: Weekly', 'MIME-Version: 1.0', 'Content-Type: text/html; charset=utf-8', '', '<html><body><p>Top <b>stories</b></p></body></html>', '']),
};
const sentMail = {
  uid: 2,
  envelope: { date: new Date('2026-11-19T09:00:00Z'), subject: 'Proposal', messageId: '<s1@acme.example>', from: [{ name: 'Alex', address: 'alex@acme.example' }], to: [{ name: 'Elena', address: 'elena@brightside.example' }] },
  flags: ['\\Seen'],
  headers: raw(['']),
  source: raw(['From: Alex <alex@acme.example>', 'Subject: Proposal', 'Content-Type: text/plain', '', 'Could you let me know?', '']),
};

const account = (host = 'imap.fastmail.com') => ({ config: { host, port: 993, user: 'alex@acme.example', pass: 'app-password' } });

test('ordinary IMAP: reads INBOX and Sent read-only and maps messages', async () => {
  const client = fakeImap({
    boxes: [{ path: 'INBOX' }, { path: 'Sent Items', specialUse: '\\Sent' }, { path: 'Trash', specialUse: '\\Trash' }],
    mail: { INBOX: [question, newsletter], 'Sent Items': [sentMail] },
  });
  const provider = createImapProvider(account(), { clientFactory: () => client });
  const { messages, complete } = await provider.fetchMessages({ since: new Date('2026-11-08T00:00:00Z') });

  assert.equal(complete, true);
  assert.deepEqual(messages.map((m) => m.providerId), ['INBOX:77:5', 'INBOX:77:6', 'Sent Items:77:2']);
  const [q, n, s] = messages;
  assert.deepEqual(q.from, { name: 'Priya Raman', email: 'priya@northwind.example' });
  assert.equal(q.body, 'Can you confirm the 40‑seat plan?', 'quoted-printable UTF-8 is decoded');
  assert.deepEqual(q.references, ['<a@x>', '<b@x>'], 'folded header lines are joined');
  assert.equal(q.importance, 'high');
  assert.equal(q.isRead, false);
  assert.equal(q.messageIdHeader, '<q1@northwind.example>');
  assert.equal(q.threadKey, undefined, 'plain IMAP has no native thread id; the triage code derives one');
  assert.equal(q.webLink, null);
  assert.deepEqual(n.headers, { listUnsubscribe: true, autoSubmitted: false, precedence: 'bulk' });
  assert.equal(n.body, 'Top stories', 'HTML-only mail is reduced to text');
  assert.equal(n.isRead, true);
  assert.equal(s.folderHint, 'sent');

  assert.ok(client.log.includes('lock INBOX readOnly=true'));
  assert.ok(client.log.includes('lock Sent Items readOnly=true'));
  assert.ok(!client.log.some((l) => l.includes('Trash')), 'Trash is never read');
  assert.equal(client.log.at(-1), 'logout');
});

test('Gmail: reads All Mail only, uses Gmail thread ids, links back to the message', async () => {
  const client = fakeImap({
    boxes: [{ path: 'INBOX' }, { path: '[Gmail]/All Mail', specialUse: '\\All' }, { path: '[Gmail]/Sent Mail', specialUse: '\\Sent' }],
    mail: { '[Gmail]/All Mail': [{ ...question, threadId: '1789' }] },
  });
  const { messages } = await createImapProvider(account('imap.gmail.com'), { clientFactory: () => client }).fetchMessages({ since: new Date() });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].threadKey, 'g:1789');
  assert.equal(messages[0].folderHint, 'other');
  assert.match(messages[0].webLink, /^https:\/\/mail\.google\.com\/mail\/u\/0\/#search\/rfc822msgid%3A/);
  assert.deepEqual(client.log.filter((l) => l.startsWith('lock')), ['lock [Gmail]/All Mail readOnly=true']);
});

test('bodies are downloaded only for messages not stored yet', async () => {
  const client = fakeImap({ boxes: [{ path: 'INBOX' }], mail: { INBOX: [question, newsletter] } });
  const { messages } = await createImapProvider(account(), { clientFactory: () => client }).fetchMessages({
    since: new Date(),
    knownIds: new Set(['INBOX:77:5']),
  });
  assert.equal(messages[0].body, undefined, 'known message: keep the stored body');
  assert.equal(messages[1].body, 'Top stories');
  assert.deepEqual(client.log.filter((l) => l.includes('source')), ['fetch INBOX source 6']);
});

test('a rejected password is explained in plain language', async () => {
  const client = { on() {}, async connect() { throw Object.assign(new Error('Command failed'), { authenticationFailed: true }); } };
  await assert.rejects(createImapProvider(account(), { clientFactory: () => client }).test(), (err) => err.needsAuth && /app password/.test(err.message));
  const down = { on() {}, async connect() { throw Object.assign(new Error('getaddrinfo'), { code: 'ENOTFOUND' }); } };
  await assert.rejects(createImapProvider(account('imap.nope.example'), { clientFactory: () => down }).test(), /Could not find the mail server "imap\.nope\.example"/);
});

test('imapDefaults knows the common providers', () => {
  assert.equal(imapDefaults('a@icloud.com').host, 'imap.mail.me.com');
  assert.equal(imapDefaults('a@custom.example').host, 'imap.custom.example');
  assert.equal(imapDefaults('a@custom.example').known, false);
  assert.equal(imapDefaults('a@outlook.com').microsoft, true);
});
