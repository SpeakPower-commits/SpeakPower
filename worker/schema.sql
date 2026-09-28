-- SpeakPower Studio API — Cloudflare D1 schema
--
-- Paste this whole file into the D1 console (Cloudflare dashboard →
-- Storage & Databases → D1 → your database → Console) and run it once.
-- Every statement is idempotent, so running it again is safe.

-- Accounts. One row per verified-or-pending email address.
-- email_canonical is the uniqueness key: lower-cased, and for Gmail addresses
-- dots and "+tags" are stripped, so one inbox cannot farm extra free trials.
CREATE TABLE IF NOT EXISTS users (
  id               TEXT PRIMARY KEY,
  email            TEXT NOT NULL,
  email_canonical  TEXT NOT NULL UNIQUE,
  name             TEXT,
  verified         INTEGER NOT NULL DEFAULT 0,
  trials_remaining INTEGER NOT NULL DEFAULT 3,
  -- Paid runs. Your Flutterwave webhook adds to this column; the API spends
  -- free trials first, then credits.
  credits          INTEGER NOT NULL DEFAULT 0,
  plan             TEXT NOT NULL DEFAULT 'trial',
  -- Bump this to sign a user out of every device (invalidates old tokens).
  session_version  INTEGER NOT NULL DEFAULT 1,
  created_at       INTEGER NOT NULL,
  verified_at      INTEGER,
  last_seen_at     INTEGER
);

-- One pending sign-in code per email. Only a salted hash of the code is kept.
CREATE TABLE IF NOT EXISTS otp_codes (
  email_canonical TEXT PRIMARY KEY,
  code_hash       TEXT NOT NULL,
  expires_at      INTEGER NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);

-- Every metered Studio run. status = 'ok' or 'refunded' (the run failed and
-- the trial/credit was given back).
CREATE TABLE IF NOT EXISTS runs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  product    TEXT NOT NULL,
  paid_with  TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'ok',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_user ON runs (user_id, created_at);

-- Contact-form enquiries (replaces the old mailto: hand-off).
CREATE TABLE IF NOT EXISTS leads (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  organization TEXT,
  email        TEXT NOT NULL,
  service      TEXT,
  message      TEXT NOT NULL,
  page         TEXT,
  status       TEXT NOT NULL DEFAULT 'new',
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leads_created ON leads (created_at);

-- First-party funnel events. No names, emails or document text are stored:
-- only the event name, the page, an optional product key, a random
-- per-browser id and (when signed in) the user id.
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  page       TEXT,
  product    TEXT,
  anon_id    TEXT,
  user_id    TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_name ON events (name, created_at);
CREATE INDEX IF NOT EXISTS idx_events_anon ON events (anon_id);

-- Sliding-window rate limiting. Old rows are pruned by the scheduled handler.
CREATE TABLE IF NOT EXISTS rate_log (
  key        TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_key ON rate_log (key, created_at);
