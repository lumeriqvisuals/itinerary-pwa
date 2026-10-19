/**
 * Small RFC 5545-like subset for client previews: FREQ=DAILY|WEEKLY|MONTHLY,
 * INTERVAL, BYDAY, COUNT, UNTIL. For authoritative production occurrence
 * generation, use a well-tested recurrence library/server implementation.
 */
export interface RecurrenceOptions {
  frequency: "DAILY" | "WEEKLY" | "MONTHLY";
  interval: number;
  byDay: number[];
  count?: number;
  until?: Date;
}

const DAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

export function parseRecurrence(rule: string): RecurrenceOptions | null {
  const values = Object.fromEntries(rule.split(";").map((part) => {
    const [key, value] = part.split("=");
    return [key, value];
  }));
  if (!["DAILY", "WEEKLY", "MONTHLY"].includes(values.FREQ)) return null;
  const byDay = values.BYDAY ? values.BYDAY.split(",").map((day: string) => DAY_CODES.indexOf(day)).filter((day: number) => day >= 0) : [];
  return {
    frequency: values.FREQ as RecurrenceOptions["frequency"],
    interval: Math.max(1, Number(values.INTERVAL) || 1),
    byDay,
    count: values.COUNT ? Number(values.COUNT) : undefined,
    until: values.UNTIL ? new Date(values.UNTIL) : undefined,
  };
}

export function previewOccurrences(startAt: string, rule: string, limit = 6): Date[] {
  const start = new Date(startAt);
  const options = parseRecurrence(rule);
  if (!options || Number.isNaN(start.getTime())) return [start];
  const result: Date[] = [];
  const cursor = new Date(start);
  let scanned = 0;
  const maxScans = 366 * 5;
  while (result.length < limit && scanned < maxScans) {
    const elapsedDays = Math.floor((cursor.getTime() - start.getTime()) / 86_400_000);
    const dayMatches = options.frequency === "DAILY"
      ? elapsedDays % options.interval === 0
      : options.frequency === "WEEKLY"
        ? Math.floor(elapsedDays / 7) % options.interval === 0 &&
          (options.byDay.length === 0 ? cursor.getDay() === start.getDay() : options.byDay.includes(cursor.getDay()))
        : cursor.getDate() === start.getDate() &&
          (cursor.getFullYear() - start.getFullYear()) * 12 + cursor.getMonth() - start.getMonth() >= 0 &&
          ((cursor.getFullYear() - start.getFullYear()) * 12 + cursor.getMonth() - start.getMonth()) % options.interval === 0;
    if (dayMatches && cursor >= start && (!options.until || cursor <= options.until)) {
      result.push(new Date(cursor));
      if (options.count && result.length >= options.count) break;
    }
    cursor.setDate(cursor.getDate() + 1);
    scanned += 1;
    if (options.until && cursor > options.until) break;
  }
  return result;
}
