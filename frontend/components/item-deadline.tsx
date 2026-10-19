"use client";

import { CalendarClock, AlertCircle, CheckCircle2 } from "lucide-react";
import type { Status } from "@/lib/types";
import { deadlineState, formatTimestamp, relativeTimestamp } from "@/lib/datetime";
import { Timestamp, useWorkspaceTime } from "@/components/time-system";

export default function ItemDeadline({ dueAt, status, detailed = false }: { dueAt?: string | null; status: Status; detailed?: boolean }) {
  const { now, timeZone } = useWorkspaceTime();
  const { tone, label } = deadlineState(dueAt, status, now);
  if (!dueAt && !detailed) return null;
  const Icon = tone === "overdue" ? AlertCircle : tone === "complete" ? CheckCircle2 : CalendarClock;
  return <span className={`item-deadline deadline-${tone}${detailed ? " deadline-detailed" : ""}`} title={dueAt ? `Due ${formatTimestamp(dueAt, timeZone)}` : undefined}>
    <Icon size={detailed ? 16 : 12} /><span><strong>{label}</strong>{dueAt && <><span className="deadline-separator"> · </span><Timestamp value={dueAt} compact={!detailed} />{detailed && now !== null && status !== "done" && <small>{relativeTimestamp(dueAt, now)}</small>}{detailed && status === "done" && <small>Completed work</small>}</>}</span>
  </span>;
}
