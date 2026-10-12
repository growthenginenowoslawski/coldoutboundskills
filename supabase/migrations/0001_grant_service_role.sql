-- 0001_grant_service_role.sql
--
-- Purpose: the server-side Supabase key (sb_secret_… → the `service_role`
-- Postgres role) currently lacks table privileges on the public schema, so the
-- research engine's Trigger.dev tasks + API cannot read/write. This grants the
-- standard Supabase server-side privileges.
--
-- SAFETY: additive only. Grants privileges to an existing role. Does NOT create,
-- drop, alter, or touch any table, column, row, or RLS policy. RLS stays enabled;
-- service_role bypasses RLS by design (server-side use only).
--
-- Apply once via Supabase Dashboard → SQL Editor (or Cursor's Supabase MCP).

grant usage on schema public to service_role;

grant select, insert, update, delete
  on all tables in schema public to service_role;

grant usage, select
  on all sequences in schema public to service_role;

-- Ensure future tables/sequences created in public are usable too.
alter default privileges in schema public
  grant select, insert, update, delete on tables to service_role;

alter default privileges in schema public
  grant usage, select on sequences to service_role;
