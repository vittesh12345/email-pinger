import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cleanSnapshot, cleanStructure, folderKind, itemsToMessages, ownerFromTitle, parseOpenMessage, parseOwaDate, parseRow, person, snapshotToItems,
} from '../src/core/owa-parse.js';

// Sunday 22 November 2026, 11:00 local time.
const NOW = new Date(2026, 10, 22, 11, 0, 0);
const EN = { order: 'MDY', weekdays: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], weekdaysLong: [], yesterday: 'yesterday', today: 'today' };
const DE = {
  order: 'DMY',
  weekdays: ['So.', 'Mo.', 'Di.', 'Mi.', 'Do.', 'Fr.', 'Sa.'],
  weekdaysLong: ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'],
  yesterday: 'gestern',
  today: 'heute',
};
const ctx = { locale: EN, now: NOW };
const local = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
const parsed = (text, c = ctx) => {
  const p = parseOwaDate(text, c);
  return p && { at: local(p.date), precision: p.precision };
};

test('dates: the forms Outlook on the web uses in the message list', () => {
  assert.deepEqual(parsed('9:42 AM'), { at: '2026-11-22 9:42', precision: 'minute' });
  assert.deepEqual(parsed('11:30 PM'), { at: '2026-11-21 23:30', precision: 'minute' }, 'later than now today means yesterday');
  assert.deepEqual(parsed('Fri 3:15 PM'), { at: '2026-11-20 15:15', precision: 'minute' });
  assert.deepEqual(parsed('Sun 9:00 AM'), { at: '2026-11-15 9:00', precision: 'minute' }, "today's weekday means last week");
  assert.deepEqual(parsed('Mon 11/16'), { at: '2026-11-16 12:00', precision: 'day' });
  assert.deepEqual(parsed('11/14/2026'), { at: '2026-11-14 12:00', precision: 'day' });
  assert.deepEqual(parsed('12/30'), { at: '2025-12-30 12:00', precision: 'day' }, 'a date later in the year is last year');
  assert.deepEqual(parsed('Yesterday'), { at: '2026-11-21 12:00', precision: 'day' });
  assert.deepEqual(parsed('12:05 AM'), { at: '2026-11-22 0:05', precision: 'minute' });
});

test('dates: full dates from tooltips and the reading pane', () => {
  assert.deepEqual(parsed('Sat 11/21/2026 11:42 PM'), { at: '2026-11-21 23:42', precision: 'minute' });
  assert.deepEqual(parsed('Saturday, November 21, 2026 11:42 PM'), { at: '2026-11-21 23:42', precision: 'minute' });
  assert.deepEqual(parsed('2026-11-20 08:05'), { at: '2026-11-20 8:05', precision: 'minute' });
  assert.deepEqual(parsed('21 Nov 2026 14:05'), { at: '2026-11-21 14:05', precision: 'minute' });
});

test('dates: other locales', () => {
  const de = { locale: DE, now: NOW };
  assert.deepEqual(parsed('17.11.2026', de), { at: '2026-11-17 12:00', precision: 'day' }, 'day first');
  assert.deepEqual(parsed('Fr. 14:05', de), { at: '2026-11-20 14:05', precision: 'minute' });
  assert.deepEqual(parsed('Gestern 09:12', de), { at: '2026-11-21 9:12', precision: 'minute' });
  assert.deepEqual(parsed('3/11/2026', { locale: { order: 'DMY' }, now: NOW }), { at: '2026-11-3 12:00', precision: 'day' });
  assert.deepEqual(parsed('11/13/2026', { locale: { order: 'DMY' }, now: NOW }), { at: '2026-11-13 12:00', precision: 'day' }, 'impossible month: swapped');
});

test('dates: sentences are not dates, and nonsense is rejected', () => {
  assert.ok(parseOwaDate('Meeting at 3:30 tomorrow', ctx).residue.length > 3, 'a subject containing a time leaves words behind');
  assert.equal(parseOwaDate('Q3 report 2026', ctx), null);
  assert.equal(parseOwaDate('Priya Raman', ctx), null);
  assert.equal(parseOwaDate('25:99', ctx), null);
  assert.equal(parseOwaDate('2/31/2026', ctx), null, '31 February');
  assert.equal(parseOwaDate('', ctx), null);
});

