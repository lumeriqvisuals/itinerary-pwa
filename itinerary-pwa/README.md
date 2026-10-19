# Daymark — Itinerary PWA

A mobile-first React + Vite + Tailwind PWA for planning activities, saving them offline, and receiving reminders.

## What works in this build

- Add, edit, complete/reopen, search, and delete activities.
- Activity details include start/end time, notes, location, and a recurrence rule.
- Multiple reminder offsets per activity (minutes before the start), with local notification delivery while Daymark is open and browser notification permission is granted.
- Snooze local reminders by 10 minutes.
- IndexedDB snapshots and a queued activity mutation sync for offline activity edits.
- Google OAuth via Supabase Auth, when configured.
- Cloud activity sync with row-level security, cloud reminder rule/instance creation, in-app notification inbox, and push-subscription registration, when configured.
- PWA manifest, service worker shell cache, push event display, and notification click navigation.
- Supabase SQL migrations and a scheduled reminder worker.

## Local development

Requirements: Node.js 20+ and npm.

```bash
npm install
cp .env.example .env.local
npm run dev
```

Without Supabase credentials, Daymark runs in local guest mode. Guest activities and reminder preferences are stored on the current browser/device. Local notifications require permission and can be delivered while the app is open; a browser cannot guarantee timers or notifications when the app is fully closed.

## Supabase and Vercel setup

1. Create a Supabase project.
2. Apply `supabase/migrations/202610150001_initial_schema.sql` and then `supabase/migrations/202610150002_reminder_worker.sql`.
3. In Supabase Auth, enable Google OAuth and add your local and deployed app URLs to the allowed redirect URLs.
4. Add these browser-safe environment variables to `.env.local` and Vercel:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
   - `VITE_VAPID_PUBLIC_KEY`
5. Deploy the Edge Functions in `supabase/functions/` and configure server-side secrets in Supabase:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `CRON_SECRET`
   - `VAPID_PUBLIC_KEY`
   - `VAPID_PRIVATE_KEY`
   - `VAPID_SUBJECT` (for example, `mailto:admin@example.com`)
6. Schedule a protected POST to `/functions/v1/process-reminders` every minute with `x-cron-secret`. Store the secret in your scheduler/Vault, never in the browser.
7. Redeploy Vercel after adding environment variables.

Never put the Supabase service-role key or VAPID private key in any `VITE_` variable.

## Important limitations before production

- The current recurrence selector saves recurrence rules, but does not yet materialize independently editable future occurrences or generate reminder instances for each repeat.
- Local browser reminders run while the app is open. Reliable closed-app push delivery requires a valid VAPID key pair, deployed Edge Functions, a protected scheduler, and real-device testing.
- Cloud reminder scheduling depends on the migrations, policies, Supabase credentials, and scheduler being correctly configured. Test it in a staging project before relying on it.
- Offline activity mutations are queued; reminder-rule changes made offline are stored locally but are not yet queued as cloud operations.
- Conflict resolution, account deletion, automated end-to-end tests, and production monitoring are not yet implemented.

## Build

```bash
npm run build
npm run lint
```
