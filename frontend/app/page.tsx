"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle, ArrowUpRight, Check, CheckCircle2, ChevronLeft,
  ChevronRight, ClipboardList, Clock3, FileText, Layers3, LogOut, MessageCircle,
  Plus, RefreshCw, Search, ShieldCheck, Sparkles, UserRound, Users, X, LayoutList, Columns3, ArrowRight,
} from "lucide-react";
import { api, ApiError } from "@/lib/api";
import type { Activity, HistoryPage, PageResult, Priority, Status, Summary, Team, User, WorkItem } from "@/lib/types";
import WorkflowMap from "@/components/workflow-map";
import ItemWorkflow from "@/components/item-workflow";
import WorkBoard from "@/components/work-board";
import Modal from "@/components/modal";
import { TimeProvider, Timestamp, WorkspaceClock, useWorkspaceTime } from "@/components/time-system";
import ItemDeadline from "@/components/item-deadline";
import { formatTimestamp, localInputToUtc, toLocalInput } from "@/lib/datetime";

const STATUS_OPTIONS: Status[] = ["open", "in_progress", "blocked", "in_review", "done"];
const PRIORITY_OPTIONS: Priority[] = ["low", "medium", "high", "urgent"];
const DEADLINE_LABELS: Record<string, string> = { overdue: "Overdue", due_soon: "Due within 24h", scheduled: "With due date", none: "No due date" };
const NEXT_STATUSES: Record<Status, Status[]> = {
  open: ["in_progress"],
  in_progress: ["blocked", "in_review", "done"],
  blocked: ["in_progress"],
  in_review: ["in_progress", "done"],
  done: [],
};

