/** API instants are UTC; presentation and form entry use the viewer's time zone. */
export function parseTimestamp(value?: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatTimestamp(value: string | null | undefined, timeZone: string, compact = false): string {
  const date = parseTimestamp(value);
  if (!date) return "—";
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric", month: "short", ...(compact ? {} : { year: "numeric" }),
    hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone,
    ...(compact ? {} : { second: "2-digit", timeZoneName: "short" }),
  }).format(date);
}

export function relativeTimestamp(value: string, now: number): string {
  const date = parseTimestamp(value);
  if (!date) return "Unknown time";
  const seconds = (date.getTime() - now) / 1000;
  const magnitude = Math.abs(seconds);
  const [divisor, unit]: [number, Intl.RelativeTimeFormatUnit] = magnitude < 60 ? [1, "second"]
    : magnitude < 3600 ? [60, "minute"] : magnitude < 86400 ? [3600, "hour"]
      : magnitude < 2592000 ? [86400, "day"] : magnitude < 31536000 ? [2592000, "month"] : [31536000, "year"];
  return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(Math.round(seconds / divisor), unit);
}

/** datetime-local values have no zone. Only use the browser's local calendar here. */
export function toLocalInput(value?: string | null): string {
  const date = parseTimestamp(value);
  if (!date) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${String(date.getFullYear()).padStart(4, "0")}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function localInputToUtc(value: string): string | null {
  if (!value) return null;
  const date = parseTimestamp(value);
  // Round-trip validation catches impossible dates and the skipped hour at a DST change.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) || !date || toLocalInput(date.toISOString()) !== value) {
    throw new Error("Choose a valid date and time in your local time zone. Daylight-saving changes can skip some times.");
  }
  return date.toISOString();
}

export function deadlineState(dueAt: string | null | undefined, status: string, now: number | null) {
  const date = parseTimestamp(dueAt);
  if (!date) return { tone: "none", label: "No due date" };
  if (status === "done") return { tone: "complete", label: "Due date" };
  if (now === null) return { tone: "scheduled", label: "Scheduled" };
  const remaining = date.getTime() - now;
  if (remaining < 0) return { tone: "overdue", label: "Overdue" };
  if (remaining <= 24 * 60 * 60 * 1000) return { tone: "soon", label: "Due within 24h" };
  return { tone: "scheduled", label: "Due" };
}
