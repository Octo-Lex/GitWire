-- 048_w3_mutation_commands.rollback.sql
--
-- !! CI/PROOF ROLLBACK ARTIFACT ONLY. !!
-- !! DO NOT EXECUTE AGAINST A POPULATED PRODUCTION ENVIRONMENT. !!
--
-- This script exists solely to prove additive reversibility of W3-01 during
-- CI validation (forward migrate → proofs → this rollback → verify →
-- re-apply). It is NOT a supported production rollback procedure once later
-- Wave-3 units depend on these tables: dropping them destroys durable
-- mutation-intent records.
--
-- Removes ONLY objects introduced by 048_w3_mutation_commands.sql, by name,
-- in dependency order. No CASCADE is used anywhere. The schema_migrations
-- row for 048 is deleted so the forward runner re-applies the migration on
-- its next run.

BEGIN;

DROP TRIGGER IF EXISTS trg_mutation_outbox_no_update ON public.mutation_outbox;
DROP TRIGGER IF EXISTS trg_mutation_outbox_no_delete ON public.mutation_outbox;
DROP TRIGGER IF EXISTS trg_mutation_outbox_no_truncate ON public.mutation_outbox;

DROP TRIGGER IF EXISTS trg_mutation_commands_no_update ON public.mutation_commands;
DROP TRIGGER IF EXISTS trg_mutation_commands_no_delete ON public.mutation_commands;
DROP TRIGGER IF EXISTS trg_mutation_commands_no_truncate ON public.mutation_commands;

DROP FUNCTION IF EXISTS enforce_w3_mutation_command_append_only();

DROP INDEX IF EXISTS public.ix_mutation_outbox_type_seq;
DROP INDEX IF EXISTS public.ix_mutation_outbox_command;
DROP INDEX IF EXISTS public.ix_mutation_commands_evidence;
DROP INDEX IF EXISTS public.ix_mutation_commands_principal;
DROP INDEX IF EXISTS public.ix_mutation_commands_resource;

DROP TABLE IF EXISTS public.mutation_outbox;
DROP TABLE IF EXISTS public.mutation_commands;

DELETE FROM schema_migrations WHERE version = '048_w3_mutation_commands.sql';

COMMIT;
