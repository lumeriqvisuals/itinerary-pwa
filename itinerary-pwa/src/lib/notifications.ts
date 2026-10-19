import { supabase } from "./supabase";

const base64UrlToBytes = (value: string) => {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
};

export type ServiceWorkerUpdateHandlers = {
  onUpdateAvailable?: (registration: ServiceWorkerRegistration) => void;
  onControllerChange?: () => void;
};

/**
 * Register the service worker with update detection tuned for Chrome Android.
 */
export async function registerServiceWorker(
  handlers: ServiceWorkerUpdateHandlers = {},
): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;

  const registration = await navigator.serviceWorker.register("/sw.js", {
    scope: "/",
    updateViaCache: "none",
  });

  const promptIfWaiting = () => {
    if (registration.waiting) {
      handlers.onUpdateAvailable?.(registration);
    }
  };

  promptIfWaiting();

  registration.addEventListener("updatefound", () => {
    const installing = registration.installing;
    if (!installing) return;
    installing.addEventListener("statechange", () => {
      if (installing.state === "installed" && navigator.serviceWorker.controller) {
        handlers.onUpdateAvailable?.(registration);
      }
    });
  });

  let refreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (refreshing) return;
    refreshing = true;
    if (handlers.onControllerChange) {
      handlers.onControllerChange();
    } else {
      window.location.reload();
    }
  });

  const checkForUpdates = () => {
    void registration.update().catch(() => {});
  };

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") checkForUpdates();
  });

  window.addEventListener("online", checkForUpdates);
  window.setInterval(checkForUpdates, 30 * 60 * 1000);
  window.setTimeout(checkForUpdates, 10_000);

  return registration;
}

/** Activate a waiting service worker (call from the Reload button). */
export function applyServiceWorkerUpdate(registration: ServiceWorkerRegistration) {
  if (!registration.waiting) {
    window.location.reload();
    return;
  }
  registration.waiting.postMessage({ type: "SKIP_WAITING" });
  registration.waiting.postMessage("SKIP_WAITING");
}

export async function enablePush(userId: string) {
  if (!supabase) throw new Error("Supabase is not configured.");
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    throw new Error("Web Push is not supported by this browser.");
  }
  const vapidKey = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;
  if (!vapidKey || vapidKey.includes("YOUR_VAPID")) {
    throw new Error("Configure VITE_VAPID_PUBLIC_KEY first.");
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("Notification permission was not granted.");
  }
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: base64UrlToBytes(vapidKey),
  });
  const json = subscription.toJSON();
  const { error } = await supabase.from("push_subscriptions").upsert(
    {
      user_id: userId,
      endpoint: json.endpoint,
      p256dh: json.keys?.p256dh,
      auth: json.keys?.auth,
      expiration_time: json.expirationTime ? new Date(json.expirationTime).toISOString() : null,
      user_agent: navigator.userAgent,
    },
    { onConflict: "endpoint" },
  );
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
