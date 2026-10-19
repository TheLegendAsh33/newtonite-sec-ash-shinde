"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Clock3 } from "lucide-react";
import { formatTimestamp, parseTimestamp, relativeTimestamp } from "@/lib/datetime";

const TimeContext = createContext<{ timeZone: string; now: number | null }>({ timeZone: "UTC", now: null });

export function TimeProvider({ children }: { children: ReactNode }) {
  const [time, setTime] = useState<{ timeZone: string; now: number | null }>({ timeZone: "UTC", now: null });
  useEffect(() => {
    const update = () => setTime({ timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", now: Date.now() });
    update();
    const timer = window.setInterval(update, 30_000);
    document.addEventListener("visibilitychange", update);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", update); };
  }, []);
  return <TimeContext.Provider value={time}>{children}</TimeContext.Provider>;
}

export const useWorkspaceTime = () => useContext(TimeContext);

export function Timestamp({ value, relative = false, compact = false, className }: { value: string; relative?: boolean; compact?: boolean; className?: string }) {
  const { timeZone, now } = useWorkspaceTime();
  const date = parseTimestamp(value);
  if (!date) return <span className={className}>Unknown time</span>;
  const exact = formatTimestamp(value, timeZone);
  return <time className={className} dateTime={date.toISOString()} title={exact} aria-label={exact}>
    {relative && now !== null ? relativeTimestamp(value, now) : formatTimestamp(value, timeZone, compact)}
  </time>;
}

export function WorkspaceClock() {
  const { timeZone } = useWorkspaceTime();
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const update = () => setNow(Date.now());
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <div className="workspace-clock" aria-label={`Current local date and time in ${timeZone}`}>
    <span className="workspace-clock-icon"><Clock3 size={16} /></span>
    <div><span className="workspace-clock-date">{now === null ? "Local date" : new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone }).format(now)}</span>
      <div className="workspace-clock-reading"><time dateTime={now === null ? undefined : new Date(now).toISOString()}>{now === null ? "--:--:--" : new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZone }).format(now)}</time><span>{timeZone.replaceAll("_", " ")}</span></div></div>
  </div>;
}
