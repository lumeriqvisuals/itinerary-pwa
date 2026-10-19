import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "https://deno.land/x/webpush@0.3.0/mod.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const cronSecret = Deno.env.get("CRON_SECRET")!;
const vapidPublicKey = Deno.env.get("VAPID_PUBLIC_KEY")!;
const vapidPrivateKey = Deno.env.get("VAPID_PRIVATE_KEY")!;
const vapidSubject = Deno.env.get("VAPID_SUBJECT") || "mailto:admin@example.com";
const supabase = createClient(supabaseUrl, serviceRoleKey);

type DueReminder = {
  id: string; user_id: string; activity_id: string; scheduled_at: string;
  status: string; attempts: number; idempotency_key: string;
  activities: { title: string; status: string } | null;
};

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!cronSecret || req.headers.get("x-cron-secret") !== cronSecret) return new Response("Unauthorized", { status: 401 });

  const { data: claimed, error: claimError } = await supabase.rpc("claim_due_reminders", { p_limit: 50 });
  if (claimError) return Response.json({ error: "Could not claim reminders" }, { status: 500 });

  let processed = 0;
  const failures: string[] = [];
  for (const reminder of (claimed ?? []) as DueReminder[]) {
    processed++;
    try {
      const { data: current, error: currentError } = await supabase
        .from("reminders")
        .select("id,user_id,activity_id,scheduled_at,status,attempts,idempotency_key,activities(title,status)")
        .eq("id", reminder.id).single();
      if (currentError || !current) throw new Error("Reminder no longer exists");
      const activity = Array.isArray(current.activities) ? current.activities[0] : current.activities;
      if (!activity || activity.status !== "planned") {
        await supabase.from("reminders").update({ status: "cancelled", claim_token: null, claimed_at: null }).eq("id", current.id);
        continue;
      }

      const { data: rules } = await supabase.from("reminder_rules").select("channels")
        .eq("user_id", current.user_id).eq("activity_id", current.activity_id).eq("enabled", true);
      const channels = new Set((rules ?? []).flatMap((rule) => rule.channels ?? ["in_app", "push"]));
      if (channels.size === 0) { channels.add("in_app"); channels.add("push"); }

      if (channels.has("in_app")) {
        const { error: inAppError } = await supabase.from("in_app_notifications").insert({
          user_id: current.user_id,
          reminder_id: current.id,
          title: activity.title,
          body: "Your activity is coming up.",
          target_url: "/",
        });
        if (inAppError) throw inAppError;
        await supabase.from("notification_deliveries").insert({
          user_id: current.user_id, reminder_id: current.id, channel: "in_app",
          attempt_number: Math.max(1, current.attempts + 1), status: "submitted",
        });
      }

      if (channels.has("push")) {
        const { data: subscriptions } = await supabase.from("push_subscriptions").select("*").eq("user_id", current.user_id);
        if (subscriptions?.length) {
          webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
          for (const subscription of subscriptions) {
            try {
              await webpush.sendNotification({
                endpoint: subscription.endpoint,
                keys: { p256dh: subscription.p256dh, auth: subscription.auth },
              }, JSON.stringify({
                title: activity.title,
                body: "Your activity is coming up.",
                reminderId: current.id,
                url: "/",
                tag: current.id,
              }));
              await supabase.from("push_subscriptions").update({ last_success_at: new Date().toISOString(), failure_count: 0 })
                .eq("id", subscription.id);
              await supabase.from("notification_deliveries").insert({
                user_id: current.user_id, reminder_id: current.id, channel: "push",
                attempt_number: Math.max(1, current.attempts + 1), status: "submitted",
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : "Push failed";
              await supabase.from("push_subscriptions").update({
                last_failure_at: new Date().toISOString(),
                failure_count: subscription.failure_count + 1,
              }).eq("id", subscription.id);
              if (/410|404/.test(message)) await supabase.from("push_subscriptions").delete().eq("id", subscription.id);
              await supabase.from("notification_deliveries").insert({
                user_id: current.user_id, reminder_id: current.id, channel: "push",
                attempt_number: Math.max(1, current.attempts + 1), status: "failed", error_message: message.slice(0, 500),
              });
            }
          }
        }
      }
      await supabase.from("reminders").update({
        status: "submitted", sent_at: new Date().toISOString(), claim_token: null, claimed_at: null,
        last_error: null,
      }).eq("id", current.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown reminder error";
      failures.push(`${reminder.id}: ${message}`);
      await supabase.from("reminders").update({
        status: reminder.attempts >= 4 ? "failed" : "pending",
        attempts: reminder.attempts + 1,
        last_error: message.slice(0, 500),
        scheduled_at: new Date(Date.now() + Math.min(60, 2 ** reminder.attempts) * 60_000).toISOString(),
        claim_token: null, claimed_at: null,
      }).eq("id", reminder.id);
    }
  }
  return Response.json({ processed, failed: failures.length, failures: failures.slice(0, 10) });
});