test('person', () => {
  assert.deepEqual(person('Priya Raman <Priya@Northwind.example>'), { name: 'Priya Raman', email: 'priya@northwind.example' });
  assert.deepEqual(person('priya@northwind.example'), { name: '', email: 'priya@northwind.example' });
  assert.deepEqual(person('Jordan Kim; Vittesh Maganti'), { name: 'Jordan Kim', email: '' });
  assert.deepEqual(person('Marcus Lee (3)'), { name: 'Marcus Lee', email: '' }, 'conversation count dropped');
  assert.deepEqual(person('"Raman, Priya"'), { name: 'Raman, Priya', email: '' });
});

test('a list row: sender, subject, date and preview, with badges ignored', () => {
  const row = parseRow(
    {
      convId: 'AAQk1',
      aria: 'Unread Has attachments Priya Raman Contract renewal',
      lines: ['Priya Raman', 'Contract renewal — need your answer by Friday', '9:42 AM', '2', 'Hi Vittesh, can you confirm the 40-seat plan?'],
      titles: ['priya.raman@northwind.example', 'Sun 11/22/2026 9:42 AM'],
    },
    ctx,
  );
  assert.deepEqual(row.sender, { name: 'Priya Raman', email: 'priya.raman@northwind.example' });
  assert.equal(row.subject, 'Contract renewal — need your answer by Friday');
  assert.equal(row.preview, 'Hi Vittesh, can you confirm the 40-seat plan?');
  assert.equal(local(row.when.date), '2026-11-22 9:42');
  assert.equal(row.unread, true);
});

test('a list row whose subject contains a time keeps its subject', () => {
  const row = parseRow({ lines: ['Dana Whitfield', 'Sync moved to 3:30 tomorrow', 'Fri 2:00 PM', 'Same room as before.'], titles: [] }, ctx);
  assert.equal(row.subject, 'Sync moved to 3:30 tomorrow');
  assert.equal(local(row.when.date), '2026-11-20 14:00');
});

test('a reading-pane message: sender with address, recipients on following lines, date, body', () => {
  const m = parseOpenMessage(
    {
      header: 'Priya Raman <priya.raman@northwind.example>\nTo:\nVittesh Maganti\nDana Whitfield\nCc:\nMarcus Lee\nSun 11/22/2026 9:42 AM\n',
      titles: [],
      labels: ['Reply', 'Forward'],
      body: 'Hi Vittesh,\n\nCan you confirm the 40-seat plan by Friday?\n\nPriya',
    },
    ctx,
  );
  assert.deepEqual(m.from, { name: 'Priya Raman', email: 'priya.raman@northwind.example' });
  assert.deepEqual(m.to.map((p) => p.name), ['Vittesh Maganti', 'Dana Whitfield']);
  assert.deepEqual(m.cc.map((p) => p.name), ['Marcus Lee']);
  assert.equal(local(m.when.date), '2026-11-22 9:42');
  assert.match(m.body, /40-seat plan/);
});

test('a reading-pane message: inline "To:" with addresses; no sender address falls back to the name', () => {
  const m = parseOpenMessage(
    { header: 'Marcus Lee\nSat 11/21/2026 4:10 PM\nTo: Vittesh Maganti <vittesh@acme.example>; Dana <dana@acme.example>', titles: [], labels: [], body: 'Thoughts?' },
    ctx,
  );
  assert.deepEqual(m.from, { name: 'Marcus Lee', email: '' }, "a recipient's address is never taken as the sender's");
  assert.deepEqual(m.to, [
    { name: 'Vittesh Maganti', email: 'vittesh@acme.example' },
    { name: 'Dana', email: 'dana@acme.example' },
  ]);
  assert.deepEqual(m.cc, []);
});

test('a reading-pane message with no visible recipients reports them as unknown', () => {
  const m = parseOpenMessage({ header: 'Jordan Kim\nFri 11/20/2026 10:00 AM', body: 'Looks good.' }, ctx);
  assert.equal(m.to, null);
  assert.equal(m.cc, null);
});

