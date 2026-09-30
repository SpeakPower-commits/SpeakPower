-- Cache for the Website SEO & Visibility Audit.
--
-- Two reasons this exists, both commercial:
--   1. Google's PageSpeed Insights quota is finite even with an API key. A
--      repeat audit of the same address inside the TTL costs nothing.
--   2. A cached audit returns in milliseconds instead of ~30 seconds, which is
--      the difference between a customer waiting and a customer leaving.
--
-- Rows are disposable. Expired rows are ignored by the read query and
-- overwritten by the next audit of the same URL, so no cleanup job is
-- required at this volume.

CREATE TABLE IF NOT EXISTS studio_pagespeed_cache (
  target_url TEXT PRIMARY KEY,
  sections   TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_studio_pagespeed_cache_expires
  ON studio_pagespeed_cache (expires_at);
