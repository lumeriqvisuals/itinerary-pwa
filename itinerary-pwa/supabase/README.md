# Supabase setup

1. Create a Supabase project.
2. Install the Supabase CLI and run `supabase link --project-ref YOUR_PROJECT_REF`.
3. Apply migration: `supabase db push` (review migration in a staging project first).
4. In Supabase Auth → Providers, enable Google and configure Google OAuth credentials.
5. In Auth URL Configuration, set the local URL and deployed Vercel URL under allowed redirects.
6. Configure secrets for Edge Functions:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `CRON_SECRET` (long random secret)
   - `VAPID_PUBLIC_KEY`
   - `VAPID_PRIVATE_KEY`
   - `VAPID_SUBJECT` (for example, `mailto:admin@example.com`)
7. Deploy functions with the Supabase CLI.

## Cron

Schedule a POST request to `/functions/v1/process-reminders` every minute and include `x-cron-secret: YOUR_CRON_SECRET`. Use a Supabase Vault secret or another protected server-side mechanism for the header; do not place the secret in browser code.

## VAPID

Generate a VAPID key pair using a trusted Web Push library/tool. Put only the public key in Vercel's `VITE_VAPID_PUBLIC_KEY`; store the private key in Supabase Edge Function secrets.

## Current limitations to address before production

- The worker expects the `claim_due_reminders` SQL function described in the hardening migration. Apply both migrations.
- Recurrence UI currently stores a rule on the activity; production recurrence expansion must create `activity_occurrences` and materialize reminder instances in a bounded horizon.
- Configure a push provider dependency compatible with Supabase's Deno Edge Runtime and test its API in staging. The worker's import is a starting integration, not a verified production dependency.
- Add account deletion, conflict resolution UI, automated tests, and a production error-monitoring service before public launch.
