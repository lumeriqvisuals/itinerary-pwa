import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import type { Session } from "@supabase/supabase-js";
import {
  ArrowUpRight, Bell, CalendarDays, Check, CheckCheck,
  CircleHelp, Clock3, CloudOff, Compass, ListTodo, LogIn, LogOut, MapPin,
  Menu, Plus, RefreshCw, Search, Settings2, ShieldCheck, Sparkles, Sun, Trash2,
  X,
} from "lucide-react";
import { supabase, isSupabaseConfigured } from "./lib/supabase";
import { enablePush, registerServiceWorker, applyServiceWorkerUpdate } from "./lib/notifications";
import { useItinerary } from "./hooks/useItinerary";
import type { Activity } from "./lib/types";

type View = "today" | "upcoming" | "all" | "settings";
type InAppNotification = { id: string; title: string; body: string; read_at: string | null; created_at: string; };

const formatTime = (value: string) =>
  new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value));

const parseOffsets = (value: string) =>
  [...new Set(value.split(",").map((part) => Number(part.trim())).filter((n) => Number.isFinite(n) && n >= 0 && n <= 525600))]
    .sort((a, b) => b - a);

const toLocalInput = (value: string) => {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

const formatDay = (value: string) =>
  new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" }).format(new Date(value));

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [view, setView] = useState<View>("today");
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<Activity | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showAuth, setShowAuth] = useState(false);
  const [showInbox, setShowInbox] = useState(false);
  const [inboxItems, setInboxItems] = useState<InAppNotification[]>([]);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [query, setQuery] = useState("");
  const [toast, setToast] = useState("");
  const [busy, setBusy] = useState(false);
  const [notificationPermissionVersion, setNotificationPermissionVersion] = useState(0);
  const [swRegistration, setSwRegistration] = useState<ServiceWorkerRegistration | null>(null);
  const [updateReady, setUpdateReady] = useState(false);
  const itinerary = useItinerary(session);

  // Service worker registration + update detection (Chrome Android friendly)
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    let cancelled = false;
    void registerServiceWorker({
      onUpdateAvailable: (registration) => {
        if (cancelled) return;
        setSwRegistration(registration);
        setUpdateReady(true);
      },
    })
      .then((registration) => {
        if (!cancelled && registration) setSwRegistration(registration);
      })
      .catch(console.error);
    return () => {
      cancelled = true;
    };
  }, []);

  // Local reminders work in guest mode and while the app is open. Server push is
  // separately configured for signed-in users in Settings.
  useEffect(() => {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    const checkReminders = () => {
      const now = Date.now();
      itinerary.activities.forEach((activity) => {
        if (activity.status !== "planned") return;
        const snoozeKey = `daymark:snooze:${activity.user_id}:${activity.id}`;
        const snoozedUntil = Number(localStorage.getItem(snoozeKey) || 0);
        const savedOffsets = localStorage.getItem(`daymark:reminders:${activity.user_id}:${activity.id}`);
        const offsets: number[] = savedOffsets ? JSON.parse(savedOffsets) : [15];
        const dueTimes = snoozedUntil > 0
          ? [snoozedUntil]
          : offsets.map((offset) => new Date(activity.start_at).getTime() - offset * 60_000);
        dueTimes.forEach((dueAt) => {
          const firedKey = `daymark:fired:${activity.user_id}:${activity.id}:${Math.floor(dueAt / 60_000)}`;
          if (dueAt <= now && now - dueAt < 60 * 60_000 && !localStorage.getItem(firedKey)) {
            new Notification(`Coming up: ${activity.title}`, {
              body: activity.location ? `Starts soon · ${activity.location}` : "Your activity is coming up.",
              icon: "/icon.svg",
              tag: `${activity.id}-${Math.floor(dueAt / 60_000)}`,
            });
            localStorage.setItem(firedKey, "1");
            localStorage.removeItem(snoozeKey);
          }
        });
      });
    };
    checkReminders();
    const timer = window.setInterval(checkReminders, 30_000);
    return () => window.clearInterval(timer);
  }, [itinerary.activities, notificationPermissionVersion]);

  useEffect(() => {
    if (!supabase) {
      setAuthLoading(false);
      return;
    }
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setAuthLoading(false);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => setSession(nextSession));
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    let active = true;
    const client = supabase;
    if (!session || !client) {
      setInboxItems([]);
      return;
    }
    const loadInbox = async () => {
      const { data, error } = await client
        .from("in_app_notifications")
        .select("id,title,body,read_at,created_at")
        .eq("user_id", session.user.id)
        .order("created_at", { ascending: false })
        .limit(50);
      if (!error && active) setInboxItems((data ?? []) as InAppNotification[]);
    };
    void loadInbox();
    const timer = window.setInterval(() => void loadInbox(), 60_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [session]);

  const markNotificationRead = async (item: InAppNotification) => {
    const client = supabase;
    if (!session || !client) return;
    const readAt = new Date().toISOString();
    const { error } = await client
      .from("in_app_notifications")
      .update({ read_at: readAt })
      .eq("id", item.id)
      .eq("user_id", session.user.id);
    if (error) return notify(error.message);
    setInboxItems((items) =>
      items.map((entry) => (entry.id === item.id ? { ...entry, read_at: readAt } : entry)),
    );
  };

  const filtered = useMemo(() => {
    let list = itinerary.activities.filter((activity) => activity.status !== "cancelled");
    if (view === "today") list = itinerary.todayActivities;
    if (view === "upcoming") list = list.filter((activity) => new Date(activity.start_at) >= new Date());
    if (query.trim()) {
      list = list.filter((activity) =>
        `${activity.title} ${activity.description ?? ""} ${activity.location ?? ""}`
          .toLowerCase()
          .includes(query.toLowerCase()),
      );
    }
    return [...list].sort((a, b) => a.start_at.localeCompare(b.start_at));
  }, [view, itinerary.activities, itinerary.todayActivities, query]);

  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 3500);
  };

  const signIn = async () => {
    if (!supabase) return notify("Add Supabase credentials in .env.local first.");
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin },
    });
    if (error) notify(error.message);
  };

  const signOut = async () => {
    if (supabase) await supabase.auth.signOut();
    setSession(null);
    setShowSettings(false);
    notify("Signed out.");
  };

  const handleAdd = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const startAt = String(form.get("start_at") || "");
    const endAt = String(form.get("end_at") || "");
    const reminderOffsets = parseOffsets(String(form.get("reminder_offsets") || "15"));
    if (endAt && new Date(endAt) < new Date(startAt)) return notify("End time must be after the start time.");
    if (!String(form.get("title") || "").trim()) return notify("Give your activity a name first.");
    setBusy(true);
    try {
      await itinerary.addActivity({
        title: String(form.get("title") || "").trim(),
        description: String(form.get("description") || "").trim() || undefined,
        location: String(form.get("location") || "").trim() || undefined,
        start_at: String(form.get("start_at")),
        end_at: String(form.get("end_at") || "") || undefined,
        recurrence_rule: String(form.get("recurrence") || "") || undefined,
        reminder_offsets: reminderOffsets,
      });
      setShowAdd(false);
      notify(navigator.onLine ? "Activity saved." : "Saved on this device. Syncs when you're back online.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not save activity.");
    } finally {
      setBusy(false);
    }
  };

  const handleEdit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editing) return;
    const form = new FormData(event.currentTarget);
    const start = String(form.get("start_at") || "");
    const end = String(form.get("end_at") || "");
    const reminderOffsets = parseOffsets(String(form.get("reminder_offsets") || "15"));
    if (end && new Date(end) < new Date(start)) return notify("End time must be after the start time.");
    setBusy(true);
    try {
      await itinerary.updateActivity(
        {
          ...editing,
          title: String(form.get("title") || "").trim(),
          description: String(form.get("description") || "").trim() || null,
          location: String(form.get("location") || "").trim() || null,
          start_at: new Date(start).toISOString(),
          end_at: end ? new Date(end).toISOString() : null,
          recurrence_rule: String(form.get("recurrence") || "") || null,
        },
        reminderOffsets,
      );
      setEditing(null);
      notify("Activity updated.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not update activity.");
    } finally {
      setBusy(false);
    }
  };

  const enableLocalNotifications = async () => {
    if (!("Notification" in window)) return notify("This browser does not support notifications.");
    const permission = await Notification.requestPermission();
    setNotificationPermissionVersion((version) => version + 1);
    if (permission === "granted") notify("Local reminders enabled while Daymark is open.");
    else notify("Notification permission was not granted.");
  };

  const snoozeLocalReminder = (activity: Activity) => {
    const now = Date.now();
    const offsets: number[] = JSON.parse(
      localStorage.getItem(`daymark:reminders:${activity.user_id}:${activity.id}`) || "[15]",
    );
    offsets.forEach((offset) => {
      const dueAt = new Date(activity.start_at).getTime() - offset * 60_000;
      if (dueAt <= now) {
        localStorage.setItem(
          `daymark:fired:${activity.user_id}:${activity.id}:${Math.floor(dueAt / 60_000)}`,
          "1",
        );
      }
    });
    localStorage.setItem(`daymark:snooze:${activity.user_id}:${activity.id}`, String(now + 10 * 60_000));
    notify(`Reminder snoozed for ${activity.title} by 10 minutes.`);
  };

  const handlePush = async () => {
    if (!session) return setShowAuth(true);
    try {
      await enablePush(session.user.id);
      notify("Push notifications enabled on this device.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not enable push.");
    }
  };

  const navItems: { id: View; label: string; icon: typeof Sun }[] = [
    { id: "today", label: "Today", icon: Sun },
    { id: "upcoming", label: "Upcoming", icon: CalendarDays },
    { id: "all", label: "All activities", icon: ListTodo },
  ];

  if (authLoading) {
    return (
      <div className="boot-screen">
        <div className="brand-mark">d.</div>
        <p>Getting your day ready…</p>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileMenu ? "sidebar-open" : ""}`}>
        <div className="brand-row">
          <div className="brand-mark">d.</div>
          <div>
            <div className="brand-name">
              daymark<span>.</span>
            </div>
            <div className="brand-subtitle">YOUR DAY, IN FOCUS</div>
          </div>
          <button className="icon-button mobile-close" onClick={() => setMobileMenu(false)} aria-label="Close menu">
            <X size={19} />
          </button>
        </div>
        <div className="workspace-label">WORKSPACE</div>
        <nav className="side-nav" aria-label="Main navigation">
          {navItems.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={`nav-item ${view === id ? "active" : ""}`}
              onClick={() => {
                setView(id);
                setMobileMenu(false);
              }}
            >
              <Icon size={18} />
              <span>{label}</span>
              {id === "today" && itinerary.todayActivities.length > 0 && (
                <span className="nav-count">{itinerary.todayActivities.length}</span>
              )}
            </button>
          ))}
          <button
            className={`nav-item ${view === "settings" ? "active" : ""}`}
            onClick={() => {
              setView("settings");
              setMobileMenu(false);
            }}
          >
            <Settings2 size={18} />
            <span>Settings</span>
          </button>
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-tip">
            <div className="tip-icon">
              <Sparkles size={16} />
            </div>
            <div>
              <strong>A little breathing room</strong>
              <p>Plan with intention. Leave space for life.</p>
            </div>
          </div>
          <div className="profile-row">
            <div className="avatar">{session?.user.email?.slice(0, 1).toUpperCase() || "G"}</div>
            <div className="profile-copy">
              <strong>{session?.user.email?.split("@")[0] || "Guest mode"}</strong>
              <span>{session ? "Synced account" : "Local preview"}</span>
            </div>
            <button
              className="icon-button"
              aria-label={session ? "Sign out" : "Sign in"}
              onClick={() => (session ? void signOut() : setShowAuth(true))}
            >
              {session ? <LogOut size={17} /> : <LogIn size={17} />}
            </button>
          </div>
        </div>
      </aside>

      {mobileMenu && (
        <button className="mobile-scrim" onClick={() => setMobileMenu(false)} aria-label="Close navigation" />
      )}

      <main className="main-area">
        <header className="topbar">
          <div className="topbar-left">
            <button className="icon-button mobile-menu-button" onClick={() => setMobileMenu(true)} aria-label="Open menu">
              <Menu size={20} />
            </button>
            <div className="breadcrumb">
              Workspace <span>/</span>{" "}
              <strong>
                {view === "today"
                  ? "Today"
                  : view === "upcoming"
                    ? "Upcoming"
                    : view === "all"
                      ? "All activities"
                      : "Settings"}
              </strong>
            </div>
          </div>
          <div className="topbar-actions">
            <div className={`sync-status ${itinerary.offline ? "offline" : ""}`}>
              <span className="status-dot" />
              {itinerary.offline
                ? "Offline"
                : itinerary.syncing
                  ? "Syncing…"
                  : itinerary.operationsCount === 0
                    ? "Up to date"
                    : "Changes pending"}
            </div>
            {session && (
              <button
                className="icon-button"
                onClick={() => setShowInbox(true)}
                aria-label="Open notifications"
                title="Notifications"
              >
                <Bell size={17} />
                {inboxItems.some((item) => !item.read_at) && <span className="notification-dot" />}
              </button>
            )}
            {session && (
              <button
                className="icon-button"
                onClick={() => void itinerary.sync()}
                aria-label="Sync now"
                title="Sync now"
                disabled={itinerary.syncing || itinerary.offline}
              >
                <RefreshCw size={16} />
              </button>
            )}
            <button className="icon-button search-toggle" aria-label="Focus search">
              <Search size={18} />
            </button>
            <button
              className="avatar top-avatar"
              onClick={() => (session ? setShowSettings(true) : setShowAuth(true))}
              aria-label="Account"
            >
              {session?.user.email?.slice(0, 1).toUpperCase() || "G"}
            </button>
          </div>
        </header>

        <div className="page-content">
          {view === "settings" ? (
            <section className="settings-page">
              <div className="eyebrow">
                <Settings2 size={14} /> PREFERENCES
              </div>
              <h1>
                Your space,
                <br />
                <em>your rhythm.</em>
              </h1>
              <p className="page-intro">A few thoughtful settings make reminders feel helpful, not noisy.</p>
              <div className="settings-card">
                <div className="settings-row">
                  <div className="settings-icon">
                    <Bell size={18} />
                  </div>
                  <div className="settings-copy">
                    <strong>Push notifications</strong>
                    <p>Get reminders even when Daymark isn't open, where supported.</p>
                  </div>
                  <button className="button button-light button-small" onClick={() => void enableLocalNotifications()}>
                    Local
                  </button>
                  <button className="button button-dark button-small" onClick={() => void handlePush()}>
                    Push
                  </button>
                </div>
                <div className="settings-row">
                  <div className="settings-icon">
                    <ShieldCheck size={18} />
                  </div>
                  <div className="settings-copy">
                    <strong>Account & sync</strong>
                    <p>
                      {session
                        ? `Signed in as ${session.user.email || "your Google account"}.`
                        : "Sign in with Google to sync activities across devices."}
                    </p>
                  </div>
                  <button
                    className="button button-light button-small"
                    onClick={() => (session ? void signOut() : void signIn())}
                  >
                    {session ? "Sign out" : "Connect"}
                  </button>
                </div>
                <div className="settings-row">
                  <div className="settings-icon">
                    <Clock3 size={18} />
                  </div>
                  <div className="settings-copy">
                    <strong>Local time zone</strong>
                    <p>{Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"} · Used for activity display.</p>
                  </div>
                </div>
                <div className="settings-row">
                  <div className="settings-icon">
                    <CloudOff size={18} />
                  </div>
                  <div className="settings-copy">
                    <strong>Offline access</strong>
                    <p>
                      Previously loaded activities are kept on this device. Pending changes sync when you're online.
                    </p>
                  </div>
                </div>
              </div>
              {!isSupabaseConfigured && (
                <div className="notice">
                  <CircleHelp size={18} />
                  <div>
                    <strong>Backend setup needed</strong>
                    <p>
                      You're seeing the local preview. Add your Supabase project URL and public anon key to{" "}
                      <code>.env.local</code>, apply the SQL migration, then configure Google OAuth and push secrets.
                    </p>
                  </div>
                </div>
              )}
            </section>
          ) : (
            <>
              <div className="welcome-row">
                <div>
                  <div className="eyebrow">
                    <span className="eyebrow-dot" />
                    {new Intl.DateTimeFormat(undefined, {
                      weekday: "long",
                      month: "long",
                      day: "numeric",
                    })
                      .format(new Date())
                      .toUpperCase()}
                  </div>
                  <h1>
                    {view === "today" ? (
                      <>
                        Make room for
                        <br />
                        <em>what matters.</em>
                      </>
                    ) : view === "upcoming" ? (
                      <>
                        A little ahead,
                        <br />
                        <em>a lot more ready.</em>
                      </>
                    ) : (
                      <>
                        Everything in
                        <br />
                        <em>one clear place.</em>
                      </>
                    )}
                  </h1>
                  <p className="page-intro">
                    {view === "today"
                      ? "A calmer plan for the day you're in."
                      : view === "upcoming"
                        ? "Your next steps, without the scramble."
                        : "All your plans, gathered in one place."}
                  </p>
                </div>
                <div className="welcome-art" aria-hidden="true">
                  <div className="sun-disc" />
                  <div className="art-hill hill-back" />
                  <div className="art-hill hill-front" />
                  <div className="art-path" />
                </div>
              </div>

              <div className="summary-grid">
                <div className="summary-card summary-primary">
                  <div className="summary-top">
                    <span>ON YOUR PLATE</span>
                    <CalendarDays size={17} />
                  </div>
                  <div className="summary-number">{itinerary.todayActivities.length.toString().padStart(2, "0")}</div>
                  <div className="summary-foot">
                    planned for today <span>·</span> take it one step at a time
                  </div>
                </div>
                <div className="summary-card">
                  <div className="summary-top">
                    <span>NEXT UP</span>
                    <Clock3 size={17} />
                  </div>
                  <div className="next-up-title">
                    {itinerary.activities
                      .filter((a) => a.status === "planned" && new Date(a.start_at) >= new Date())
                      .sort((a, b) => a.start_at.localeCompare(b.start_at))[0]?.title || "A little open space"}
                  </div>
                  <div className="summary-foot">
                    {itinerary.activities.filter((a) => a.status === "planned" && new Date(a.start_at) >= new Date())
                      .length
                      ? "There's a plan on the horizon"
                      : "You have room to choose"}
                  </div>
                </div>
              </div>

              <section className="activities-section">
                <div className="section-heading">
                  <div>
                    <div className="eyebrow">YOUR ITINERARY</div>
                    <h2>
                      {view === "today" ? "Today's flow" : view === "upcoming" ? "Coming up" : "All activities"}{" "}
                      <span>{filtered.length.toString().padStart(2, "0")}</span>
                    </h2>
                  </div>
                  <div className="section-actions">
                    <label className="search-box" htmlFor="activity-search">
                      <Search size={16} />
                      <input
                        id="activity-search"
                        name="search"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Find a plan…"
                        aria-label="Search activities"
                        autoComplete="off"
                      />
                    </label>
                    <button className="button button-dark" onClick={() => setShowAdd(true)}>
                      <Plus size={17} /> Add activity
                    </button>
                  </div>
                </div>

                {itinerary.error && <div className="inline-error">{itinerary.error}</div>}
                {!itinerary.configured && (
                  <div className="preview-banner">
                    <Sparkles size={16} />
                    <span>
                      <strong>Preview mode</strong> — activities stay in this browser until Supabase is connected.
                    </span>
                  </div>
                )}

                {itinerary.loading ? (
                  <div className="empty-state">Gathering your plans…</div>
                ) : filtered.length === 0 ? (
                  <div className="empty-state">
                    <div className="empty-icon">
                      <Compass size={25} />
                    </div>
                    <h3>
                      {query
                        ? "No matching plans"
                        : view === "today"
                          ? "A fresh page."
                          : "Nothing on the list yet."}
                    </h3>
                    <p>
                      {query
                        ? "Try another search term."
                        : "Add an activity and give your day a little shape."}
                    </p>
                    {!query && (
                      <button className="button button-light" onClick={() => setShowAdd(true)}>
                        <Plus size={16} /> Add your first activity
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="activity-list">
                    {filtered.map((activity, index) => (
                      <ActivityRow
                        key={activity.id}
                        activity={activity}
                        index={index}
                        onComplete={() => void itinerary.completeActivity(activity)}
                        onDelete={() => void itinerary.deleteActivity(activity)}
                        onSnooze={() => snoozeLocalReminder(activity)}
                        onEdit={() => setEditing(activity)}
                      />
                    ))}
                  </div>
                )}
              </section>

              <div className="bottom-note">
                <Sparkles size={15} />
                <span>Productivity isn't about doing it all. It's about doing what matters.</span>
                <span className="note-line" />
              </div>
            </>
          )}
        </div>
      </main>

      {/* ── Add Activity Modal ── */}
      {showAdd && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setShowAdd(false);
          }}
        >
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="add-title">
            <div className="modal-head">
              <div>
                <div className="eyebrow">MAKE A LITTLE SPACE</div>
                <h2 id="add-title">Add an activity</h2>
              </div>
              <button className="icon-button" onClick={() => setShowAdd(false)} aria-label="Close">
                <X size={20} />
              </button>
            </div>

            <form onSubmit={(e) => void handleAdd(e)} className="activity-form">
              <label htmlFor="add-title-field">
                Activity name
                <input
                  id="add-title-field"
                  name="title"
                  required
                  maxLength={140}
                  placeholder="e.g. Coffee with Amara"
                  autoComplete="off"
                />
              </label>

              <div className="form-grid">
                <label htmlFor="add-start">
                  Starts
                  <input
                    id="add-start"
                    name="start_at"
                    type="datetime-local"
                    required
                    defaultValue={new Date(
                      Date.now() + 30 * 60_000 - new Date().getTimezoneOffset() * 60_000,
                    )
                      .toISOString()
                      .slice(0, 16)}
                  />
                </label>
                <label htmlFor="add-end">
                  Ends (optional)
                  <input id="add-end" name="end_at" type="datetime-local" />
                </label>
              </div>

              <label htmlFor="add-location">
                Location (optional)
                <span className="input-with-icon">
                  <MapPin size={16} />
                  <input
                    id="add-location"
                    name="location"
                    placeholder="Where is it happening?"
                    autoComplete="street-address"
                  />
                </span>
              </label>

              <label htmlFor="add-description">
                Notes (optional)
                <textarea
                  id="add-description"
                  name="description"
                  rows={3}
                  placeholder="Anything worth remembering…"
                />
              </label>

              <label htmlFor="add-recurrence">
                Repeat
                <select id="add-recurrence" name="recurrence" defaultValue="">
                  <option value="">Does not repeat</option>
                  <option value="FREQ=DAILY">Every day</option>
                  <option value="FREQ=WEEKLY">Every week</option>
                  <option value="FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR">Weekdays</option>
                  <option value="FREQ=MONTHLY">Every month</option>
                </select>
              </label>

              <label htmlFor="add-reminders">
                Reminders (minutes before, comma-separated)
                <input
                  id="add-reminders"
                  name="reminder_offsets"
                  inputMode="numeric"
                  defaultValue="60, 15"
                  placeholder="e.g. 60, 15"
                  autoComplete="off"
                />
                <span className="field-hint">
                  Use 0 for the activity start time. Separate multiple reminders with commas.
                </span>
              </label>

              <div className="modal-actions">
                <button type="button" className="button button-light" onClick={() => setShowAdd(false)}>
                  Cancel
                </button>
                <button type="submit" className="button button-dark" disabled={busy}>
                  {busy ? "Saving…" : <><Check size={17} /> Save activity</>}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}

      {/* ── Inbox Modal ── */}
      {showInbox && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setShowInbox(false);
          }}
        >
          <section className="modal inbox-modal" role="dialog" aria-modal="true" aria-labelledby="inbox-title">
            <div className="modal-head">
              <div>
                <div className="eyebrow">STAY IN THE LOOP</div>
                <h2 id="inbox-title">Notifications</h2>
              </div>
              <button className="icon-button" onClick={() => setShowInbox(false)} aria-label="Close">
                <X size={20} />
              </button>
            </div>
            {inboxItems.length === 0 ? (
              <div className="empty-state inbox-empty">
                <div className="empty-icon">
                  <Bell size={22} />
                </div>
                <h3>You're all caught up.</h3>
                <p>Activity reminders will appear here when your cloud reminder schedule is active.</p>
              </div>
            ) : (
              <div className="inbox-list">
                {inboxItems.map((item) => (
                  <article key={item.id} className={`inbox-item ${item.read_at ? "read" : "unread"}`}>
                    <div className="inbox-item-copy">
                      <strong>{item.title}</strong>
                      <p>{item.body}</p>
                      <span>
                        {new Intl.DateTimeFormat(undefined, {
                          dateStyle: "medium",
                          timeStyle: "short",
                        }).format(new Date(item.created_at))}
                      </span>
                    </div>
                    {!item.read_at && (
                      <button
                        className="button button-light button-small"
                        onClick={() => void markNotificationRead(item)}
                      >
                        Mark read
                      </button>
                    )}
                  </article>
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      {/* ── Edit Activity Modal ── */}
      {editing && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setEditing(null);
          }}
        >
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="edit-title">
            <div className="modal-head">
              <div>
                <div className="eyebrow">REFINE YOUR PLAN</div>
                <h2 id="edit-title">Edit activity</h2>
              </div>
              <button className="icon-button" onClick={() => setEditing(null)} aria-label="Close">
                <X size={20} />
              </button>
            </div>

            <form onSubmit={(e) => void handleEdit(e)} className="activity-form">
              <label htmlFor="edit-title-field">
                Activity name
                <input
                  id="edit-title-field"
                  name="title"
                  required
                  maxLength={140}
                  defaultValue={editing.title}
                  autoComplete="off"
                />
              </label>

              <div className="form-grid">
                <label htmlFor="edit-start">
                  Starts
                  <input
                    id="edit-start"
                    name="start_at"
                    type="datetime-local"
                    required
                    defaultValue={toLocalInput(editing.start_at)}
                  />
                </label>
                <label htmlFor="edit-end">
                  Ends (optional)
                  <input
                    id="edit-end"
                    name="end_at"
                    type="datetime-local"
                    defaultValue={editing.end_at ? toLocalInput(editing.end_at) : ""}
                  />
                </label>
              </div>

              <label htmlFor="edit-location">
                Location (optional)
                <span className="input-with-icon">
                  <MapPin size={16} />
                  <input
                    id="edit-location"
                    name="location"
                    defaultValue={editing.location ?? ""}
                    placeholder="Where is it happening?"
                    autoComplete="street-address"
                  />
                </span>
              </label>

              <label htmlFor="edit-description">
                Notes (optional)
                <textarea
                  id="edit-description"
                  name="description"
                  rows={3}
                  defaultValue={editing.description ?? ""}
                  placeholder="Anything worth remembering…"
                />
              </label>

              <label htmlFor="edit-recurrence">
                Repeat
                <select id="edit-recurrence" name="recurrence" defaultValue={editing.recurrence_rule ?? ""}>
                  <option value="">Does not repeat</option>
                  <option value="FREQ=DAILY">Every day</option>
                  <option value="FREQ=WEEKLY">Every week</option>
                  <option value="FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR">Weekdays</option>
                  <option value="FREQ=MONTHLY">Every month</option>
                </select>
              </label>

              <label htmlFor="edit-reminders">
                Reminders (minutes before, comma-separated)
                <input
                  id="edit-reminders"
                  name="reminder_offsets"
                  inputMode="numeric"
                  defaultValue={
                    localStorage.getItem(`daymark:reminders:${editing.user_id}:${editing.id}`) || "60, 15"
                  }
                  placeholder="e.g. 60, 15"
                  autoComplete="off"
                />
                <span className="field-hint">
                  Use 0 for the activity start time. Separate multiple reminders with commas.
                </span>
              </label>

              <div className="modal-actions">
                <button type="button" className="button button-light" onClick={() => setEditing(null)}>
                  Cancel
                </button>
                <button type="submit" className="button button-dark" disabled={busy}>
                  {busy ? "Saving…" : <><Check size={17} /> Save changes</>}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}

      {/* ── Auth / Settings Modal ── */}
      {(showAuth || showSettings) && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) {
              setShowAuth(false);
              setShowSettings(false);
            }
          }}
        >
          <section className="modal auth-modal" role="dialog" aria-modal="true" aria-labelledby="auth-title">
            <button
              className="icon-button modal-dismiss"
              onClick={() => {
                setShowAuth(false);
                setShowSettings(false);
              }}
              aria-label="Close"
            >
              <X size={20} />
            </button>
            <div className="brand-mark auth-mark">d.</div>
            <div className="eyebrow">YOUR PLANS, WHEREVER YOU ARE</div>
            <h2 id="auth-title">{session ? "Your Daymark account" : "Keep your day in sync."}</h2>
            <p>
              {session
                ? `You're signed in as ${session.user.email || "your Google account"}.`
                : "Sign in with Google to keep your itinerary safe and in sync across devices."}
            </p>
            {session ? (
              <button className="button button-light button-full" onClick={() => void signOut()}>
                <LogOut size={17} /> Sign out
              </button>
            ) : (
              <button className="button button-dark button-full" onClick={() => void signIn()}>
                <LogIn size={17} /> Continue with Google <ArrowUpRight size={16} />
              </button>
            )}
            <p className="auth-foot">
              <ShieldCheck size={14} /> Your itinerary is private to your account.
            </p>
          </section>
        </div>
      )}

      {updateReady && (
        <div className="toast sw-update-toast" role="status">
          <RefreshCw size={17} />
          <span>A new version of Daymark is ready.</span>
          <button
            className="button button-dark button-small"
            type="button"
            onClick={() => {
              if (swRegistration) applyServiceWorkerUpdate(swRegistration);
              else window.location.reload();
            }}
          >
            Reload
          </button>
          <button
            className="toast-close"
            type="button"
            onClick={() => setUpdateReady(false)}
            aria-label="Dismiss"
          >
            <X size={15} />
          </button>
        </div>
      )}
      {toast && (
        <div className="toast" role="status">
          <CheckCheck size={17} />
          {toast}
          <button className="toast-close" onClick={() => setToast("")} aria-label="Dismiss">
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}

function ActivityRow({
  activity,
  index,
  onComplete,
  onDelete,
  onSnooze,
  onEdit,
}: {
  activity: Activity;
  index: number;
  onComplete: () => void;
  onDelete: () => void;
  onSnooze: () => void;
  onEdit: () => void;
}) {
  return (
    <article
      className={`activity-row ${activity.status === "completed" ? "is-complete" : ""}`}
      style={{ animationDelay: `${index * 45}ms` }}
    >
      <div className="activity-time">
        <strong>{formatTime(activity.start_at)}</strong>
        <span>{formatDay(activity.start_at)}</span>
      </div>
      <div className="activity-marker">
        <span />
      </div>
      <div className="activity-main">
        <div className="activity-title-row">
          <h3>{activity.title}</h3>
          {activity.recurrence_rule && (
            <span className="repeat-tag">
              <RefreshCw size={11} /> Repeat
            </span>
          )}
        </div>
        {activity.description && <p>{activity.description}</p>}
        {activity.location && (
          <div className="activity-location">
            <MapPin size={13} />
            {activity.location}
          </div>
        )}
      </div>
      <div className="activity-actions">
        <button
          className={`complete-button ${activity.status === "completed" ? "done" : ""}`}
          onClick={onComplete}
          aria-label={activity.status === "completed" ? "Mark as planned" : "Mark completed"}
          title={activity.status === "completed" ? "Mark as planned" : "Mark completed"}
        >
          <Check size={16} />
        </button>
        <button className="icon-button subtle-action" onClick={onEdit} aria-label="Edit activity" title="Edit activity">
          <Settings2 size={16} />
        </button>
        <button
          className="icon-button subtle-action"
          onClick={onSnooze}
          aria-label="Snooze reminder"
          title="Snooze reminder"
        >
          <Clock3 size={16} />
        </button>
        <button
          className="icon-button subtle-action delete-action"
          onClick={onDelete}
          aria-label="Delete activity"
          title="Delete activity"
        >
          <Trash2 size={16} />
        </button>
      </div>
    </article>
  );
}