test('owner and folder', () => {
  assert.deepEqual(ownerFromTitle('Mail - Vittesh Maganti - Outlook'), { name: 'Vittesh Maganti', email: '' });
  assert.deepEqual(ownerFromTitle('(3) Q4 - roadmap - Vittesh Maganti - Outlook'), { name: 'Vittesh Maganti', email: '' });
  assert.deepEqual(ownerFromTitle('Mail - vittesh@acme.example - Outlook'), { name: '', email: 'vittesh@acme.example' });
  assert.deepEqual(ownerFromTitle('Some other page'), { name: '', email: '' });

  assert.equal(folderKind({ path: '/mail/' }), 'inbox');
  assert.equal(folderKind({ path: '/mail/0/inbox' }), 'inbox');
  assert.equal(folderKind({ path: '/mail/inbox/id/AAQkAG' }), 'inbox');
  assert.equal(folderKind({ path: '/mail/sentitems' }), 'sent');
  assert.equal(folderKind({ path: '/mail/0/sentitems/id/x' }), 'sent');
  assert.equal(folderKind({ path: '/mail/junkemail' }), 'skip');
  assert.equal(folderKind({ path: '/mail/deleteditems' }), 'skip');
  assert.equal(folderKind({ path: '/mail/drafts' }), 'skip');
  assert.equal(folderKind({ path: '/calendar/view/week' }), 'skip', 'not a mail page');
  assert.equal(folderKind({ path: '/mail/search', label: 'Sent Items' }), 'sent', 'folder name as a fallback');
  assert.equal(folderKind({ path: '/mail/AAMk-custom' }), 'other');
});

const ME = { email: 'vittesh@acme.example', name: 'Vittesh Maganti', names: new Set(['vittesh maganti']) };
const snap = (over = {}) => ({
  url: 'https://outlook.office.com/mail/inbox',
  title: 'Mail - Vittesh Maganti - Outlook',
  folder: { path: '/mail/inbox', label: 'Inbox' },
  locale: EN,
  rows: [],
  open: null,
  ...over,
});

test('snapshot → items: inbox rows are incoming with unknown recipients; my own rows are outgoing', () => {
  const items = snapshotToItems(
    snap({
      rows: [
        { convId: 'C1', lines: ['Priya Raman', 'Renewal', '9:42 AM', 'Can you confirm?'], titles: ['priya@northwind.example'] },
        { convId: 'C2', lines: ['Vittesh Maganti', 'Re: Coffee', 'Fri 3:15 PM', 'Tuesday works for me.'], titles: [] },
        { convId: 'C3', lines: ['Weekly Newsletter', 'Top stories', 'Fri 8:00 AM', 'This week…'], titles: [] },
      ],
    }),
    { now: NOW, me: ME },
  );
  const [a, b, c] = items;
  assert.equal(a.folderHint, 'inbox');
  assert.deepEqual(a.from, { name: 'Priya Raman', email: 'priya@northwind.example' });
  assert.equal(a.to, null, 'recipients not visible in the list');
  assert.equal(a.precision, 'minute');
  assert.equal(a.webLink, 'https://outlook.office.com/mail/');
  assert.equal(b.folderHint, 'sent');
  assert.equal(b.from.email, 'vittesh@acme.example');
  assert.equal(c.headers.autoSubmitted, true, 'a newsletter-looking sender name counts as automated');
  assert.notEqual(a.threadKey, b.threadKey);
});

test('snapshot → items: Sent Items rows show the recipient', () => {
  const [item] = snapshotToItems(
    snap({ url: 'https://outlook.office.com/mail/sentitems', folder: { path: '/mail/sentitems' }, rows: [{ convId: 'C9', lines: ['Elena Petrova', 'Proposal', '11/18/2026', 'Could you let me know?'], titles: [] }] }),
    { now: NOW, me: ME },
  );
  assert.equal(item.folderHint, 'sent');
  assert.deepEqual(item.from, { name: 'Vittesh Maganti', email: 'vittesh@acme.example' });
  assert.deepEqual(item.to, [{ name: 'Elena Petrova', email: '' }]);
  assert.equal(item.precision, 'day');
});

test('snapshot → items: nothing from Junk, Deleted or Drafts', () => {
  assert.deepEqual(snapshotToItems(snap({ folder: { path: '/mail/junkemail' }, rows: [{ lines: ['Spammer', 'Win', '9:00 AM', 'Click'] }] }), { now: NOW, me: ME }), []);
});

