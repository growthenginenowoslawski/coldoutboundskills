-- Migration 0015: Enable RLS on signals table
--
-- All other tables have rowsecurity=true. The signals table was created
-- (likely via Supabase Dashboard) without RLS enabled. This migration
-- closes that gap.
--
-- Safety: The entire application uses the service_role key, which bypasses
-- RLS unconditionally. Enabling RLS here has NO effect on service_role access.
-- The anon/publishable key now correctly cannot read signals without an explicit
-- policy — which matches the design intent (no public signal exposure).
--
-- Policies: Not defined here. Auth/tenant mapping is unresolved. Once
-- authenticated user flows are added, add:
--   CREATE POLICY "clients see own signals"
--     ON public.signals FOR ALL TO authenticated
--     USING (client_id = auth.jwt()->'app_metadata'->>'client_id');
-- or equivalent. See 25-SUPABASE-SECURITY.md.

ALTER TABLE public.signals ENABLE ROW LEVEL SECURITY;
