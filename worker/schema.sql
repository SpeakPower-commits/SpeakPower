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
  -- Free tries, shared across every service: 3 in total, granted once.
  trials_remaining INTEGER NOT NULL DEFAULT 3,
  -- Prepaid balance in Uganda shillings, like airtime. Top-ups add to it;
  -- each paid use deducts that service's price. Never negative.
  balance          INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
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

-- Every use of a service, Studio and GRIOT alike. paid_with = 'trial' or
-- 'balance'; amount = shillings deducted (0 for a free try). status = 'ok' or
-- 'refunded' (it failed and exactly what was taken was given back).
CREATE TABLE IF NOT EXISTS runs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  product    TEXT NOT NULL,
  paid_with  TEXT NOT NULL,
  amount     INTEGER NOT NULL DEFAULT 0,
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

-- Balance top-ups. A row is written when checkout starts, so a payment is
-- credited from OUR record of what was asked — never from an amount or account
-- id in the payment notification, which an attacker can shape.
-- provider: 'flutterwave' now; 'bank' slots in later without a schema change.
-- provider_ref: the provider's own transaction id, unique, so one real payment
-- can never be counted twice. status: 'pending' → 'paid' exactly once, or
-- 'failed' when checkout could not be opened.
CREATE TABLE IF NOT EXISTS payments (
  tx_ref       TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  amount       INTEGER NOT NULL CHECK (amount > 0),
  currency     TEXT NOT NULL,
  provider     TEXT NOT NULL DEFAULT 'flutterwave',
  status       TEXT NOT NULL DEFAULT 'pending',
  provider_ref TEXT UNIQUE,
  created_at   INTEGER NOT NULL,
  paid_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_payments_user ON payments (user_id, created_at);

-- The Rehearsal Room: one row per scored recording. The audio itself is never
-- stored, nor is the transcript; only what the customer needs to see their
-- progress. "Delete my rehearsals" removes every row for the account.
CREATE TABLE IF NOT EXISTS rehearsals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT NOT NULL,
  run_id        INTEGER,
  moment        TEXT NOT NULL,
  seconds       INTEGER NOT NULL,
  words         INTEGER NOT NULL,
  wpm           INTEGER NOT NULL,
  fillers_pm    REAL NOT NULL,
  pauses_pm     REAL NOT NULL,
  score         INTEGER NOT NULL,
  -- 'speak' with written coaching, 'delivery' for scores only.
  kind          TEXT NOT NULL,
  feedback_json TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rehearsals_user ON rehearsals (user_id, id);
