import zlib from 'node:zlib';
import { createAccount } from '../src/accounts.js';
import { setClientFactory } from '../src/ai/client.js';
import { initDb } from '../src/db.js';
import { updateSettings } from '../src/settings.js';

process.env.PINGER_NO_NATIVE_NOTIFY = '1';
process.env.PINGER_NO_OPEN = '1';

export function freshDb() {
  initDb(':memory:');
}

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const ME = { name: 'Alex Morgan', email: 'alex@acme.example' };

export function makeAccount(kind = 'demo') {
  return createAccount({ kind, email: ME.email, name: ME.name, config: {} });
}

let seq = 0;
/** A normalized provider message with sensible defaults. `ago` is milliseconds before `now`. */
export function mail({ now = Date.now(), ago = HOUR, from, to = [ME], cc = [], thread, subject = 'Hello', body = '', ...rest }) {
  seq++;
  return {
    providerId: rest.providerId || `m${seq}`,
    threadKey: thread ? `t:${thread}` : `t:auto-${seq}`,
    from,
    to,
    cc,
    subject,
    body,
    sentAt: new Date(now - ago).toISOString(),
    isRead: true,
    importance: 'normal',
    webLink: null,
    folderHint: from?.email === ME.email ? 'sent' : 'inbox',
    ...rest,
  };
}

/** A provider that returns whatever `messages` currently holds. */
export function fakeProvider(messages, { complete = true } = {}) {
  return { fetchMessages: async () => ({ messages: messages.map((m) => ({ ...m })), complete }) };
}

/**
 * Stand-in for the Anthropic client. `respond(params)` returns the text (or object, which is
 * JSON-encoded) of the reply; every request is recorded in `calls`.
 */
export function fakeAi(respond, { stopReason = 'end_turn' } = {}) {
  const calls = [];
  updateSettings({ ai: { apiKey: 'sk-ant-test-0000000000000000' } });
  setClientFactory(() => ({
    beta: {
      messages: {
        stream: (params) => ({
          finalMessage: async () => {
            calls.push(params);
            const out = await respond(params);
            return {
              stop_reason: stopReason,
              content: [
                { type: 'thinking', thinking: '' },
                { type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out) },
              ],
            };
          },
        }),
      },
    },
  }));
  return calls;
}

/** Build a zip archive in memory (enough of the format for a .docx). */
export function makeZip(files, { compress = true } = {}) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const stored = compress ? zlib.deflateRawSync(data) : data;
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(compress ? 8 : 0, 8);
    local.writeUInt32LE(zlib.crc32(data), 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, stored);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(compress ? 8 : 0, 10);
    entry.writeUInt32LE(zlib.crc32(data), 16);
    entry.writeUInt32LE(stored.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuf);
    offset += 30 + nameBuf.length + stored.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}