test('the open conversation joins the selected row’s thread, and its full message replaces the preview', () => {
  const s = snap({
    rows: [{ convId: 'C1', selected: true, lines: ['Priya Raman', 'Renewal', '9:42 AM', 'Hi Vittesh, can you confirm the plan?'], titles: [] }],
    open: {
      subject: 'Renewal',
      messages: [
        { header: 'Priya Raman <priya@northwind.example>\nTo: Vittesh Maganti\nSun 11/22/2026 9:42 AM', body: 'Hi Vittesh, can you confirm the plan? Thanks, Priya' },
        { header: 'Vittesh Maganti <vittesh@acme.example>\nTo: Priya Raman\nFri 11/20/2026 2:00 PM', body: 'Here is the renewal form.' },
      ],
    },
  });
  const items = snapshotToItems(s, { now: NOW, me: ME });
  assert.equal(new Set(items.map((i) => i.threadKey)).size, 1, 'one thread');
  const messages = itemsToMessages(items, { since: new Date(2026, 10, 1) });
  assert.equal(messages.length, 2, 'the list preview of the 9:42 message is dropped');
  const fromPriya = messages.find((m) => m.from.email === 'priya@northwind.example');
  assert.deepEqual(fromPriya.to, [{ name: 'Vittesh Maganti', email: '' }]);
  assert.equal(messages.find((m) => m.folderHint === 'sent').from.email, 'vittesh@acme.example');
});

test('a thread known only by subject is joined to the conversation with the same subject', () => {
  const now = NOW;
  const listed = snapshotToItems(snap({ rows: [{ convId: 'C7', lines: ['Marcus Lee', 'Q4 roadmap draft', 'Sat 4:10 PM', 'Feedback?'] }] }), { now, me: ME });
  const opened = snapshotToItems(
    snap({ rows: [], open: { subject: 'RE: Q4 roadmap draft', messages: [{ header: 'Marcus Lee\nSat 11/21/2026 4:10 PM', body: 'Feedback? Could you look at the hiring section?' }] } }),
    { now, me: ME },
  );
  assert.ok(opened[0].threadKey.startsWith('w:s:'));
  const messages = itemsToMessages([...listed, ...opened], { since: new Date(2026, 10, 1) });
  assert.equal(new Set(messages.map((m) => m.threadKey)).size, 1);
  assert.equal(messages.length, 1, 'the preview is covered by the full message');
});

test('a newer message seen in the list after the conversation was read is kept', () => {
  const read = snapshotToItems(
    snap({ rows: [{ convId: 'C1', selected: true, lines: ['Priya Raman', 'Renewal', 'Fri 9:00 AM', 'First question?'] }], open: { subject: 'Renewal', messages: [{ header: 'Priya Raman <p@n.example>\nFri 11/20/2026 9:00 AM', body: 'First question? Details here.' }] } }),
    { now: NOW, me: ME },
  );
  const later = snapshotToItems(snap({ rows: [{ convId: 'C1', lines: ['Priya Raman', 'Renewal', '10:30 AM', 'Any update on this?'] }] }), { now: NOW, me: ME });
  const messages = itemsToMessages([...read, ...later], { since: new Date(2026, 10, 1) });
  assert.equal(messages.length, 2);
  assert.ok(messages.some((m) => m.body === 'Any update on this?'));
});

test('cleanSnapshot refuses pages that are not Outlook and trims everything to size', () => {
  assert.equal(cleanSnapshot({ url: 'https://evil.example/mail/inbox' }), null);
  assert.equal(cleanSnapshot(null), null);
  const big = cleanSnapshot({
    url: 'https://outlook.live.com/mail/0/inbox',
    locale: { order: 'xyz' },
    rows: Array.from({ length: 500 }, () => ({ lines: ['x'.repeat(5000)], selected: 'yes' })),
  });
  assert.equal(big.rows.length, 300);
  assert.equal(big.rows[0].lines[0].length, 600);
  assert.equal(big.rows[0].selected, false);
  assert.equal(big.locale.order, 'MDY');
});

test('cleanStructure keeps the outline and drops anything that could be content', () => {
  const s = cleanStructure({
    tag: 'DIV',
    role: 'option',
    id: 'priya@northwind.example',
    attrs: ['aria-label', 'data-convid', 'title="Priya"'],
    textLen: 120,
    text: 'Priya Raman Contract renewal',
    kids: [{ tag: 'span', section: 'MessageList', kids: [] }],
  });
  assert.deepEqual(s, { tag: 'div', role: 'option', attrs: ['aria-label', 'data-convid', 'titlePriya'], textLen: 120, kids: [{ tag: 'span', role: '', attrs: [], section: 'MessageList' }] });
  assert.equal(JSON.stringify(s).includes('@'), false);
});
