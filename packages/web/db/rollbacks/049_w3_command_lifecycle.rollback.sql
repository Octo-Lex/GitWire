-- 049_w3_command_lifecycle.rollback.sql
--
-- !! CI/PROOF ROLLBACK ARTIFACT ONLY. !!
-- !! DO NOT EXECUTE AGAINST A POPULATED PRODUCTION ENVIRONMENT. !!
--
-- Removes ONLY objects introduced by 049_w3_command_lifecycle.sql, by name,
-- and RESTORES the exact pre-049 W3-01 trigger definition
-- (trg_mutation_commands_no_update on enforce_w3_mutation_command_append_only,
-- as shipped by 048 at master 15f9ec65). No CASCADE anywhere. The
-- schema_migrations row for 049 is deleted so the forward-only runner
-- re-applies the migration on its next run.

BEGIN;

-- Drop the transition guard and restore the exact 048 blanket trigger.
DROP TRIGGER IF EXISTS trg_mutation_commands_transition_guard ON public.mutation_commands;

CREATE TRIGGER trg_mutation_commands_no_update
  BEFORE UPDATE ON public.mutation_commands
  FOR EACH ROW EXECUTE FUNCTION enforce_w3_mutation_command_append_only();

-- Journal triggers and their functions.
DROP TRIGGER IF EXISTS trg_mutation_transitions_verify_committed ON public.mutation_command_transitions;
DROP TRIGGER IF EXISTS trg_mutation_transitions_no_truncate ON public.mutation_command_transitions;
DROP TRIGGER IF EXISTS trg_mutation_transitions_no_delete ON public.mutation_command_transitions;
DROP TRIGGER IF EXISTS trg_mutation_transitions_no_update ON public.mutation_command_transitions;
DROP TRIGGER IF EXISTS trg_mutation_transitions_validate_claim ON public.mutation_command_transitions;

DROP FUNCTION IF EXISTS w3_02_guard_command_transition();
DROP FUNCTION IF EXISTS w3_02_verify_claim_committed();
DROP FUNCTION IF EXISTS w3_02_validate_transition_claim();

-- W3-02 tables (transitions first: FK to mutation_commands).
DROP TABLE IF EXISTS public.mutation_command_transitions;
DROP TABLE IF EXISTS public.mutation_transition_legality;

-- W3-02 columns on the 048 table.
ALTER TABLE public.mutation_commands
  DROP COLUMN IF EXISTS version,
  DROP COLUMN IF EXISTS last_transition_at,
  DROP COLUMN IF EXISTS last_transitioned_by;

DELETE FROM schema_migrations WHERE version = '049_w3_command_lifecycle.sql';

COMMIT;
