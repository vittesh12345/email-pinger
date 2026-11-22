// Turn whatever a meeting tool exports (.vtt, .srt, .docx, .txt, .md) into plain transcript text.

import zlib from 'node:zlib';
import { HttpError } from '../util.js';

const MAX_UNZIPPED = 40 * 1024 * 1024;

function decodeText(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder('utf-16le').decode(buffer.subarray(2));
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) return new TextDecoder('utf-16be').decode(buffer.subarray(2));
  return new TextDecoder('utf-8').decode(buffer).replace(/^﻿/, '');
}

const TIME = /(\d{1,2}):(\d{2}):(\d{2})[.,]\d{1,3}|(\d{1,2}):(\d{2})[.,]\d{1,3}/;

function stamp(timeText) {
  const m = TIME.exec(timeText);
  if (!m) return '';
  const h = Number(m[1] || 0);
  const min = Number(m[2] ?? m[4]);
  const s = Number(m[3] ?? m[5]);
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(min)}:${pad(s)}` : `${pad(min)}:${pad(s)}`;
}

const SPEAKER_PREFIX = /^([\p{L}][\p{L}\p{M}'’.\- ]{0,40}?)\s*:\s+(.+)$/u;

/** WebVTT and SRT share a shape: blocks of [id], "start --> end", text lines. */
export function parseCues(text) {
  const blocks = text.replace(/\r\n?/g, '\n').split(/\n{2,}/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    const timing = lines.findIndex((l) => l.includes('-->'));
    if (timing === -1) continue;
    let speaker = '';
    const parts = [];
    for (const raw of lines.slice(timing + 1)) {
      let line = raw;
      const voice = /<v(?:\.[^\s>]*)?\s+([^>]+)>/i.exec(line);
      if (voice) speaker = voice[1].trim();
      line = line.replace(/<[^>]+>/g, '').trim();
      if (!voice && !speaker && !parts.length) {
        const named = SPEAKER_PREFIX.exec(line);
        if (named) {
          speaker = named[1].trim();
          line = named[2];
        }
      }
      if (line) parts.push(line);
    }
    if (parts.length) cues.push({ at: stamp(lines[timing]), speaker, text: parts.join(' ') });
  }
  // Merge consecutive cues from the same speaker into one readable turn.
  const turns = [];
  for (const cue of cues) {
    const last = turns.at(-1);
    if (last && last.speaker === cue.speaker) last.text += ` ${cue.text}`;
    else turns.push({ ...cue });
  }
  return turns.map((t) => `${t.at ? `[${t.at}] ` : ''}${t.speaker ? `${t.speaker}: ` : ''}${t.text}`).join('\n');
}

/** Read one file out of a zip archive (a .docx is a zip). */
export function readZipEntry(buffer, wanted) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 65535); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new HttpError(400, 'That file is not a valid .docx document.');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (name === wanted) {
      if (buffer.readUInt32LE(localOffset) !== 0x04034b50) break;
      const start = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
      const data = buffer.subarray(start, start + compressedSize);
      if (method === 0) return data;
      if (method === 8) return zlib.inflateRawSync(data, { maxOutputLength: MAX_UNZIPPED });
      throw new HttpError(400, 'That .docx uses a compression method Pinger cannot read.');
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decodeXml = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
    const key = name.toLowerCase();
    if (XML_ENTITIES[key]) return XML_ENTITIES[key];
    const code = key.startsWith('#x') ? parseInt(key.slice(2), 16) : key.startsWith('#') ? parseInt(key.slice(1), 10) : NaN;
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });

export function docxToText(buffer) {
  const xml = readZipEntry(buffer, 'word/document.xml');
  if (!xml) throw new HttpError(400, 'That .docx has no readable document inside.');
  const paragraphs = xml
    .toString('utf8')
    .split(/<\/w:p>/)
    .map((p) => {
      const pieces = [];
      const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>|<w:cr\s*\/>/g;
      let m;
      while ((m = re.exec(p))) pieces.push(m[1] !== undefined ? decodeXml(m[1]) : m[0].startsWith('<w:tab') ? '\t' : '\n');
      return pieces.join('').trim();
    })
    .filter(Boolean);
  return paragraphs.join('\n');
}

/**
 * @param {string} filename
 * @param {Buffer} buffer
 * @returns {{text: string, format: string}}
 */
export function parseTranscriptFile(filename, buffer) {
  const ext = (/\.([a-z0-9]+)$/i.exec(filename || '')?.[1] || '').toLowerCase();
  if (ext === 'docx') return { text: docxToText(buffer), format: 'docx' };
  if (['doc', 'pdf', 'mp3', 'mp4', 'm4a', 'wav', 'webm'].includes(ext)) {
    throw new HttpError(400, `Pinger can't read .${ext} files. Export the transcript as .vtt, .docx or .txt instead.`);
  }
  const text = decodeText(buffer);
  if (text.includes('\u0000')) throw new HttpError(400, 'That file does not look like text.');
  if (ext === 'vtt' || ext === 'srt' || /^WEBVTT/.test(text) || /^\d+\s*\n\d{1,2}:\d{2}:\d{2}[.,]\d{3}\s+-->/m.test(text)) {
    const parsed = parseCues(text);
    if (parsed) return { text: parsed, format: ext === 'srt' ? 'srt' : 'vtt' };
  }
  return { text: text.replace(/\r\n?/g, '\n').trim(), format: 'text' };
}
