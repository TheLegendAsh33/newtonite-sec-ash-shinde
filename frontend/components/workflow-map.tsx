"use client";

import { useId, type KeyboardEvent } from "react";
import { ArrowUpRight, GitBranch } from "lucide-react";
import type { Status } from "@/lib/types";

type WorkflowMapProps = {
  statusCounts: Record<Status, number>;
  selectedStatus: string;
  onSelectStatus: (status: Status) => void;
};

const nodes: { status: Status; label: string; x: number; y: number; width: number }[] = [
  { status: "open", label: "Open", x: 16, y: 20, width: 174 },
  { status: "in_progress", label: "In progress", x: 250, y: 20, width: 190 },
  { status: "in_review", label: "In review", x: 500, y: 20, width: 174 },
  { status: "done", label: "Done", x: 740, y: 20, width: 174 },
  { status: "blocked", label: "Blocked", x: 250, y: 128, width: 190 },
];

function activate(event: KeyboardEvent<SVGGElement>, status: Status, onSelect: (status: Status) => void) {
  if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(status); }
}

export default function WorkflowMap({ statusCounts, selectedStatus, onSelectStatus }: WorkflowMapProps) {
  const arrowId = useId().replaceAll(":", "");
  const selectedLabel = nodes.find((node) => node.status === selectedStatus)?.label;
  const total = Object.values(statusCounts).reduce((sum, count) => sum + count, 0);
  const completed = total ? Math.round(statusCounts.done / total * 100) : 0;

  return <section className="workflow-panel" aria-labelledby="workflow-heading">
    <div className="workflow-panel-header">
      <div className="workflow-title-group"><span className="workflow-icon"><GitBranch size={18} /></span><div><div className="workflow-eyebrow">The bigger picture</div><h2 className="workflow-heading" id="workflow-heading">Work lifecycle</h2></div></div>
      <div className="workflow-summary"><span><b>{total}</b> total items</span><span className="completion-chip"><i />{completed}% resolved</span></div>
    </div>
    <div className="workflow-canvas">
      <svg className="workflow-svg" viewBox="0 0 940 216" role="group" aria-label="Interactive workflow status map">
        <title>Work lifecycle for the selected team</title>
        <desc>A high-level overview. Select any status to filter. In progress can also move directly to done, and review can return to in progress.</desc>
        <defs><marker id={arrowId} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" className="workflow-arrowhead" /></marker></defs>
        <g className="workflow-connectors" aria-hidden="true">
          <path d="M 198 58 H 240" markerEnd={`url(#${arrowId})`} />
          <path d="M 448 58 H 490" markerEnd={`url(#${arrowId})`} />
          <path d="M 682 58 H 730" markerEnd={`url(#${arrowId})`} />
          <path d="M 318 96 V 120" markerEnd={`url(#${arrowId})`} />
          <path d="M 374 126 V 102" markerEnd={`url(#${arrowId})`} />
        </g>
        <text className="workflow-edge-label" x="286" y="114">block</text>
        <text className="workflow-edge-label" x="410" y="114">resume</text>
        {nodes.map((node) => {
          const count = statusCounts[node.status] ?? 0;
          const selected = selectedStatus === node.status;
          return <g key={node.status} className={`workflow-node workflow-tone-${node.status}${selected ? " is-selected" : ""}`} role="button" tabIndex={0} aria-label={`Filter queue by ${node.label}; ${count} items`} aria-pressed={selected} onClick={() => onSelectStatus(node.status)} onKeyDown={(event) => activate(event, node.status, onSelectStatus)}>
            <rect className="workflow-node-surface" x={node.x} y={node.y} width={node.width} height="76" rx="12" />
            <circle className="workflow-status-dot" cx={node.x + 18} cy={node.y + 23} r="3.5" />
            <text className="workflow-node-label" x={node.x + 29} y={node.y + 27}>{node.label}</text>
            <text className="workflow-node-count" x={node.x + 16} y={node.y + 57}>{count}</text>
            <text className="workflow-node-unit" x={node.x + 22 + String(count).length * 14} y={node.y + 56}>{count === 1 ? "item" : "items"}</text>
          </g>;
        })}
        <text className="workflow-map-note" x="500" y="158">Every step has an owner.</text><text className="workflow-map-note muted" x="500" y="179">Keep decisions and handoffs close to the work.</text>
      </svg>
    </div>
    <div className="workflow-panel-footer"><p className="workflow-hint" aria-live="polite">{selectedLabel ? `Showing ${selectedLabel.toLowerCase()} work · select again to clear` : "Select a stage to focus your queue"}</p><span><ArrowUpRight size={12} />Team-wide counts</span></div>
  </section>;
}
