import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { makeOperation, readSnapshot, writeSnapshot } from "../lib/localDb";
import { isSupabaseConfigured, supabase } from "../lib/supabase";
import type { Activity, LocalOperation } from "../lib/types";

const nowLocal = () => {
  const date = new Date(Date.now() + 60_000);
  date.setSeconds(0, 0);
  return date.toISOString().slice(0, 16);
};

function toActivity(input: Partial<Activity> & Pick<Activity, "title" | "start_at" | "user_id">): Activity {
  const now = new Date().toISOString();
  return {
    id: input.id ?? crypto.randomUUID(),
    user_id: input.user_id,
    title: input.title,
    description: input.description ?? null,
    location: input.location ?? null,
    timezone: input.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
    start_at: input.start_at,
    end_at: input.end_at ?? null,
    recurrence_rule: input.recurrence_rule ?? null,
    recurrence_until: input.recurrence_until ?? null,
    recurrence_count: input.recurrence_count ?? null,
    series_id: input.series_id ?? null,
    occurrence_key: input.occurrence_key ?? null,
    is_override: input.is_override ?? false,
    status: input.status ?? "planned",
    created_at: input.created_at ?? now,
    updated_at: now,
    version: input.version ?? 1,
  };
}

function normalizeOffsets(offsets: number[] | undefined): number[] {
  const clean = [...new Set((offsets ?? [15]).filter((value) => Number.isFinite(value) && value >= 0 && value <= 525600))];
  return clean.length ? clean.sort((a, b) => b - a) : [15];
}

async function saveReminderOffsets(userId: string, activity: Activity, offsets: number[] | undefined, cloudEnabled: boolean) {
  const normalized = normalizeOffsets(offsets);
  localStorage.setItem(`daymark:reminders:${userId}:${activity.id}`, JSON.stringify(normalized));
  if (!cloudEnabled || !supabase || userId === "guest-local") return;

  // Replace future reminder rules/instances for this activity. Sent history is retained.
  const { error: deleteRulesError } = await supabase.from("reminder_rules").delete()
    .eq("user_id", userId).eq("activity_id", activity.id);
  if (deleteRulesError) throw deleteRulesError;
  const { error: deleteRemindersError } = await supabase.from("reminders").delete()
    .eq("user_id", userId).eq("activity_id", activity.id).in("status", ["pending", "failed", "cancelled"]);
  if (deleteRemindersError) throw deleteRemindersError;
  for (const offset of normalized) {
    const { data: rule, error: ruleError } = await supabase.from("reminder_rules").insert({
      user_id: userId, activity_id: activity.id, offset_minutes: offset, channels: ["in_app", "push"], enabled: true,
    }).select("id").single();
    if (ruleError) throw ruleError;
    const scheduledAt = new Date(new Date(activity.start_at).getTime() - offset * 60_000).toISOString();
    const { error: reminderError } = await supabase.from("reminders").insert({
      user_id: userId, activity_id: activity.id, reminder_rule_id: rule.id,
      offset_minutes: offset, scheduled_at: scheduledAt,
      idempotency_key: `${activity.id}:${activity.start_at}:${offset}:${crypto.randomUUID()}`,
    });
    if (reminderError) throw reminderError;
  }
}

