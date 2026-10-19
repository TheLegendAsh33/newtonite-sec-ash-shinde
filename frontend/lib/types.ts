export type User = { id: string; full_name: string; email: string };
export type Member = User & { role: "member" | "lead" | "admin" };
export type Team = { id: string; name: string; role: Member["role"]; members: Member[] };
export type Status = "open" | "in_progress" | "blocked" | "in_review" | "done";
export type Priority = "low" | "medium" | "high" | "urgent";

export type Activity = {
  id: string;
  event_type: "created" | "updated" | "claimed" | "comment";
  details: Record<string, any>;
  actor_name: string;
  created_at: string;
};

export type WorkItem = {
  id: string;
  team_id: string;
  title: string;
  purpose: string;
  status: Status;
  priority: Priority;
  owner_id: string | null;
  owner: User | null;
  created_by: User | null;
  version: number;
  created_at: string;
  updated_at: string;
  due_at: string | null;
  history?: Activity[];
  history_has_more?: boolean;
  history_next_cursor?: string | null;
};

export type HistoryPage = { events: Activity[]; next_cursor: string | null; has_more: boolean };

export type PageResult = { items: WorkItem[]; total: number; page: number; page_size: number; total_pages: number };
export type Summary = {
  active: number;
  urgent: number;
  blocked: number;
  unassigned: number;
  status_counts: Record<Status, number>;
};
