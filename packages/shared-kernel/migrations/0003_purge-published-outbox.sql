-- Up Migration

-- Events stay in the outbox only until they're delivered, and a while after, in case
-- someone needs to look. Without this, the table grows forever. The audit log keeps every
-- event for good, and duplicate deliveries are refused by job ID, not by these rows.
--
-- The relay's role may only mark events as published, so it removes them through this
-- function, a batch at a time so no run holds locks for long. It returns how many it removed.
-- It runs as the owner, which row-level security otherwise keeps from seeing any event.
-- The policies below let the owner see and remove delivered events only while the function
-- runs: it turns kernel.purging on first and off again before it returns.
CREATE FUNCTION kernel.purge_published_outbox(p_published_before timestamptz, p_limit integer)
RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = ''
  AS $$
    DECLARE
      removed integer;
    BEGIN
      PERFORM set_config('kernel.purging', 'on', true);
      DELETE FROM kernel.outbox
      WHERE sequence IN (
        SELECT sequence FROM kernel.outbox
        WHERE published_at IS NOT NULL AND published_at < p_published_before
        ORDER BY sequence
        LIMIT least(p_limit, 10000)
      );
      GET DIAGNOSTICS removed = ROW_COUNT;
      PERFORM set_config('kernel.purging', '', true);
      RETURN removed;
    END;
  $$;

CREATE POLICY outbox_owner_reads_published ON kernel.outbox
  FOR SELECT
  TO dreamdevops_owner
  USING (published_at IS NOT NULL AND current_setting('kernel.purging', true) = 'on');

CREATE POLICY outbox_owner_purges_published ON kernel.outbox
  FOR DELETE
  TO dreamdevops_owner
  USING (published_at IS NOT NULL AND current_setting('kernel.purging', true) = 'on');

CREATE INDEX outbox_published_idx ON kernel.outbox (published_at) WHERE published_at IS NOT NULL;

REVOKE ALL ON FUNCTION kernel.purge_published_outbox(timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kernel.purge_published_outbox(timestamptz, integer) TO dreamdevops_relay;

-- Down Migration

DROP INDEX kernel.outbox_published_idx;
DROP POLICY outbox_owner_purges_published ON kernel.outbox;
DROP POLICY outbox_owner_reads_published ON kernel.outbox;
DROP FUNCTION kernel.purge_published_outbox(timestamptz, integer);
