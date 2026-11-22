// Reads the Outlook desktop app already signed in on a Windows PC, via a PowerShell script that
// drives Outlook's COM automation (see outlook-desktop.ps1). No Microsoft app registration and no
// IT approval: it uses the mailbox the user is already logged into, and only reads it.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findMeetingLink } from '../core/text.js';
import { lower, parseJson } from '../util.js';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'outlook-desktop.ps1');
const WINDOWS = process.platform === 'win32';

export class OutlookDesktopError extends Error {}

export const outlookDesktopAvailable = () => WINDOWS;

/** Run the PowerShell reader and return its parsed JSON object. */
function defaultRun({ what, since, from, to }) {
  return new Promise((resolve, reject) => {
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-What', what];
    if (since) args.push('-Since', since);
    if (from) args.push('-From', from);
    if (to) args.push('-To', to);
    let proc;
    try {
      proc = spawn('powershell.exe', args, { windowsHide: true });
    } catch (err) {
      return reject(new OutlookDesktopError(err.message));
    }
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('error', (e) =>
      reject(
        new OutlookDesktopError(
          e.code === 'ENOENT'
            ? 'Windows PowerShell was not found. Reading the Outlook desktop app is available on Windows only.'
            : e.message,
        ),
      ),
    );
    proc.on('close', (code) => {
      if (!out.trim()) {
        if (/running scripts is disabled|execution polic|cannot be loaded because/i.test(err)) {
          return reject(
            new OutlookDesktopError(
              "Your computer's settings don't allow Pinger's Outlook reader to run. On a work PC this is usually set by IT, so it needs their OK.",
            ),
          );
        }
        return reject(new OutlookDesktopError(err.trim() || `Reading Outlook failed (exit code ${code}).`));
      }
      const parsed = parseJson(out.trim(), null);
      if (!parsed) return reject(new OutlookDesktopError('Outlook returned a reply Pinger could not read.'));
      if (parsed.ok === false) return reject(new OutlookDesktopError(parsed.error || 'Outlook could not be read.'));
      resolve(parsed);
    });
  });
}

/**
 * @param {{run?: typeof defaultRun}} [deps]  tests inject `run`
 */
export function createOutlookDesktopProvider(account, { run = defaultRun } = {}) {
  if (!WINDOWS && run === defaultRun) {
    const unavailable = () => Promise.reject(new OutlookDesktopError('The Outlook desktop app can only be read on Windows.'));
    return { test: unavailable, fetchMessages: unavailable, fetchEvents: unavailable };
  }

  const person = (p) => ({ name: p?.name || '', email: lower(p?.email) });

  return {
    /** Confirm Outlook is reachable and return the signed-in mailbox. */
    async test() {
      const r = await run({ what: 'test' });
      if (!r.email) throw new OutlookDesktopError('Signed in, but Outlook did not report a mailbox address.');
      return { email: lower(r.email), name: r.name || '' };
    },

    async fetchMessages({ since }) {
      const r = await run({ what: 'messages', since: since.toISOString() });
      const messages = (r.messages || []).map((m) => ({
        providerId: m.providerId,
        threadKey: m.threadKey || undefined,
        messageIdHeader: m.messageIdHeader || null,
        from: person(m.from),
        to: (m.to || []).map(person),
        cc: (m.cc || []).map(person),
        subject: m.subject || '',
        body: m.body || '',
        sentAt: m.sentAt,
        isRead: m.isRead !== false,
        importance: m.importance === 'high' ? 'high' : 'normal',
        webLink: null,
        folderHint: m.folderHint === 'sent' ? 'sent' : 'inbox',
        isMeetingMessage: !!m.isMeetingMessage,
      }));
      return { messages, complete: r.complete !== false };
    },

    async fetchEvents({ from, to }) {
      const r = await run({ what: 'events', from: from.toISOString(), to: to.toISOString() });
      return (r.events || [])
        .filter((e) => e.startAt)
        .map((e) => ({
          providerId: e.providerId,
          title: e.title || '(no title)',
          startAt: e.startAt,
          endAt: e.endAt || null,
          attendees: (e.attendees || []).map(person).filter((p) => p.email || p.name),
          joinUrl: findMeetingLink(e.location, e.bodyForLink),
          location: e.location || null,
          isAllDay: !!e.isAllDay,
          isCancelled: !!e.isCancelled,
          declined: !!e.declined,
        }));
    },
  };
}
