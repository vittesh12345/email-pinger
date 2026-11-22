import assert from 'node:assert/strict';
import { test } from 'node:test';
import { htmlToText, findMeetingLink } from '../src/core/text.js';
import { docxToText, parseCues, parseTranscriptFile, readZipEntry } from '../src/core/transcripts.js';
import { makeZip } from './helpers.js';

test('Teams-style WebVTT: voice tags, cues merged per speaker', () => {
  const vtt = `WEBVTT

00:00:01.000 --> 00:00:04.000
<v Marcus Lee>Okay, let's get started.</v>

00:00:04.500 --> 00:00:07.000
<v Marcus Lee>Main topic is onboarding.</v>

00:01:10.000 --> 00:01:14.000
<v Jordan Kim>Design is basically done.</v>`;
  assert.equal(
    parseCues(vtt),
    "[00:01] Marcus Lee: Okay, let's get started. Main topic is onboarding.\n[01:10] Jordan Kim: Design is basically done.",
  );
});

test('Zoom-style WebVTT: numbered cues with "Name: text"', () => {
  const vtt = `WEBVTT\r\n\r\n1\r\n00:00:02.000 --> 00:00:05.000\r\nDana Whitfield: I'll chase legal.\r\n\r\n2\r\n01:02:03.000 --> 01:02:05.000\r\nAlex Morgan: Thanks.`;
  assert.equal(parseCues(vtt), "[00:02] Dana Whitfield: I'll chase legal.\n[1:02:03] Alex Morgan: Thanks.");
});

test('SRT with no speakers', () => {
  const srt = `1\n00:00:01,000 --> 00:00:03,000\nHello everyone.\n\n2\n00:00:03,500 --> 00:00:06,000\nLet's begin.`;
  const { text, format } = parseTranscriptFile('meeting.srt', Buffer.from(srt));
  assert.equal(format, 'srt');
  assert.equal(text, "[00:01] Hello everyone. Let's begin.");
});

test('a sentence containing a colon is not mistaken for a speaker', () => {
  const vtt = `WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHere is the plan for tomorrow, in three parts: first we ship.`;
  assert.equal(parseCues(vtt), '[00:01] Here is the plan for tomorrow, in three parts: first we ship.');
});

test('.docx transcripts: paragraphs, entities, tabs', () => {
  const xml = `<?xml version="1.0"?><w:document><w:body>
    <w:p><w:r><w:t>Marcus Lee</w:t></w:r><w:r><w:tab/><w:t xml:space="preserve"> 0:01</w:t></w:r></w:p>
    <w:p><w:r><w:t>Q&amp;A is next &#8212; any </w:t></w:r><w:r><w:t>questions?</w:t></w:r></w:p>
    <w:p></w:p>
  </w:body></w:document>`;
  for (const compress of [true, false]) {
    const docx = makeZip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': xml }, { compress });
    assert.equal(docxToText(docx), 'Marcus Lee\t 0:01\nQ&A is next — any questions?');
    assert.equal(parseTranscriptFile('Transcript.DOCX', docx).format, 'docx');
  }
});

test('broken or unsupported uploads fail with a clear message', () => {
  assert.throws(() => docxToText(Buffer.from('not a zip at all, just some text padding padding')), /not a valid \.docx/);
  assert.throws(() => docxToText(makeZip({ 'other.xml': '<x/>' })), /no readable document/);
  assert.throws(() => parseTranscriptFile('call.mp3', Buffer.from('x')), /can't read \.mp3/);
  assert.throws(() => parseTranscriptFile('notes.txt', Buffer.from([0x61, 0x00, 0x62, 0x00])), /does not look like text/);
  assert.equal(readZipEntry(makeZip({ 'a.txt': 'hi' }), 'missing.txt'), null);
});

test('plain text, with a byte-order mark or in UTF-16', () => {
  assert.equal(parseTranscriptFile('notes.txt', Buffer.from('﻿Hello\r\nworld')).text, 'Hello\nworld');
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Héllo', 'utf16le')]);
  assert.equal(parseTranscriptFile('notes.txt', utf16).text, 'Héllo');
});

test('htmlToText', () => {
  const html = '<html><head><style>p{color:red}</style></head><body><p>Hi&nbsp;Alex,</p><p>Can you <b>confirm</b> &amp; reply?<br>Thanks &#8212; P</p><script>alert(1)</script></body></html>';
  assert.equal(htmlToText(html), 'Hi Alex,\nCan you confirm & reply?\nThanks — P');
});

test('findMeetingLink', () => {
  assert.equal(findMeetingLink('Room 4', 'Join: https://teams.microsoft.com/l/meetup-join/abc123 now'), 'https://teams.microsoft.com/l/meetup-join/abc123');
  assert.equal(findMeetingLink('https://acme.zoom.us/j/987654'), 'https://acme.zoom.us/j/987654');
  assert.equal(findMeetingLink('https://example.com/agenda'), null);
});