function label(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function initials(name?: string | null) {
  if (!name) return "?";
  return name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function eventText(event: Activity, timeZone: string) {
  if (event.event_type === "created") return `created this work item${event.details.due_at ? ` · Due ${formatTimestamp(event.details.due_at, timeZone)}` : ""}`;
  if (event.event_type === "claimed") return `claimed this item${event.details.owner ? ` as ${event.details.owner}` : ""}`;
  if (event.event_type === "comment") return `left a note: “${event.details.content}”`;
  const changes = event.details.changes as Record<string, { from: string | null; to: string | null }> | undefined;
  if (!changes) return "updated this item";
  const descriptions = Object.entries(changes).map(([field, values]) => field === "due_at"
    ? `Due date: ${values.from ? formatTimestamp(values.from, timeZone) : "No due date"} → ${values.to ? formatTimestamp(values.to, timeZone) : "No due date"}`
    : `${field === "owner_id" ? "Owner" : label(field)}: ${label(values.from ?? "None")} → ${label(values.to ?? "None")}`);
  return `updated ${descriptions.join(" · ")}`;
}

function readError(error: unknown, fallback: string) {
  return error instanceof ApiError ? error.message : fallback;
}

export default function WorkbenchPage() {
  return <TimeProvider><Workbench /></TimeProvider>;
}

function Workbench() {
  const router = useRouter();
  const { timeZone } = useWorkspaceTime();
  const requestNumber = useRef(0);
  const createIdempotencyKey = useRef<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [teamId, setTeamId] = useState("");
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState("");
  const [items, setItems] = useState<WorkItem[]>([]);
  const [summary, setSummary] = useState<Summary>({
    active: 0,
    urgent: 0,
    blocked: 0,
    unassigned: 0,
    status_counts: { open: 0, in_progress: 0, blocked: 0, in_review: 0, done: 0 },
  });
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [page, setPage] = useState(1);
  const [searchDraft, setSearchDraft] = useState("");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [priorityFilter, setPriorityFilter] = useState("");
  const [ownerFilter, setOwnerFilter] = useState("");
  const [deadlineFilter, setDeadlineFilter] = useState("");
  const [queueLoadedAt, setQueueLoadedAt] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<WorkItem | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [detailConflict, setDetailConflict] = useState("");
  const [detailReload, setDetailReload] = useState(0);
  const [draft, setDraft] = useState<{ status: Status; priority: Priority; owner_id: string; due_at: string }>({ status: "open", priority: "medium", owner_id: "", due_at: "" });
  const [comment, setComment] = useState("");
  const [commentBusy, setCommentBusy] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [view, setView] = useState<"list" | "board">("list");
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState("");
  const [historyBusy, setHistoryBusy] = useState(false);
  const [toast, setToast] = useState<{ text: string; kind: "success" | "error" } | null>(null);

  const selectedTeam = useMemo(() => teams.find((team) => team.id === teamId) ?? null, [teams, teamId]);
  const canLead = selectedTeam ? selectedTeam.role === "lead" || selectedTeam.role === "admin" : false;

  const notify = useCallback((text: string, kind: "success" | "error" = "success") => {
    setToast({ text, kind });
    window.setTimeout(() => setToast((current) => current?.text === text ? null : current), 3600);
  }, []);

  useEffect(() => {
    let alive = true;
    async function loadIdentity() {
      try {
        const [{ user: signedIn }, availableTeams] = await Promise.all([
          api<{ user: User }>("/auth/me"),
          api<Team[]>("/teams"),
        ]);
        if (!alive) return;
        setUser(signedIn);
        setTeams(availableTeams);
        setTeamId((previous) => previous || (availableTeams.find((team) => team.role === "admin") ?? availableTeams[0])?.id || "");
        if (!availableTeams.length) setAuthError("Your account is not a member of any team yet.");
      } catch (reason) {
        if (!alive) return;
        if (reason instanceof ApiError && reason.status === 401) router.replace("/login");
        else setAuthError(readError(reason, "Could not load your account."));
      } finally {
        if (alive) setAuthLoading(false);
      }
    }
    void loadIdentity();
    return () => { alive = false; };
  }, [router]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQuery(searchDraft.trim());
      setPage(1);
    }, 240);
    return () => window.clearTimeout(timer);
  }, [searchDraft]);

  useEffect(() => {
    if (!teamId || authLoading) return;
    const id = ++requestNumber.current;
    let alive = true;
    const params = new URLSearchParams({ team_id: teamId, page: String(page), page_size: "12" });
    if (query) params.set("q", query);
    if (statusFilter) params.set("status", statusFilter);
    if (priorityFilter) params.set("priority", priorityFilter);
    if (ownerFilter) params.set("owner", ownerFilter);
    if (deadlineFilter) params.set("deadline", deadlineFilter);
    setLoading(true);
    setError("");
    Promise.all([
      api<PageResult>(`/items?${params.toString()}`),
      api<Summary>(`/teams/${teamId}/summary`),
    ]).then(([result, counts]) => {
      if (!alive || requestNumber.current !== id) return;
      setItems(result.items);
      setTotal(result.total);
      setTotalPages(result.total_pages);
      setSummary(counts);
      setQueueLoadedAt(new Date().toISOString());
    }).catch((reason) => {
      if (!alive || requestNumber.current !== id) return;
      if (reason instanceof ApiError && reason.status === 401) router.replace("/login");
      else setError(readError(reason, "The queue could not be loaded."));
    }).finally(() => {
      if (alive && requestNumber.current === id) setLoading(false);
    });
    return () => { alive = false; };
  }, [teamId, page, query, statusFilter, priorityFilter, ownerFilter, deadlineFilter, reloadKey, authLoading, router]);

  useEffect(() => {
    if (deadlineFilter !== "overdue" && deadlineFilter !== "due_soon") return;
    const timer = window.setInterval(() => setReloadKey((value) => value + 1), 60_000);
    return () => window.clearInterval(timer);
  }, [deadlineFilter]);

  useEffect(() => {
    if (!selectedId) return;
    let alive = true;
    setDetailLoading(true);
    setDetailError("");
    api<WorkItem>(`/items/${selectedId}`).then((current) => {
      if (!alive) return;
      setDetail(current);
      setDraft({ status: current.status, priority: current.priority, owner_id: current.owner_id ?? "", due_at: toLocalInput(current.due_at) });
    }).catch((reason) => {
      if (alive) setDetailError(readError(reason, "Work item details could not be loaded."));
    }).finally(() => { if (alive) setDetailLoading(false); });
    return () => { alive = false; };
  }, [selectedId, detailReload]);

  async function signOut() {
    try { await api("/auth/logout", { method: "POST" }); }
    finally { router.replace("/login"); }
  }

  function setQuickFilter(kind: "urgent" | "blocked" | "unassigned") {
    setPage(1);
    setDeadlineFilter("");
    if (kind === "urgent") {
      setPriorityFilter((value) => value === "urgent" ? "" : "urgent");
      setStatusFilter("");
      setOwnerFilter("");
    } else if (kind === "blocked") {
      setStatusFilter((value) => value === "blocked" ? "" : "blocked");
      setPriorityFilter("");
      setOwnerFilter("");
    } else {
      setOwnerFilter((value) => value === "unassigned" ? "" : "unassigned");
      setPriorityFilter("");
      setStatusFilter("");
    }
  }

  function selectWorkflowStatus(status: Status) {
    setPage(1);
    setSearchDraft("");
    setQuery("");
    setPriorityFilter("");
    setOwnerFilter("");
    setDeadlineFilter("");
    setStatusFilter((current) => current === status ? "" : status);
  }

  async function saveDetails() {
    if (!detail) return;
    const patch: Record<string, unknown> = { expected_version: detail.version };
    if (draft.status !== detail.status) patch.status = draft.status;
    if (draft.priority !== detail.priority) patch.priority = draft.priority;
    if (draft.owner_id !== (detail.owner_id ?? "")) patch.owner_id = draft.owner_id || null;
    // Keep the original instant (including seconds and a possible repeated DST hour) when unchanged.
    if (draft.due_at !== toLocalInput(detail.due_at)) {
      try { patch.due_at = localInputToUtc(draft.due_at); }
      catch (reason) { setDetailError(reason instanceof Error ? reason.message : "Choose a valid due date."); return; }
    }
    if (Object.keys(patch).length === 1) { notify("There are no changes to save.", "error"); return; }
    setSaveBusy(true);
    setDetailError("");
    setDetailConflict("");
    try {
      await api<WorkItem>(`/items/${detail.id}`, { method: "PATCH", body: JSON.stringify(patch) });
      notify("Work item updated.");
      setDetailReload((value) => value + 1);
      setReloadKey((value) => value + 1);
    } catch (reason) {
      const message = readError(reason, "The update could not be saved.");
      if (reason instanceof ApiError && reason.status === 409) {
        setDetailConflict(message);
        setDetailReload((value) => value + 1);
      } else setDetailError(message);
    } finally { setSaveBusy(false); }
  }

  async function claimItem() {
    if (!detail) return;
    setSaveBusy(true);
    setDetailError("");
    setDetailConflict("");
    try {
      await api(`/items/${detail.id}/claim`, { method: "POST", body: JSON.stringify({ expected_version: detail.version }) });
      notify("You claimed this work item.");
      setDetailReload((value) => value + 1);
      setReloadKey((value) => value + 1);
    } catch (reason) {
      const message = readError(reason, "The work item could not be claimed.");
      if (reason instanceof ApiError && reason.status === 409) {
        setDetailConflict(message);
        setDetailReload((value) => value + 1);
      } else setDetailError(message);
    } finally { setSaveBusy(false); }
  }

  async function addComment(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!detail || !comment.trim()) return;
    setCommentBusy(true);
    setDetailError("");
    setDetailConflict("");
    try {
      await api(`/items/${detail.id}/comments`, { method: "POST", body: JSON.stringify({ content: comment.trim() }) });
      setComment("");
      setDetailReload((value) => value + 1);
      setReloadKey((value) => value + 1);
      notify("Your update was added to the history.");
    } catch (reason) { setDetailError(readError(reason, "Your update could not be added.")); }
    finally { setCommentBusy(false); }
  }

  function openCreateForm() {
    createIdempotencyKey.current = null;
    setCreateError("");
    setCreateOpen(true);
  }

  function openWorkItem(id: string) {
    setSelectedId(id);
    setDetail(null);
    setComment("");
    setDetailError("");
    setDetailConflict("");
  }

  async function loadOlderHistory() {
    if (!detail?.history_next_cursor || historyBusy) return;
    const itemId = detail.id;
    setHistoryBusy(true);
    try {
      const result = await api<HistoryPage>(`/items/${itemId}/history?before=${encodeURIComponent(detail.history_next_cursor)}&page_size=25`);
      setDetail((current) => current?.id === itemId ? {
        ...current,
        history: [...(current.history ?? []), ...result.events.filter((event) => !current.history?.some((existing) => existing.id === event.id))],
        history_has_more: result.has_more,
        history_next_cursor: result.next_cursor,
      } : current);
    } catch (reason) { setDetailError(readError(reason, "Older history could not be loaded.")); }
    finally { setHistoryBusy(false); }
  }

  async function createItem(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedTeam || createBusy) return;
    setCreateBusy(true);
    setCreateError("");
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    let dueAt: string | null;
    try { dueAt = localInputToUtc(String(form.get("due_at") ?? "")); }
    catch (reason) {
      setCreateError(reason instanceof Error ? reason.message : "Choose a valid due date.");
      setCreateBusy(false);
      return;
    }
    const payload = {
      team_id: selectedTeam.id,
      title: String(form.get("title") ?? "").trim(),
      purpose: String(form.get("purpose") ?? "").trim(),
      priority: String(form.get("priority") ?? "medium"),
      due_at: dueAt,
    };
    const idempotencyKey = createIdempotencyKey.current ?? crypto.randomUUID();
    createIdempotencyKey.current = idempotencyKey;
    try {
      const created = await api<WorkItem>("/items", {
        method: "POST",
        body: JSON.stringify(payload),
        headers: { "Idempotency-Key": idempotencyKey },
      });
      createIdempotencyKey.current = null;
      setCreateOpen(false);
      formElement.reset();
      setStatusFilter("");
      setPriorityFilter("");
      setOwnerFilter("");
      setDeadlineFilter("");
      setSearchDraft("");
      setQuery("");
      setPage(1);
      setReloadKey((value) => value + 1);
      setDetail(null);
      setDetailError("");
      setDetailConflict("");
      setSelectedId(created.id);
      notify("Work item created.");
    } catch (reason) { setCreateError(readError(reason, "The work item could not be created.")); }
    finally { setCreateBusy(false); }
  }

  const canEditSelected = Boolean(detail && (canLead || detail.owner_id === user?.id));

  if (authLoading) return <CenteredState message="Preparing your workspace…" />;
  if (authError) return <CenteredState message={authError} action={() => router.replace("/login")} actionLabel="Return to sign in" />;

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark">N</div><div className="brand-copy"><div className="brand-name">Newtonite</div><div className="brand-caption">Operations workbench</div></div></div>
        <div className="nav-label">Workspace</div>
        <button className="nav-item active" type="button" onClick={() => { setSearchDraft(""); setQuery(""); setStatusFilter(""); setPriorityFilter(""); setOwnerFilter(""); setDeadlineFilter(""); setPage(1); }}><ClipboardList size={16} /><span>Work queue</span></button>
        <div className="sidebar-note"><span className="sidebar-note-icon"><Sparkles size={16} /></span><strong>Clarity under pressure.</strong><p>One place for your team’s work, decisions, and next steps.</p><span className="sidebar-note-status"><i />Ready for what’s next</span></div>
        <div className="sidebar-bottom">
          <div className="nav-label">Current team</div>
          <div className="team-mini"><div className="team-mini-icon"><Users size={15} /></div><div><strong>{selectedTeam?.name ?? "Choose a team"}</strong><span>{selectedTeam ? label(selectedTeam.role) : "No team selected"}</span></div></div>
          <div className="profile-row"><div className="avatar">{initials(user?.full_name)}</div><div className="profile-copy"><strong>{user?.full_name}</strong><span>{selectedTeam ? label(selectedTeam.role) : "Team member"}</span></div><button className="logout-button" onClick={signOut} type="button" title="Sign out"><LogOut size={15} /></button></div>
        </div>
      </aside>

      <div className="main-area">
        <header className="topbar">
          <div className="crumbs"><span>Workspace</span><ChevronRight size={13} /><strong>Work queue</strong></div>
          <div className="topbar-actions"><button className="icon-button refresh-button" type="button" aria-label="Refresh workspace" title="Refresh workspace" disabled={loading} onClick={() => setReloadKey((value) => value + 1)}><RefreshCw size={14} className={loading ? "refreshing" : ""} /></button><div className="team-select-wrap"><span>Viewing team</span><select aria-label="Viewing team" className="team-select" value={teamId} onChange={(event) => { setTeamId(event.target.value); setPage(1); setSelectedId(""); }}><option value="" disabled>Select a team</option>{teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select></div><button className="icon-button mobile-signout" onClick={signOut} type="button" aria-label="Sign out"><LogOut size={14} /></button></div>
        </header>

        <section className="content">
          <div className="page-heading">
            <div><div className="eyebrow"><span className="workspace-badge">Operations workspace</span></div><h1 className="page-title">Work that needs <em>you.</em></h1><p className="page-subtitle">Clear ownership. Shared context. A next step for every item.</p></div>
            <div className="heading-actions"><WorkspaceClock /><button className="primary-button lime" onClick={openCreateForm} type="button"><Plus size={15} /> New work item</button></div>
          </div>

          <div className="stats-grid">
            <button className="stat-card" onClick={() => { setStatusFilter(""); setPriorityFilter(""); setOwnerFilter(""); setDeadlineFilter(""); setPage(1); }} type="button"><span className="stat-label"><Layers3 size={13} /> Active work</span><strong className="stat-value">{summary.active}<small>in this team</small></strong></button>
            <button className="stat-card tone-urgent" onClick={() => setQuickFilter("urgent")} type="button"><span className="stat-label"><ArrowUpRight size={13} /> Urgent priority</span><strong className="stat-value">{summary.urgent}<small>need a close look</small></strong></button>
            <button className="stat-card tone-blocked" onClick={() => setQuickFilter("blocked")} type="button"><span className="stat-label"><AlertCircle size={13} /> Blocked</span><strong className="stat-value">{summary.blocked}<small>waiting on a next step</small></strong></button>
            <button className="stat-card tone-unassigned" onClick={() => setQuickFilter("unassigned")} type="button"><span className="stat-label"><UserRound size={13} /> Unassigned</span><strong className="stat-value">{summary.unassigned}<small>ready to be picked up</small></strong></button>
          </div>

          <WorkflowMap
            statusCounts={summary.status_counts}
            selectedStatus={statusFilter}
            onSelectStatus={selectWorkflowStatus}
          />

          <section className="work-panel" aria-label="Work items">
            <div className="panel-toolbar">
              <div className="panel-view-controls"><div><span className="panel-title">Team work</span><span className="panel-count">{total}</span></div><div className="view-toggle" role="group" aria-label="Queue view"><button type="button" aria-label="List view" aria-pressed={view === "list"} onClick={() => setView("list")}><LayoutList size={14} /><span>List</span></button><button type="button" aria-label="Board view" aria-pressed={view === "board"} onClick={() => setView("board")}><Columns3 size={14} /><span>Board</span></button></div></div>
              <div className="filters">
                <div className="search-wrap"><Search size={14} /><input aria-label="Search work items" className="search-input" value={searchDraft} onChange={(event) => setSearchDraft(event.target.value)} placeholder="Search by title or purpose…" /></div>
                <select className="filter-select" aria-label="Filter by status" value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value); setPage(1); }}><option value="">All statuses</option>{STATUS_OPTIONS.map((status) => <option key={status} value={status}>{label(status)}</option>)}</select>
                <select className="filter-select" aria-label="Filter by priority" value={priorityFilter} onChange={(event) => { setPriorityFilter(event.target.value); setPage(1); }}><option value="">All priorities</option>{PRIORITY_OPTIONS.map((priority) => <option key={priority} value={priority}>{label(priority)}</option>)}</select>
                <select className="filter-select" aria-label="Filter by owner" value={ownerFilter} onChange={(event) => { setOwnerFilter(event.target.value); setPage(1); }}><option value="">Everyone</option><option value="mine">Assigned to me</option><option value="unassigned">Unassigned</option></select>
                <select className="filter-select" aria-label="Filter by deadline" value={deadlineFilter} onChange={(event) => { setDeadlineFilter(event.target.value); setPage(1); }}><option value="">All due dates</option><option value="overdue">Overdue</option><option value="due_soon">Due within 24h</option><option value="scheduled">With due date</option><option value="none">No due date</option></select>
              </div>
            </div>

            {error && <div className="inline-error" role="alert">{error} <button className="secondary-button" style={{ minHeight: 27, marginLeft: 8 }} onClick={() => setReloadKey((value) => value + 1)} type="button"><RefreshCw size={12} /> Retry</button></div>}
            {(query || statusFilter || priorityFilter || ownerFilter || deadlineFilter) && <div className="active-filters"><span>Focused view</span>{query && <b>“{query}”</b>}{statusFilter && <b>{label(statusFilter)}</b>}{priorityFilter && <b>{label(priorityFilter)} priority</b>}{ownerFilter && <b>{label(ownerFilter)}</b>}{deadlineFilter && <b>{DEADLINE_LABELS[deadlineFilter]}</b>}<button type="button" onClick={() => { setSearchDraft(""); setQuery(""); setStatusFilter(""); setPriorityFilter(""); setOwnerFilter(""); setDeadlineFilter(""); setPage(1); }}><X size={12} />Clear filters</button></div>}
            {view === "list" && <div className="table-head"><span>Work item</span><span>Status</span><span>Priority</span><span>Owner</span><span /></div>}
            {view === "board" && <p className="board-page-note">Board shows the current page of results. Use filters or pagination to explore more work.</p>}
            {loading && <div className="loading-state"><div className="spinner" /><span style={{ marginTop: 11, fontSize: 11 }}>Loading your team’s work…</span></div>}
            {!loading && !error && items.length === 0 && <div className="empty-state"><div className="empty-icon"><Sparkles size={19} /></div><strong>{query || statusFilter || priorityFilter || ownerFilter || deadlineFilter ? "No work matches these filters" : "Your queue is clear"}</strong><p>{query || statusFilter || priorityFilter || ownerFilter || deadlineFilter ? "Try a different search or remove one of the filters." : "Create a work item to give the team a shared place to start."}</p>{query || statusFilter || priorityFilter || ownerFilter || deadlineFilter ? <button className="secondary-button" onClick={() => { setSearchDraft(""); setQuery(""); setStatusFilter(""); setPriorityFilter(""); setOwnerFilter(""); setDeadlineFilter(""); setPage(1); }} type="button"><X size={13} /> Clear filters</button> : <button className="primary-button" onClick={openCreateForm} type="button"><Plus size={14} /> Create first item</button>}</div>}
            {!loading && !error && items.length > 0 && view === "board" && <WorkBoard items={items} onOpen={openWorkItem} />}
            {!loading && !error && items.length > 0 && view === "list" && <div>{items.map((item) => <button className={`item-row item-row-${item.priority}`} key={item.id} type="button" onClick={() => openWorkItem(item.id)}>
              <span className="item-title"><span className="item-type-mark"><FileText size={14} /></span><span className="item-title-copy"><strong>{item.title}</strong><span>{item.purpose}</span><span className="item-updated">Updated <Timestamp value={item.updated_at} relative /></span><ItemDeadline dueAt={item.due_at} status={item.status} /></span></span>
              <span className="item-status-view"><ItemWorkflow status={item.status} /><span className={`status-pill status-${item.status}`}>{label(item.status)}</span></span>
              <span className={`priority-pill priority-${item.priority}`}>{label(item.priority)}</span>
              <span className="owner-cell">{item.owner ? <><span className="avatar">{initials(item.owner.full_name)}</span><span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.owner.full_name.split(" ")[0]}</span></> : <span className="unassigned">Unassigned</span>}</span>
              <ChevronRight className="row-chevron" size={15} />
            </button>)}</div>}
            {!loading && !error && items.length > 0 && <div className="list-footer"><span>Showing {(page - 1) * 12 + 1}–{Math.min(page * 12, total)} of {total} items</span><div className="pagination"><button className="page-button" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))} type="button" aria-label="Previous page"><ChevronLeft size={14} /></button><span className="page-indicator">{page} / {Math.max(totalPages, 1)}</span><button className="page-button" disabled={page >= totalPages} onClick={() => setPage((value) => value + 1)} type="button" aria-label="Next page"><ChevronRight size={14} /></button></div></div>}
          </section>
          <div className="workspace-footnote"><span><ShieldCheck size={12} /> Access is checked by the server for every team and work item.</span>{queueLoadedAt && <span>Refreshed <Timestamp value={queueLoadedAt} relative /></span>}</div>
        </section>
      </div>

      {createOpen && <Modal label="Create a work item" onClose={() => { if (!createBusy) setCreateOpen(false); }}><form className="modal-form" onChange={() => { if (createIdempotencyKey.current) createIdempotencyKey.current = crypto.randomUUID(); }} onSubmit={createItem}>
        <div className="modal-header"><div><div className="modal-kicker">{selectedTeam?.name ?? "Team queue"}</div><h2 className="modal-heading">Create a work item</h2></div><button className="icon-button" onClick={() => setCreateOpen(false)} type="button" aria-label="Close"><X size={15} /></button></div>
        <div className="modal-body">{createError && <div className="inline-error create-error" role="alert">{createError}</div>}<div className="form-grid">
          <div className="field full"><label htmlFor="new-title">What needs attention?</label><input className="field-control" id="new-title" name="title" required minLength={3} maxLength={180} placeholder="Short, specific title" /></div>
          <div className="field full"><label htmlFor="new-purpose">Purpose and context</label><textarea className="field-control" id="new-purpose" name="purpose" required minLength={3} maxLength={4000} placeholder="Why does this work matter? Add context the next person will need." /></div>
          <div className="field"><label htmlFor="new-priority">Priority</label><select className="field-control" id="new-priority" name="priority" defaultValue="medium">{PRIORITY_OPTIONS.map((priority) => <option key={priority} value={priority}>{label(priority)}</option>)}</select></div>
          <div className="field"><label>Initial status</label><input className="field-control" disabled value="Open" /></div>
          <div className="field full"><label htmlFor="new-due-at">Due date and time <span className="optional-label">Optional</span></label><input type="datetime-local" className="field-control" id="new-due-at" name="due_at" step="60" aria-describedby="new-due-hint" /><small className="field-hint" id="new-due-hint">Your time zone: {timeZone.replaceAll("_", " ")}. Leave empty if there is no deadline.</small></div>
        </div></div>
        <div className="modal-footer"><button className="secondary-button" disabled={createBusy} onClick={() => setCreateOpen(false)} type="button">Cancel</button><button className="primary-button lime" disabled={createBusy} type="submit"><Plus size={14} /> {createBusy ? "Creating…" : "Create work item"}</button></div>
      </form></Modal>}

      {selectedId && <Modal wide label="Work item details" onClose={() => setSelectedId("")}>
        <div className="modal-header"><div><div className="modal-kicker">Work item · {detail ? `Version ${detail.version}` : "Loading"}</div><h2 className="modal-heading">Item details</h2></div><button className="icon-button" onClick={() => setSelectedId("")} type="button" aria-label="Close"><X size={15} /></button></div>
        {detailLoading && !detail ? <div className="detail-loading"><div className="spinner" /></div> : detailError && !detail ? <div className="modal-body"><div className="inline-error" style={{ margin: 0 }}>{detailError}<button className="secondary-button" style={{ marginLeft: 8 }} onClick={() => setDetailReload((value) => value + 1)} type="button">Retry</button></div></div> : detail && <>
          <div className="modal-body">
            <div className="detail-intro"><span className="eyebrow">{selectedTeam?.name ?? "Team work"}</span><h3 className="detail-title">{detail.title}</h3><p className="detail-description">{detail.purpose}</p><div className="detail-meta"><span className={`status-pill status-${detail.status}`}>{label(detail.status)}</span><span className={`priority-pill priority-${detail.priority}`}>{label(detail.priority)} priority</span></div>
              <div className="detail-timestamps"><div><span>Created</span><Timestamp value={detail.created_at} /></div><div><span>Last updated</span><Timestamp value={detail.updated_at} /></div></div>
              <ItemDeadline dueAt={detail.due_at} status={detail.status} detailed />
            </div>
            <ItemWorkflow status={detail.status} history={detail.history} variant="detail" />
            <div className={`next-action next-action-${detail.status}`}><span className="next-action-icon">{detail.status === "done" ? <CheckCircle2 size={17} /> : <ArrowRight size={17} />}</span><div><strong>{detail.status === "done" ? "Work resolved" : "What happens next"}</strong><p>{detail.status === "done" ? "The outcome and decisions stay available in the history." : !detail.owner ? "Claim this item or ask a team lead to assign an owner." : detail.status === "blocked" ? "Add context about the blocker. Resume in progress when it is resolved." : detail.status === "in_review" ? "Record the review decision, then resolve or return to in progress." : detail.status === "open" ? "Start the investigation by moving this item to in progress." : "Keep the team informed. Send for review, resolve, or flag a blocker."}</p></div></div>
            {!detail.owner && detail.status !== "done" && <div className="claim-row"><span>This work item is open for someone to take.</span><button className="primary-button" disabled={saveBusy} onClick={claimItem} type="button"><UserRound size={13} /> Claim work</button></div>}
            <div className="detail-section"><div className="section-head"><strong>Work details</strong><span>{canEditSelected ? "Changes are saved together" : "Read only for your role"}</span></div>
              <div className="edit-grid">
                <div className="field"><label htmlFor="edit-status">Status</label><select className="field-control" id="edit-status" value={draft.status} disabled={!canEditSelected} onChange={(event) => setDraft((value) => ({ ...value, status: event.target.value as Status }))}><option value={detail.status}>{label(detail.status)}</option>{NEXT_STATUSES[detail.status].map((status) => <option key={status} value={status}>{label(status)}</option>)}</select></div>
                <div className="field"><label htmlFor="edit-priority">Priority</label><select className="field-control" id="edit-priority" value={draft.priority} disabled={!canEditSelected} onChange={(event) => setDraft((value) => ({ ...value, priority: event.target.value as Priority }))}>{PRIORITY_OPTIONS.map((priority) => <option key={priority} value={priority}>{label(priority)}</option>)}</select></div>
                <div className="field"><label htmlFor="edit-owner">Owner</label><select className="field-control" id="edit-owner" value={draft.owner_id} disabled={!canLead} onChange={(event) => setDraft((value) => ({ ...value, owner_id: event.target.value }))}><option value="">Unassigned</option>{selectedTeam?.members.map((member) => <option key={member.id} value={member.id}>{member.full_name}{member.id === user?.id ? " (you)" : ""}</option>)}</select></div>
                <div className="field deadline-field"><label htmlFor="edit-due-at">Due date and time</label><div className="deadline-input-row"><input type="datetime-local" className="field-control" id="edit-due-at" value={draft.due_at} step="60" disabled={!canEditSelected} aria-describedby="edit-due-hint" onChange={(event) => setDraft((value) => ({ ...value, due_at: event.target.value }))} />{canEditSelected && draft.due_at && <button type="button" className="secondary-button" onClick={() => setDraft((value) => ({ ...value, due_at: "" }))}>Clear</button>}</div><small className="field-hint" id="edit-due-hint">{timeZone.replaceAll("_", " ")} · Optional. Clear and save to remove the deadline.</small></div>
              </div>
              {canEditSelected && <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 11 }}><button className="primary-button" disabled={saveBusy} onClick={saveDetails} type="button"><Check size={14} /> {saveBusy ? "Saving…" : "Save changes"}</button></div>}
            </div>
            {(detailError || detailConflict) && <div className="inline-error" role="alert" style={{ margin: "0 0 10px" }}>{detailConflict || detailError}</div>}
            <div className="detail-section"><div className="section-head"><strong>Updates & history</strong><span>{detail.history?.length ?? 0} recent events</span></div>
              <form className="comment-form" onSubmit={addComment}><input className="field-control" maxLength={2000} value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Add context or a handoff note…" aria-label="Add a comment" /><button className="secondary-button" type="submit" disabled={commentBusy || !comment.trim()}><MessageCircle size={13} /> {commentBusy ? "Adding…" : "Add note"}</button></form>
              <div className="history-list" style={{ marginTop: 12 }}>{detail.history?.map((event) => <div className="history-entry" key={event.id}><div className="history-dot">{event.event_type === "comment" ? <MessageCircle size={11} /> : event.event_type === "created" ? <Sparkles size={11} /> : <ArrowUpRight size={11} />}</div><div className="history-copy"><strong>{event.actor_name}</strong> {eventText(event, timeZone)}<Timestamp value={event.created_at} /></div></div>)}</div>
              {detail.history_has_more && <button className="secondary-button load-history" type="button" disabled={historyBusy} onClick={loadOlderHistory}><Clock3 size={13} />{historyBusy ? "Loading…" : "Load older history"}</button>}
            </div>
          </div>
          <div className="modal-footer" style={{ justifyContent: "space-between" }}><span style={{ color: "#99a49f", fontSize: 10 }}>Created by {detail.created_by?.full_name ?? "a teammate"}</span><button className="secondary-button" type="button" onClick={() => setSelectedId("")}>Close</button></div>
        </>}
      </Modal>}

      {toast && <div className={`toast ${toast.kind === "error" ? "error" : ""}`} role="status">{toast.kind === "error" ? <AlertCircle size={15} /> : <CheckCircle2 size={15} />}{toast.text}</div>}
    </main>
  );
}

function CenteredState({ message, action, actionLabel }: { message: string; action?: () => void; actionLabel?: string }) {
  return <main className="login-main" style={{ minHeight: "100vh", flexDirection: "column", gap: 14 }}><div className="spinner" /><p style={{ color: "#687972", fontSize: 13 }}>{message}</p>{action && <button className="secondary-button" onClick={action} type="button">{actionLabel}</button>}</main>;
}
