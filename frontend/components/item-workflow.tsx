import { Check, GitBranch } from "lucide-react";
import type { Activity, Status } from "@/lib/types";

type ItemWorkflowProps = { status: Status; variant?: "compact" | "detail"; history?: Activity[] };
const labels: Record<Status, string> = { open: "Open", in_progress: "In progress", blocked: "Blocked", in_review: "In review", done: "Done" };
const main: Status[] = ["open", "in_progress", "in_review", "done"];
const validStatus = (value: unknown): value is Status => typeof value === "string" && value in labels;

// The queue has no history. Never infer that earlier stages have been visited.
function recordedStages(status: Status, history: Activity[]) {
  const visited = new Set<Status>([status]);
  for (const event of history) {
    if (event.event_type === "created" && validStatus(event.details.status)) visited.add(event.details.status);
    const change = event.details.changes?.status;
    if (validStatus(change?.from)) visited.add(change.from);
    if (validStatus(change?.to)) visited.add(change.to);
  }
  return visited;
}

export default function ItemWorkflow({ status, variant = "compact", history = [] }: ItemWorkflowProps) {
  const currentLabel = labels[status];
  if (variant === "compact") return <svg className={`item-flow-compact compact-${status}`} viewBox="0 0 222 30" role="img" aria-label={`Workflow overview. Current status: ${currentLabel}.`}>
    <title>{`Current: ${currentLabel}. Open, In progress, In review, Done; Blocked branches from In progress.`}</title>
    <g className="item-flow-compact-connectors" aria-hidden="true"><path d="M 18 9 H 72 M 84 9 H 138 M 150 9 H 204 M 78 14 V 22" /></g>
    {main.map((step, index) => <circle key={step} className={`item-flow-compact-node${status === step ? " is-current" : ""}`} cx={12 + index * 66} cy="9" r={status === step ? 5.5 : 4} />)}
    <circle className={`item-flow-compact-node item-flow-blocked-node${status === "blocked" ? " is-current" : ""}`} cx="78" cy="25" r="3.5" />
  </svg>;

  const visited = recordedStages(status, history);
  return <div className="item-workflow-detail" role="group" aria-label={`Work item workflow. Current status: ${currentLabel}.`}>
    <div className="item-workflow-detail-heading"><strong><GitBranch size={14} />Item journey</strong><span className={`status-pill status-${status}`}>Current: {currentLabel}</span></div>
    <div className="item-journey" role="list" aria-label="Main workflow stages">
      {main.map((step, index) => <div key={step} role="listitem" data-status={step} data-visited={visited.has(step)} className={`journey-stage journey-${step}${status === step ? " is-current" : visited.has(step) ? " is-visited" : ""}`}>
        <span className="journey-step-number">{visited.has(step) && status !== step ? <Check size={12} /> : String(index + 1).padStart(2, "0")}</span>
        <strong>{labels[step]}</strong><small>{status === step ? "You are here" : visited.has(step) ? "Recorded visit" : "Workflow stage"}</small>
      </div>)}
      <div className={`journey-stage journey-blocked${status === "blocked" ? " is-current" : visited.has("blocked") ? " is-visited" : ""}`} data-status="blocked" data-visited={visited.has("blocked")} role="listitem"><strong><span className="journey-blocked-dot" />Blocked</strong><small>{status === "blocked" ? "Resolve the blocker, then resume" : visited.has("blocked") ? "Recorded visit · can resume" : "Pause and resume as needed"}</small></div>
    </div>
    <p className="journey-caption"><span><i />Recorded in loaded history</span>Review can return to progress. Progress can move directly to done.</p>
  </div>;
}
