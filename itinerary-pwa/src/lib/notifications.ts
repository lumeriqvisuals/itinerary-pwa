import { supabase } from "./supabase";

const base64UrlToBytes = (value: string) => {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
};

export async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return null;
  return navigator.serviceWorker.register("/sw.js");
}

export async function enablePush(userId: string) {
  if (!supabase) throw new Error("Supabase is not configured.");
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    throw new Error("Web Push is not supported by this browser.");
  }
  const vapidKey = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;
  if (!vapidKey || vapidKey.includes("YOUR_VAPID")) throw new Error("Configure VITE_VAPID_PUBLIC_KEY first.");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notification permission was not granted.");
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: base64UrlToBytes(vapidKey),
  });
  const json = subscription.toJSON();
  const { error } = await supabase.from("push_subscriptions").upsert({
    user_id: userId,
    endpoint: json.endpoint,
    p256dh: json.keys?.p256dh,
    auth: json.keys?.auth,
    expiration_time: json.expirationTime ? new Date(json.expirationTime).toISOString() : null,
    user_agent: navigator.userAgent,
  }, { onConflict: "endpoint" });
  if (error) throw error;
  return subscription;
}

export async function snoozeReminder(reminderId: string, minutes = 10) {
  if (!supabase) throw new Error("Supabase is not configured.");
  const { error } = await supabase.rpc("snooze_reminder", {
    p_reminder_id: reminderId,
    p_minutes: minutes,
  });
  if (error) throw error;
}
