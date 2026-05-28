-- 022_action_key_nullable.sql
-- The action state machine doesn't use action_key (it uses pillar + action_type + target instead).
-- Make action_key nullable so propose() INSERTs don't fail on NOT NULL constraint.

ALTER TABLE managed_actions ALTER COLUMN action_key DROP NOT NULL;
