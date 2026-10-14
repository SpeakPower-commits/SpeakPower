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
  -- Prepaid balance in Uganda shillings for Studio packs. Top-ups add to it;
  -- each pack bought deducts its price. Never negative.
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
  -- 'topup' adds to the balance; 'plan:starter' or 'plan:pro' opens 30 days.
  -- Added 9 Oct 2026; on an older database run:
  --   ALTER TABLE payments ADD COLUMN purpose TEXT NOT NULL DEFAULT 'topup';
  purpose      TEXT NOT NULL DEFAULT 'topup',
  created_at   INTEGER NOT NULL,
  paid_at      INTEGER,
  -- The buyer's anonymous Google Analytics ids, sent by the page only when
  -- they accepted analytics; used once, to report the settled purchase.
  -- Added 14 Oct 2026; on an older database run:
  --   ALTER TABLE payments ADD COLUMN ga_client_id TEXT;
  --   ALTER TABLE payments ADD COLUMN ga_session_id TEXT;
  ga_client_id  TEXT,
  ga_session_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_payments_user ON payments (user_id, created_at);

-- Plans: one row per paid 30-day period. A renewal of the same plan starts
-- when the last one ends; switching plan ends the old one at once. Each row
-- keeps the limits it was bought with. Usage is counted here and shown to the
-- customer only as a share of the month, never as a number.
CREATE TABLE IF NOT EXISTS subscriptions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         TEXT NOT NULL,
  plan            TEXT NOT NULL,
  starts_at       INTEGER NOT NULL,
  ends_at         INTEGER NOT NULL,
  griot_limit     INTEGER NOT NULL,
  rehearsal_limit INTEGER NOT NULL,
  pack_limit      INTEGER NOT NULL DEFAULT 0,
  pack_discount   INTEGER NOT NULL DEFAULT 0,
  griot_used      INTEGER NOT NULL DEFAULT 0 CHECK (griot_used >= 0),
  rehearsal_used  INTEGER NOT NULL DEFAULT 0 CHECK (rehearsal_used >= 0),
  packs_used      INTEGER NOT NULL DEFAULT 0 CHECK (packs_used >= 0),
  tx_ref          TEXT NOT NULL UNIQUE,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions (user_id, ends_at);

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

-- Know the customer: one profile per account, filled in two short steps
-- after sign-in. Step 1 (who you are) is required before any service; step 2
-- (your challenge) before the first GRIOT question. GRIOT is briefed only
-- with the person's say-so (consent_griot), and never with their email or
-- WhatsApp number. The ids of the memories GRIOT was given are kept, so an
-- edit replaces them and "Delete my profile" removes them. A briefing GRIOT
-- could not take yet waits as 'pending' and is retried before the next
-- question and by the daily cron. A deleted profile keeps no personal field;
-- its row lingers only until GRIOT's copies are gone.
CREATE TABLE IF NOT EXISTS profiles (
  user_id          TEXT PRIMARY KEY,
  name             TEXT,
  -- What the person wants to be called ("Thomas" for "Otieno Thomas"); the
  -- site greets them with it. On an existing database:
  --   ALTER TABLE profiles ADD COLUMN call_me TEXT;
  call_me          TEXT,
  expertise        TEXT,
  position         TEXT,
  company          TEXT,
  sector           TEXT,
  location         TEXT,
  whatsapp         TEXT,
  consent_whatsapp INTEGER NOT NULL DEFAULT 0,
  problem          TEXT,
  goal             TEXT,
  goal_by          TEXT,
  why_now          TEXT,
  focus            TEXT NOT NULL DEFAULT '[]',
  consent_griot    INTEGER NOT NULL DEFAULT 0,
  -- 'none' (nothing with GRIOT), 'pending' (to send or remove), 'sent'.
  griot_state      TEXT NOT NULL DEFAULT 'none',
  griot_memory_ids TEXT NOT NULL DEFAULT '[]',
  griot_sent_at    INTEGER,
  griot_lock_until INTEGER,
  version          INTEGER NOT NULL DEFAULT 1,
  step1_at         INTEGER,
  step2_at         INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_profiles_griot_state ON profiles (griot_state);

-- Documents a client has given GRIOT. Each is read once: Workers AI turns it
-- into text, Claude writes a brief and the key facts with their pages, and
-- only those are kept. The file itself is never stored. Facts from switched-on
-- documents are chosen per question and sent to GRIOT, which cites them.
-- Plans hold 1 (free), 10 (Starter) or 50 (Pro); deleting one frees a place.
CREATE TABLE IF NOT EXISTS documents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  pages       INTEGER,
  enabled     INTEGER NOT NULL DEFAULT 1,
  brief       TEXT NOT NULL,
  facts       TEXT NOT NULL,
  truncated   INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_user ON documents (user_id, id);

-- Website audits. The audit reads a whole site in short stages (the free
-- Workers plan allows 10 ms of processing per call), so its progress and
-- findings live here between calls: the site's own files, a compact record of
-- each page read (no page is stored whole), the links and private-looking
-- addresses checked, Lighthouse, and the strategic read. Kept 90 days for the
-- client to reopen, then deleted by the daily run. `version` lets two calls
-- never read the same page twice; the *_started columns hold a running stage.
CREATE TABLE IF NOT EXISTS audits (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL,
  run_id             INTEGER,
  target             TEXT NOT NULL,
  prepared_for       TEXT NOT NULL DEFAULT '',
  state              TEXT NOT NULL,
  version            INTEGER NOT NULL DEFAULT 0,
  site               TEXT NOT NULL,
  pages              TEXT NOT NULL DEFAULT '[]',
  queue              TEXT NOT NULL DEFAULT '[]',
  links              TEXT NOT NULL DEFAULT '[]',
  private            TEXT NOT NULL DEFAULT '[]',
  lighthouse         TEXT,
  lighthouse_tries   INTEGER NOT NULL DEFAULT 0,
  lighthouse_started INTEGER NOT NULL DEFAULT 0,
  strategy           TEXT,
  strategy_tries     INTEGER NOT NULL DEFAULT 0,
  strategy_started   INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audits_user ON audits (user_id, created_at);
