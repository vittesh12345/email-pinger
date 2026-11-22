import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOutlookDesktopProvider, OutlookDesktopError } from '../src/providers/outlook-desktop.js';

/** Stand-in for the PowerShell reader: answers by mode and records what was asked. */
function fakeRun(replies) {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    const reply = replies[args.what];
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { run, calls };
}

test('test() returns the signed-in mailbox, lower-cased', async () => {
  const { run } = fakeRun({ test: { ok: true, email: 'Alex.Morgan@Acme.example', name: 'Alex Morgan' } });
  assert.deepEqual(await createOutlookDesktopProvider({}, { run }).test(), { email: 'alex.morgan@acme.example', name: 'Alex Morgan' });
});

test('test() refuses a mailbox with no address', async () => {
  const { run } = fakeRun({ test: { ok: true, email: '', name: 'x' } });
  await assert.rejects(createOutlookDesktopProvider({}, { run }).test(), /did not report a mailbox address/);
});

test('messages from the reader are mapped to the shared shape', async () => {
  const { run, calls } = fakeRun({
    messages: {
      ok: true,
      complete: false,
      messages: [
        {
          providerId: 'EID-1',
          threadKey: 'c:CONV1',
          messageIdHeader: '<a@x>',
          from: { name: 'Priya Raman', email: 'Priya@Northwind.example' },
          to: [{ name: 'Alex', email: 'Alex@Acme.example' }],
          cc: null,
          subject: 'Renewal',
          body: 'Can you confirm the plan?',
          sentAt: '2026-11-20T10:00:00.000Z',
          isRead: false,
          importance: 'high',
          folderHint: 'inbox',
          isMeetingMessage: false,
        },
        {
          providerId: 'EID-2',
          threadKey: null,
          from: { name: 'Alex', email: 'alex@acme.example' },
          to: [{ name: 'Elena', email: 'elena@brightside.example' }],
          subject: 'Proposal',
          body: 'Could you let me know?',
          sentAt: '2026-11-19T09:00:00.000Z',
          isRead: true,
          importance: 'normal',
          folderHint: 'sent',
        },
      ],
    },
  });
  const since = new Date('2026-11-08T00:00:00Z');
  const { messages, complete } = await createOutlookDesktopProvider({}, { run }).fetchMessages({ since });

  assert.equal(calls[0].since, '2026-11-08T00:00:00.000Z');
  assert.equal(complete, false, 'a capped read is reported as incomplete, so nothing gets deleted');
  const [a, b] = messages;
  assert.deepEqual(a.from, { name: 'Priya Raman', email: 'priya@northwind.example' });
  assert.deepEqual(a.cc, [], 'a null list from PowerShell becomes empty');
  assert.equal(a.threadKey, 'c:CONV1');
  assert.equal(a.isRead, false);
  assert.equal(a.importance, 'high');
  assert.equal(b.threadKey, undefined, 'no conversation id: the triage code derives one');
  assert.equal(b.folderHint, 'sent');
});

test('an empty mailbox (PowerShell emits null for an empty list) is fine', async () => {
  const { run } = fakeRun({ messages: { ok: true, complete: true, messages: null } });
  assert.deepEqual(await createOutlookDesktopProvider({}, { run }).fetchMessages({ since: new Date() }), { messages: [], complete: true });
});

test('calendar events: meeting links are found in the location or body', async () => {
  const { run, calls } = fakeRun({
    events: {
      ok: true,
      events: [
        {
          providerId: 'EID-9|2026-11-23T15:00:00.000Z',
          title: 'Weekly sync',
          startAt: '2026-11-23T15:00:00.000Z',
          endAt: '2026-11-23T15:30:00.000Z',
          attendees: [{ name: 'Dana', email: 'Dana@Acme.example' }, { name: '', email: '' }],
          location: 'Microsoft Teams Meeting',
          bodyForLink: 'Join: https://teams.microsoft.com/l/meetup-join/abc123 now',
          isAllDay: false,
          isCancelled: false,
          declined: true,
        },
        { providerId: 'x', title: 'No start', startAt: null },
      ],
    },
  });
  const from = new Date('2026-11-23T00:00:00Z');
  const to = new Date('2026-11-30T00:00:00Z');
  const events = await createOutlookDesktopProvider({}, { run }).fetchEvents({ from, to });
  assert.equal(calls[0].from, from.toISOString());
  assert.equal(events.length, 1);
  assert.equal(events[0].joinUrl, 'https://teams.microsoft.com/l/meetup-join/abc123');
  assert.deepEqual(events[0].attendees, [{ name: 'Dana', email: 'dana@acme.example' }]);
  assert.equal(events[0].declined, true);
});

test("the reader's errors are passed through", async () => {
  const { run } = fakeRun({ messages: new OutlookDesktopError('Outlook refused access.') });
  await assert.rejects(createOutlookDesktopProvider({}, { run }).fetchMessages({ since: new Date() }), /refused access/);
});

test('on a non-Windows computer the real reader reports that it is Windows-only', { skip: process.platform === 'win32' }, async () => {
  await assert.rejects(createOutlookDesktopProvider({}).test(), /only be read on Windows/);
});
