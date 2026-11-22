import { DatabaseSync } from 'node:sqlite';

let handle = null;

const MIGRATIONS = [
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE accounts (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,                    -- outlook | imap | demo
    email TEXT NOT NULL,
    name TEXT,
    config TEXT NOT NULL DEFAULT '{}',     -- provider secrets (tokens / password); never sent to the UI
    status TEXT NOT NULL DEFAULT 'ok',     -- ok | error | needs_auth
    status_detail TEXT,
    last_sync_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    provider_id TEXT NOT NULL,
    thread_key TEXT NOT NULL,
    direction TEXT NOT NULL,               -- in | out
    from_name TEXT,
    from_email TEXT,
    to_json TEXT NOT NULL DEFAULT '[]',
    cc_json TEXT NOT NULL DEFAULT '[]',
    subject TEXT,
    body TEXT,
    sent_at TEXT NOT NULL,
    is_read INTEGER NOT NULL DEFAULT 1,
    automated INTEGER NOT NULL DEFAULT 0,  -- 0 person, 1 probably automated, 2 automated
    is_meeting INTEGER NOT NULL DEFAULT 0, -- calendar invite / response
    importance TEXT,
    web_link TEXT,
    message_id_header TEXT,
    UNIQUE(account_id, provider_id)
  );
  CREATE INDEX idx_messages_thread ON messages(account_id, thread_key, sent_at);

  CREATE TABLE threads (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    thread_key TEXT NOT NULL,
    subject TEXT,
    last_message_id INTEGER,
    last_at TEXT,
    last_direction TEXT,
    message_count INTEGER NOT NULL DEFAULT 1,
    state TEXT NOT NULL DEFAULT 'none',    -- needs_reply | awaiting_reply | none
    state_source TEXT NOT NULL DEFAULT 'rules', -- rules | ai
    candidate INTEGER NOT NULL DEFAULT 0,  -- worth a closer (AI) look
    score INTEGER NOT NULL DEFAULT 0,
    priority TEXT NOT NULL DEFAULT 'low',  -- high | medium | low
    reasons TEXT NOT NULL DEFAULT '[]',
    counterpart_name TEXT,
    counterpart_email TEXT,
    waiting_since TEXT,
    ai_message_id INTEGER,                 -- the last_message_id the AI fields describe
    ai_summary TEXT,
    ai_ask TEXT,
    ai_next_step TEXT,
    ai_due TEXT,
    user_status TEXT NOT NULL DEFAULT 'open', -- open | done | dismissed | snoozed
    snooze_until TEXT,
    pinged_message_id INTEGER,
    UNIQUE(account_id, thread_key)
  );
  CREATE INDEX idx_threads_state ON threads(state, user_status);

  CREATE TABLE meetings (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    event_id INTEGER,
    attendees TEXT NOT NULL DEFAULT '[]',
    source TEXT NOT NULL,                  -- live | upload | paste
    status TEXT NOT NULL DEFAULT 'ready',  -- live | ready
    transcript TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    summary TEXT,
    analysis TEXT,
    analysis_status TEXT NOT NULL DEFAULT 'none', -- none | pending | done | error
    analysis_error TEXT,
    created_at TEXT NOT NULL
  );
  CREATE VIRTUAL TABLE meetings_fts USING fts5(title, summary, body, tokenize = 'porter unicode61');

  CREATE TABLE followups (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL,                  -- meeting | manual
    meeting_id INTEGER REFERENCES meetings(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'todo',     -- todo (yours to do) | waiting (someone owes you)
    title TEXT NOT NULL,
    detail TEXT,
    person TEXT,
    due_on TEXT,                           -- YYYY-MM-DD (local) or null
    status TEXT NOT NULL DEFAULT 'open',   -- open | done | dismissed
    snooze_until TEXT,
    last_pinged_at TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT
  );
  CREATE INDEX idx_followups_status ON followups(status, due_on);

  CREATE TABLE calendar_events (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL,                  -- account:<id> | ics:<n>
    provider_id TEXT NOT NULL,
    title TEXT,
    start_at TEXT NOT NULL,
    end_at TEXT,
    attendees TEXT NOT NULL DEFAULT '[]',
    join_url TEXT,
    location TEXT,
    is_all_day INTEGER NOT NULL DEFAULT 0,
    is_cancelled INTEGER NOT NULL DEFAULT 0,
    declined INTEGER NOT NULL DEFAULT 0,
    prompt_state TEXT,                     -- null | prompted | accepted | skipped
    UNIQUE(source, provider_id)
  );
  CREATE INDEX idx_events_start ON calendar_events(start_at);

  CREATE TABLE digests (
    id INTEGER PRIMARY KEY,
    created_at TEXT NOT NULL,
    slot TEXT,                             -- "YYYY-MM-DD HH:MM" for scheduled overviews
    trigger TEXT NOT NULL,                 -- scheduled | manual
    payload TEXT NOT NULL
  );
  CREATE UNIQUE INDEX idx_digests_slot ON digests(slot) WHERE slot IS NOT NULL;

  CREATE TABLE pings (
    id INTEGER PRIMARY KEY,
    created_at TEXT NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    url TEXT,
    data TEXT
  );
  `,
  `
  -- What the browser extension has read from Outlook on the web, as normalized messages.
  CREATE TABLE web_items (
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    provider_id TEXT NOT NULL,
    data TEXT NOT NULL,
    seen_at TEXT NOT NULL,
    PRIMARY KEY (account_id, provider_id)
  );
  `,
  `
  -- A reply Pinger drafted ahead of time (auto-draft), tied to the message it answers.
  ALTER TABLE threads ADD COLUMN draft_text TEXT;
  ALTER TABLE threads ADD COLUMN draft_for_message_id INTEGER;
  `,
];

export function initDb(file) {
  closeDb();
  handle = new DatabaseSync(file);
  handle.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 4000;');
  let version = handle.prepare('PRAGMA user_version').get().user_version;
  for (; version < MIGRATIONS.length; version++) {
    handle.exec('BEGIN');
    try {
      handle.exec(MIGRATIONS[version]);
      handle.exec(`PRAGMA user_version = ${version + 1}`);
      handle.exec('COMMIT');
    } catch (err) {
      handle.exec('ROLLBACK');
      throw err;
    }
  }
  return handle;
}

export function closeDb() {
  if (handle) {
    try {
      handle.close();
    } catch {
      /* already closed */
    }
    handle = null;
  }
}

// node:sqlite rejects undefined and booleans as bound values.
const bind = (params) =>
  params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));

export const get = (sql, ...params) => handle.prepare(sql).get(...bind(params));
export const all = (sql, ...params) => handle.prepare(sql).all(...bind(params));
export const run = (sql, ...params) => handle.prepare(sql).run(...bind(params));

let depth = 0;
export function tx(fn) {
  if (depth > 0) return fn();
  handle.exec('BEGIN');
  depth++;
  try {
    const result = fn();
    handle.exec('COMMIT');
    return result;
  } catch (err) {
    handle.exec('ROLLBACK');
    throw err;
  } finally {
    depth--;
  }
}
