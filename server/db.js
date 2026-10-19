'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  pid TEXT NOT NULL UNIQUE,                 -- public random id (never expose the integer id)
  email TEXT NOT NULL UNIQUE,
  email_hash TEXT NOT NULL,
  pw_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  dob TEXT NOT NULL,                        -- YYYY-MM-DD, used only for the 18+ check and an age band
  email_verified INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',    -- active | suspended
  onboarded INTEGER NOT NULL DEFAULT 0,
  bio TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  lat REAL, lng REAL,                       -- rounded to ~1 km before storing
  radius_km INTEGER NOT NULL DEFAULT 25,
  batch_json TEXT NOT NULL DEFAULT '[]',
  refreshes INTEGER NOT NULL DEFAULT 0,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS email_codes (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS user_tags (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, tag TEXT NOT NULL, PRIMARY KEY (user_id, tag));
CREATE TABLE IF NOT EXISTS user_favs (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, cat TEXT NOT NULL, text TEXT NOT NULL, norm TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS user_answers (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, qid TEXT NOT NULL, val REAL NOT NULL, PRIMARY KEY (user_id, qid));
CREATE TABLE IF NOT EXISTS tag_prefs (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, tag TEXT NOT NULL, w REAL NOT NULL, PRIMARY KEY (user_id, tag));
CREATE TABLE IF NOT EXISTS seen (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, other_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, at INTEGER NOT NULL, PRIMARY KEY (user_id, other_id));
CREATE TABLE IF NOT EXISTS waves (
  from_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | matched | passed
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (from_id, to_id)
);
CREATE TABLE IF NOT EXISTS chats (
  id INTEGER PRIMARY KEY,
  a_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,   -- a_id < b_id
  b_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  a_read INTEGER NOT NULL DEFAULT 0, b_read INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (a_id, b_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  flags TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, id);
CREATE TABLE IF NOT EXISTS blocks (blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at INTEGER NOT NULL, PRIMARY KEY (blocker_id, blocked_id));
CREATE TABLE IF NOT EXISTS vouches (from_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, to_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at INTEGER NOT NULL, PRIMARY KEY (from_id, to_id));
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY,
  reporter_id INTEGER, reported_id INTEGER,             -- no FK: reports outlive account deletion
  reported_pid TEXT NOT NULL, reported_email_hash TEXT NOT NULL,
  category TEXT NOT NULL, description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',                  -- open | upheld | dismissed
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_reported ON reports(reported_id, status);
CREATE TABLE IF NOT EXISTS email_blocklist (email_hash TEXT PRIMARY KEY, reason TEXT NOT NULL, created_at INTEGER NOT NULL);
`;

function openDb(file = process.env.PLM_DB || path.join(__dirname, '..', 'data', 'plm.sqlite')) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

/** Runs fn inside a transaction (re-entrant: nested calls join the outer transaction). */
function tx(db, fn) {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

module.exports = { openDb, tx };