export function useItinerary(session: Session | null) {
  const userId = session?.user.id ?? "guest-local";
  const [activities, setActivities] = useState<Activity[]>([]);
  const [operations, setOperations] = useState<LocalOperation[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const syncingRef = useRef(false);
  const [offline, setOffline] = useState(!navigator.onLine);
  const [error, setError] = useState<string | null>(null);

  const persist = useCallback(async (nextActivities: Activity[], nextOperations: LocalOperation[]) => {
    if (!userId) return;
    setActivities(nextActivities);
    setOperations(nextOperations);
    await writeSnapshot(userId, { activities: nextActivities, operations: nextOperations });
  }, [userId, session]);

  const sync = useCallback(async () => {
    if (!session || !supabase || !navigator.onLine || operations.length === 0 || syncingRef.current) return;
    syncingRef.current = true;
    setSyncing(true);
    setError(null);
    let remaining = [...operations];
    try {
      for (const op of operations) {
        if (op.kind === "delete") {
          const { error: deleteError } = await supabase.from("activities").delete().eq("id", op.recordId).eq("user_id", userId);
          if (deleteError) throw deleteError;
        } else if (op.payload) {
          const payload = { ...op.payload, user_id: userId };
          const { error: upsertError } = await supabase.from("activities").upsert(payload, { onConflict: "id" });
          if (upsertError) throw upsertError;
        }
        remaining = remaining.filter((item) => item.id !== op.id);
        setOperations([...remaining]);
        await writeSnapshot(userId, { activities, operations: remaining });
      }
      const { data, error: fetchError } = await supabase.from("activities").select("*").eq("user_id", userId).order("start_at");
      if (fetchError) throw fetchError;
      const pendingIds = new Set(remaining.map((op) => op.recordId));
      const merged = [...(data as Activity[] ?? []).filter((item) => !pendingIds.has(item.id))];
      for (const op of remaining) {
        if (op.kind === "upsert" && op.payload) merged.push(toActivity(op.payload as Activity));
      }
      await persist(merged, remaining);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sync failed. Your local changes are retained.");
    } finally {
      syncingRef.current = false;
      setSyncing(false);
    }
  }, [userId, session, operations, activities, persist]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    if (!userId) {
      setActivities([]);
      setOperations([]);
      setLoading(false);
      return;
    }
    void (async () => {
      try {
        const snapshot = await readSnapshot(userId);
        if (!active) return;
        setActivities(snapshot.activities);
        setOperations(snapshot.operations);
        if (supabase && session && navigator.onLine) {
          const { data, error: fetchError } = await supabase.from("activities").select("*").eq("user_id", userId).order("start_at");
          if (fetchError) throw fetchError;
          const pendingIds = new Set(snapshot.operations.map((op) => op.recordId));
          const merged = [...((data ?? []) as Activity[]).filter((item) => !pendingIds.has(item.id))];
          snapshot.operations.forEach((op) => {
            if (op.kind === "upsert" && op.payload) merged.push(toActivity(op.payload as Activity));
          });
          if (active) {
            setActivities(merged);
            await writeSnapshot(userId, { activities: merged, operations: snapshot.operations });
          }
        }
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : "Could not load itinerary.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [userId, session]);

  useEffect(() => {
    if (session && navigator.onLine && operations.length > 0) void sync();
  }, [session, operations.length, sync]);

  useEffect(() => {
    const onOnline = () => { setOffline(false); void sync(); };
    const onOffline = () => setOffline(true);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [sync]);

  const addActivity = useCallback(async (input: { title: string; description?: string; location?: string; start_at: string; end_at?: string; recurrence_rule?: string; reminder_offsets?: number[] }) => {
    if (!userId) throw new Error("Sign in to save your itinerary.");
    const activity = toActivity({
      ...input,
      user_id: userId,
      start_at: new Date(input.start_at).toISOString(),
      end_at: input.end_at ? new Date(input.end_at).toISOString() : null,
    });
    const op = makeOperation(userId, activity);
    await persist([...activities, activity].sort((a, b) => a.start_at.localeCompare(b.start_at)), [...operations, op]);
    let cloudReady = false;
    if (session && navigator.onLine && supabase) {
      const { error: activityError } = await supabase.from("activities").upsert(activity, { onConflict: "id" });
      cloudReady = !activityError;
      if (activityError) setError(`Activity saved locally; cloud sync is pending: ${activityError.message}`);
    }
    try { await saveReminderOffsets(userId, activity, input.reminder_offsets, cloudReady); }
    catch (cause) { setError(`Activity saved, but reminder setup failed: ${cause instanceof Error ? cause.message : "unknown error"}`); }
    if (session && navigator.onLine && supabase) void sync();
  }, [userId, session, activities, operations, persist, sync]);

  const updateActivity = useCallback(async (activity: Activity, reminderOffsets?: number[]) => {
    if (!userId) return;
    const updated = { ...activity, updated_at: new Date().toISOString(), version: activity.version + 1 };
    const next = activities.map((item) => item.id === activity.id ? updated : item)
      .sort((a, b) => a.start_at.localeCompare(b.start_at));
    const op = makeOperation(userId, updated);
    await persist(next, [...operations.filter((item) => item.recordId !== activity.id), op]);
    let cloudReady = false;
    if (session && navigator.onLine && supabase) {
      const { error: activityError } = await supabase.from("activities").upsert(updated, { onConflict: "id" });
      cloudReady = !activityError;
      if (activityError) setError(`Activity updated locally; cloud sync is pending: ${activityError.message}`);
    }
    if (reminderOffsets) {
      try { await saveReminderOffsets(userId, updated, reminderOffsets, cloudReady); }
      catch (cause) { setError(`Activity updated, but reminder setup failed: ${cause instanceof Error ? cause.message : "unknown error"}`); }
    }
    if (session && navigator.onLine && supabase) void sync();
  }, [userId, session, activities, operations, persist, sync]);

  const completeActivity = useCallback(async (activity: Activity) => {
    if (!userId) return;
    const updated = { ...activity, status: activity.status === "completed" ? "planned" as const : "completed" as const, updated_at: new Date().toISOString(), version: activity.version + 1 };
    const next = activities.map((item) => item.id === activity.id ? updated : item);
    const op = makeOperation(userId, updated);
    await persist(next, [...operations.filter((item) => item.recordId !== activity.id), op]);
    if (session && navigator.onLine && supabase) void sync();
  }, [userId, session, activities, operations, persist, sync]);

  const deleteActivity = useCallback(async (activity: Activity) => {
    if (!userId) return;
    const next = activities.filter((item) => item.id !== activity.id);
    const op = makeOperation(userId, activity, "delete");
    await persist(next, [...operations.filter((item) => item.recordId !== activity.id), op]);
    if (session && navigator.onLine && supabase) void sync();
  }, [userId, session, activities, operations, persist, sync]);

  const todayActivities = useMemo(() => {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const end = new Date(start); end.setDate(end.getDate() + 1);
    return activities.filter((activity) => {
      const date = new Date(activity.start_at);
      return date >= start && date < end && activity.status !== "cancelled";
    });
  }, [activities]);

  return {
    activities, todayActivities, loading, syncing, offline, error, addActivity, updateActivity,
    completeActivity, deleteActivity, sync, operationsCount: operations.length,
    configured: isSupabaseConfigured,
    nowLocal,
  };
}
