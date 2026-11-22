import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  askSignals, assignThreadKeys, automatedLevel, evaluateThread, isMeetingMessage, isOverdue, normalizeSubject, stripQuoted,
} from '../src/core/triage.js';

const me = new Set(['alex@acme.example']);
const ALEX = { name: 'Alex', email: 'alex@acme.example' };
const PRIYA = { name: 'Priya', email: 'priya@northwind.example' };
const DANA = { name: 'Dana', email: 'dana@acme.example' };

const inbound = (over = {}) => ({
  direction: 'in', from: PRIYA, to: [ALEX], cc: [], body: '', sentAt: '2026-11-20T10:00:00Z', automated: 0, isMeeting: false, importance: 'normal', ...over,
});
const outbound = (over = {}) => ({
  direction: 'out', from: ALEX, to: [PRIYA], cc: [], body: '', sentAt: '2026-11-20T10:00:00Z', automated: 0, isMeeting: false, importance: 'normal', ...over,
});

test('stripQuoted removes Gmail, Outlook and ">" quoting', () => {
  assert.equal(stripQuoted('Sounds good.\n\nOn Mon, Nov 2, 2026 at 3:04 PM Jane Doe <jane@x.com> wrote:\n> Can you come?'), 'Sounds good.');
  assert.equal(stripQuoted('Yes.\n\nOn Mon, Nov 2, 2026 at 3:04 PM Jane Doe <jane@x.com>\nwrote:\n> Can you come?'), 'Yes.');
  assert.equal(stripQuoted('Will do.\n\nFrom: Jane Doe\nSent: Monday, November 2, 2026 3:04 PM\nTo: Alex\nSubject: x\n\nCan you come?'), 'Will do.');
  assert.equal(stripQuoted('Agreed\n\n-----Original Message-----\nold stuff?'), 'Agreed');
  assert.equal(stripQuoted('Line one\n> quoted?\nLine two'), 'Line one\nLine two');
  assert.equal(stripQuoted('Thanks\n-- \nAlex Morgan\nCan you call me?'), 'Thanks');
});

test('stripQuoted keeps a message that is only a forward', () => {
  const forward = '---------- Forwarded message ----------\nFrom: someone\nCan you handle this?';
  assert.equal(stripQuoted(forward), forward);
});

test('a question in quoted text does not count as a question', () => {
  const sig = askSignals(stripQuoted('Thanks!\n\nOn Tue, Alex wrote:\n> Can you send the file?'));
  assert.equal(sig.question, false);
  assert.equal(sig.ackOnly, true);
});

test('askSignals', () => {
  assert.deepEqual(askSignals('Can you confirm the numbers by Friday?'), { question: true, request: true, urgent: true, ackOnly: false });
  assert.equal(askSignals('See https://example.com/page?id=4 for details.').question, false, 'a URL query string is not a question');
  assert.equal(askSignals('Got it, thanks!').ackOnly, true);
  assert.equal(askSignals('Thanks! Could you also send the invoice?').ackOnly, false);
  assert.equal(askSignals('Here is the report you asked for.').request, false);
});

test('normalizeSubject strips reply prefixes in several languages', () => {
  assert.equal(normalizeSubject('RE: Fwd: AW:  Budget  Q4'), 'budget q4');
  assert.equal(normalizeSubject('Re[2]: Budget Q4'), 'budget q4');
});

test('automatedLevel', () => {
  assert.equal(automatedLevel({ from: { email: 'no-reply@shop.example' }, body: 'Your order shipped' }), 2);
  assert.equal(automatedLevel({ from: { email: 'jane@corp.example' }, body: 'hi', headers: { listUnsubscribe: true } }), 2);
  assert.equal(automatedLevel({ from: { email: 'jane@corp.example' }, body: 'Deals!\nUnsubscribe here' }), 2);
  assert.equal(automatedLevel({ from: { email: 'support@corp.example' }, body: 'How can we help?' }), 1);
  assert.equal(automatedLevel({ from: { email: 'jane@corp.example' }, body: 'hi', focused: false }), 1);
  assert.equal(automatedLevel({ from: { email: 'jane@corp.example' }, body: 'Can we talk tomorrow?' }), 0);
});

test('isMeetingMessage', () => {
  assert.equal(isMeetingMessage({ subject: 'Accepted: Design review' }), true);
  assert.equal(isMeetingMessage({ subject: 'Design review notes', isMeetingMessage: true }), true);
  assert.equal(isMeetingMessage({ subject: 'Accepted the offer!' }), false);
});

