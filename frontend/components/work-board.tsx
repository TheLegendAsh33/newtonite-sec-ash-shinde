import { ArrowUpRight, Clock3, UserRound } from "lucide-react";
import type { Status, WorkItem } from "@/lib/types";
import ItemWorkflow from "@/components/item-workflow";
import ItemDeadline from "@/components/item-deadline";
import { Timestamp } from "@/components/time-system";

const stages: { status: Status; label: string; hint: string }[] = [
  { status: "open", label: "Open", hint: "Ready to start" },
  { status: "in_progress", label: "In progress", hint: "Work in motion" },
  { status: "blocked", label: "Blocked", hint: "Needs a next step" },
  { status: "in_review", label: "In review", hint: "Ready for a decision" },
  { status: "done", label: "Done", hint: "Resolved" },
];

export default function WorkBoard({ items, onOpen }: { items: WorkItem[]; onOpen: (id: string) => void }) {
  return <div className="work-board" aria-label="Workflow board for the current page">
    {stages.map(({ status, label, hint }) => {
      const cards = items.filter((item) => item.status === status);
      return <section className={`board-column board-${status}`} key={status} aria-label={`${label} column`}>
        <header className="board-column-header"><div><strong><i />{label}</strong><span>{hint}</span></div><b>{cards.length}</b></header>
        <div className="board-cards">
          {cards.map((item) => <button className="board-card" data-status={status} key={item.id} type="button" onClick={() => onOpen(item.id)}>
            <span className="board-card-top"><span className={`priority-pill priority-${item.priority}`}>{item.priority}</span><ArrowUpRight size={14} /></span>
            <strong>{item.title}</strong><p>{item.purpose}</p>
            <ItemWorkflow status={item.status} />
            <ItemDeadline dueAt={item.due_at} status={item.status} />
            <span className="board-card-footer"><span><UserRound size={12} />{item.owner?.full_name.split(" ")[0] ?? "Unassigned"}</span><span><Clock3 size={11} />Updated <Timestamp value={item.updated_at} compact /></span></span>
          </button>)}
          {!cards.length && <div className="board-empty">No items on this page</div>}
        </div>
      </section>;
    })}
  </div>;
}
