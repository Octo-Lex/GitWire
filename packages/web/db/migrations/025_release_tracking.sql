-- 025_release_tracking.sql
-- Add release tracking columns to fix_attempts for the release event handler.

ALTER TABLE fix_attempts ADD COLUMN IF NOT EXISTS released_at TIMESTAMPTZ;
ALTER TABLE fix_attempts ADD COLUMN IF NOT EXISTS release_tag TEXT;