test('a direct question to the user needs a reply', () => {
  const v = evaluateThread([inbound({ body: 'Hi Alex, can you confirm the 40-seat plan?' })], { me });
  assert.equal(v.state, 'needs_reply');
  assert.equal(v.candidate, true);
  assert.equal(v.counterpart.email, 'priya@northwind.example');
  assert.ok(v.reasons.includes('asks a question'));
});

test('only an explicit deadline or importance flag makes a thread high priority by rule', () => {
  assert.equal(evaluateThread([inbound({ body: 'Can you confirm?' })], { me }).priority, 'medium');
  assert.equal(evaluateThread([inbound({ body: 'Can you confirm by Friday?' })], { me }).priority, 'high');
  assert.equal(evaluateThread([inbound({ body: 'Can you confirm?', importance: 'high' })], { me }).priority, 'high');
});

test('automated mail, meeting responses and thank-yous need nothing', () => {
  assert.equal(evaluateThread([inbound({ body: 'Can you review?', automated: 2 })], { me }).state, 'none');
  assert.equal(evaluateThread([inbound({ body: 'Can you review?', automated: 2 })], { me }).candidate, false);
  assert.equal(evaluateThread([inbound({ body: '', isMeeting: true })], { me }).state, 'none');
  assert.equal(evaluateThread([outbound({ body: 'Here it is.' }), inbound({ body: 'Got it, thanks!' })], { me }).state, 'none');
});

test("being only cc'd on a statement is not a reply request", () => {
  const v = evaluateThread([inbound({ to: [DANA], cc: [ALEX], body: 'Dana, attached is the comparison.' })], { me });
  assert.equal(v.state, 'none');
  assert.ok(v.reasons.includes("you're only cc'd"));
});

test('the user asking a question is waiting on a reply', () => {
  const v = evaluateThread([outbound({ body: 'Could you let me know whether the budget works?' })], { me });
  assert.equal(v.state, 'awaiting_reply');
  assert.equal(v.counterpart.email, 'priya@northwind.example');
});

test('the user saying thanks, or writing to a no-reply address, is not waiting', () => {
  assert.equal(evaluateThread([inbound({ body: 'Here you go.' }), outbound({ body: 'Thanks, Priya!' })], { me }).state, 'none');
  assert.equal(evaluateThread([outbound({ to: [{ email: 'no-reply@shop.example' }], body: 'Can you cancel my order?' })], { me }).state, 'none');
});

test('isOverdue', () => {
  const now = new Date('2026-11-22T12:00:00Z');
  assert.equal(isOverdue('2026-11-19T11:00:00Z', 3, now), true);
  assert.equal(isOverdue('2026-11-20T11:00:00Z', 3, now), false);
  assert.equal(isOverdue(null, 3, now), false);
});

test('assignThreadKeys groups by reference headers', () => {
  const msgs = [
    { providerId: '1', messageIdHeader: '<a@x>', subject: 'Plan' },
    { providerId: '2', messageIdHeader: '<b@x>', inReplyTo: '<a@x>', references: ['<a@x>'], subject: 'Re: Plan' },
    { providerId: '3', messageIdHeader: '<c@x>', references: ['<a@x>', '<b@x>'], subject: 'Re: Plan' },
    { providerId: '4', messageIdHeader: '<d@x>', subject: 'Something else' },
  ];
  assignThreadKeys(msgs);
  assert.equal(msgs[0].threadKey, msgs[1].threadKey);
  assert.equal(msgs[1].threadKey, msgs[2].threadKey);
  assert.notEqual(msgs[3].threadKey, msgs[0].threadKey);
});

test('assignThreadKeys falls back to the subject for replies with no headers', () => {
  const msgs = [
    { providerId: '1', messageIdHeader: '<a@x>', subject: 'Offsite planning' },
    { providerId: '2', messageIdHeader: '<b@x>', subject: 'RE: Offsite planning' },
    { providerId: '3', messageIdHeader: '<c@x>', subject: 'Offsite planning' }, // a new, unrelated mail with the same subject
  ];
  assignThreadKeys(msgs);
  assert.equal(msgs[0].threadKey, msgs[1].threadKey);
  assert.notEqual(msgs[2].threadKey, msgs[0].threadKey);
});

test('assignThreadKeys keeps the key of a thread stored earlier, and leaves provider keys alone', () => {
  const known = new Map([['<a@x>', 't:stored-key']]);
  const msgs = [
    { providerId: '9', messageIdHeader: '<z@x>', inReplyTo: '<a@x>', subject: 'Re: Plan' },
    { providerId: '10', threadKey: 'c:native', messageIdHeader: '<y@x>', inReplyTo: '<a@x>' },
  ];
  assignThreadKeys(msgs, known);
  assert.equal(msgs[0].threadKey, 't:stored-key');
  assert.equal(msgs[1].threadKey, 'c:native');
});
