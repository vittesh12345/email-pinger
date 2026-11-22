import { all, get, run, tx } from './db.js';
import { normalizeName } from './core/triage.js';
import { lower, nowIso, parseJson } from './util.js';

const shape = (row) => (row ? { ...row, config: parseJson(row.config, {}) } : null);

export const listAccounts = () => all('SELECT * FROM accounts ORDER BY id').map(shape);
export const getAccount = (id) => shape(get('SELECT * FROM accounts WHERE id = ?', id));

export function createAccount({ kind, email, name, config }) {
  const existing = get('SELECT id FROM accounts WHERE kind = ? AND lower(email) = ?', kind, lower(email));
  if (existing) {
    // Reconnecting the same mailbox refreshes its credentials rather than duplicating it.
    run(
      "UPDATE accounts SET config = ?, name = COALESCE(?, name), status = 'ok', status_detail = NULL WHERE id = ?",
      JSON.stringify(config || {}),
      name || null,
      existing.id,
    );
    return getAccount(existing.id);
  }
  const { lastInsertRowid } = run(
    'INSERT INTO accounts (kind, email, name, config, created_at) VALUES (?, ?, ?, ?, ?)',
    kind,
    email,
    name || null,
    JSON.stringify(config || {}),
    nowIso(),
  );
  return getAccount(Number(lastInsertRowid));
}

export function saveAccountConfig(id, config) {
  run('UPDATE accounts SET config = ? WHERE id = ?', JSON.stringify(config), id);
}

export function setAccountStatus(id, status, detail = null) {
  run('UPDATE accounts SET status = ?, status_detail = ? WHERE id = ?', status, detail, id);
}

export function deleteAccount(id) {
  tx(() => {
    run('DELETE FROM calendar_events WHERE source = ?', `account:${id}`);
    run('DELETE FROM accounts WHERE id = ?', id); // messages + threads cascade
  });
}

/** What the UI may know about an account. Credentials never leave the server. */
export function publicAccount(a) {
  return {
    id: a.id,
    kind: a.kind,
    email: a.email,
    name: a.name,
    status: a.status,
    statusDetail: a.status_detail,
    lastSyncAt: a.last_sync_at,
    hasCalendar: a.kind === 'outlook' || a.kind === 'outlook_desktop' || a.kind === 'demo',
    config: a.kind === 'outlook_web' ? { firstSeenAt: a.config?.firstSeenAt || null } : undefined,
  };
}

/** Every address that counts as "me" for this account. */
export function ownAddresses(account, settings) {
  return new Set([account.email, ...(account.config?.aliases || []), ...(settings.profile.emails || [])].map(lower).filter(Boolean));
}

/** Display names that count as "me", for sources that show names without addresses. */
export function ownNames(account, settings) {
  return new Set([account.name, settings.profile.name].map(normalizeName).filter(Boolean));
}
