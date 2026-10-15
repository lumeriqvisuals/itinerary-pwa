export type ActivityStatus = "planned" | "completed" | "cancelled";
export type ReminderStatus = "pending" | "processing" | "submitted" | "failed" | "cancelled";

export interface Activity {
  id: string;
  user_id: string;
  title: string;
  description: string | null;
  location: string | null;
  timezone: string;
  start_at: string;
  end_at: string | null;
  recurrence_rule: string | null;
  recurrence_until: string | null;
  recurrence_count: number | null;
  series_id: string | null;
  occurrence_key: string | null;
  is_override: boolean;
  status: ActivityStatus;
  created_at: string;
  updated_at: string;
  version: number;
}

export interface Reminder {
  id: string;
  user_id: string;
  activity_id: string;
  offset_minutes: number;
  scheduled_at: string;
  status: ReminderStatus;
  snoozed_until: string | null;
  sent_at: string | null;
  attempts: number;
  last_error: string | null;
}

export interface LocalOperation {
  id: string;
  userId: string;
  table: "activities";
  kind: "upsert" | "delete";
  recordId: string;
  payload?: Partial<Activity>;
  createdAt: string;
}

export interface LocalSnapshot {
  activities: Activity[];
  operations: LocalOperation[];
}
