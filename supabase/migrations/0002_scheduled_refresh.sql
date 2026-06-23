-- BestBowl nightly price refresh
--
-- Uses pg_cron + pg_net to POST to a Vercel serverless endpoint
-- (api/refresh-prices.js) every night at 02:00 UTC. That endpoint runs all
-- four store importers (import-all.js) in a Node environment that has the API
-- keys — Postgres itself never holds the importer credentials.
--
-- Prerequisite settings (run once, with the service role / dashboard):
--   ALTER DATABASE postgres SET app.vercel_url = 'https://<your-app>.vercel.app';
--   ALTER DATABASE postgres SET app.cron_secret = '<same value as CRON_SECRET>';
-- The cron job below reads app.vercel_url and sends the secret so the endpoint
-- can authenticate the request.

-- Enable required extensions (Supabase ships both; safe to re-run).
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Remove any previous version of this job so the migration is idempotent.
SELECT cron.unschedule('nightly-price-refresh')
WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'nightly-price-refresh'
);

-- Schedule the nightly price refresh at 02:00 UTC.
SELECT cron.schedule(
  'nightly-price-refresh',
  '0 2 * * *',
  $$
  SELECT net.http_post(
    url     := current_setting('app.vercel_url') || '/api/refresh-prices',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-cron-secret', current_setting('app.cron_secret', true)
               ),
    body    := '{}'::jsonb
  )
  $$
);
