import { useEffect, useRef, useState } from "react";
import type { CoworkEngine, Effort, ReasoningControl } from "@shared/types";

type Page = "root" | "engine" | "model" | "effort";

const EFFORTS: { id: Effort; label: string }[] = [
  { id: "none", label: "none" },
  { id: "minimal", label: "minimal" },
  { id: "low", label: "low" },
  { id: "medium", label: "medium" },
  { id: "high", label: "high" },
  { id: "xhigh", label: "xhigh" },
  { id: "max", label: "max" }
];

function effortLabel(id: Effort): string {
  return EFFORTS.find((e) => e.id === id)?.label ?? "medium";
}

function Chevron() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path d="M4.5 2.5 L8 6 L4.5 9.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

type Props = {
  model: string;
  models: string[];
  effort: Effort;
  onModel: (m: string) => void;
  onEffort: (e: Effort) => void;
  reasoningControl?: ReasoningControl;
  reasoningEfforts?: Effort[];
  engine?: CoworkEngine;
  onEngine?: (engine: CoworkEngine) => void;
};

export function ModelPicker(props: Props) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<Page>("root");
  const [pos, setPos] = useState({ right: 0, bottom: 0 });
  const root = useRef<HTMLDivElement>(null);
  const models = props.models;
  const supportedEfforts = props.reasoningEfforts;

  function place(): void {
    const el = root.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      right: window.innerWidth - r.right,
      bottom: window.innerHeight - r.top + 8
    });
  }

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) {
        setOpen(false);
        setPage("root");
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div className="picker" ref={root}>
      <button
        className="picker-trigger"
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen((v) => {
            const next = !v;
            if (next) place();
            return next;
          });
          setPage("root");
        }}
      >
        <span className="picker-model-name">{props.model || "No local model"}</span>
        {props.reasoningControl === "toggle" ? (
          props.effort !== "low" ? <span className="picker-effort-tag">thinking</span> : null
        ) : props.reasoningControl === "effort" ? (
          <span className="picker-effort-tag">{effortLabel(props.effort)}</span>
        ) : null}
        <svg className={`chev ${open ? "up" : ""}`} width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M2 3.5 L5 6.5 L8 3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </button>
      {open && (
        <div className="picker-panel" style={{ right: pos.right, bottom: pos.bottom }}>
          {page === "root" && (
            <>
              {props.engine && props.onEngine && (
                <button className="picker-row" type="button" onClick={() => setPage("engine")}>
                  <span>Agent</span>
                  <span className="picker-val">
                    {props.engine === "claude-code" ? "Claude Code" : "Codex"}
                    <Chevron />
                  </span>
                </button>
              )}
              <button className="picker-row" type="button" onClick={() => setPage("model")}>
                <span>Model</span>
                <span className="picker-val">
                  {props.model}
                  <Chevron />
                </span>
              </button>
              {props.reasoningControl === "toggle" && (
                <div
                  className="picker-row picker-toggle-row"
                  role="switch"
                  aria-checked={props.effort !== "low"}
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onEffort(props.effort === "low" ? "xhigh" : "low");
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      props.onEffort(props.effort === "low" ? "xhigh" : "low");
                    }
                  }}
                >
                  <span>Thinking</span>
                  <div className={`picker-switch ${props.effort !== "low" ? "on" : "off"}`}>
                    <div className="picker-switch-knob" />
                  </div>
                </div>
              )}
              {props.reasoningControl === "effort" && (
                <div
                  className="picker-row picker-toggle-row"
                  role="slider"
                  aria-label="Reasoning Effort"
                  aria-valuemin={0}
                  aria-valuemax={2}
                  aria-valuenow={props.effort === "low" ? 0 : props.effort === "medium" ? 1 : 2}
                  aria-valuetext={effortLabel(props.effort)}
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation();
                    const next: Effort = props.effort === "low" ? "medium" : props.effort === "medium" ? "xhigh" : "low";
                    props.onEffort(next);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowRight" || e.key === "ArrowUp") {
                      e.preventDefault();
                      props.onEffort(props.effort === "low" ? "medium" : "xhigh");
                    } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
                      e.preventDefault();
                      props.onEffort(props.effort === "xhigh" || props.effort === "high" ? "medium" : "low");
                    } else if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      const next: Effort = props.effort === "low" ? "medium" : props.effort === "medium" ? "xhigh" : "low";
                      props.onEffort(next);
                    }
                  }}
                >
                  <span>Effort</span>
                  <div
                    className={`picker-tri-switch ${
                      props.effort === "low" ? "low" : props.effort === "medium" ? "medium" : "high"
                    }`}
                    onClick={(e) => {
                      e.stopPropagation();
                      const rect = e.currentTarget.getBoundingClientRect();
                      const ratio = (e.clientX - rect.left) / rect.width;
                      if (ratio < 0.35) {
                        props.onEffort("low");
                      } else if (ratio > 0.65) {
                        props.onEffort("xhigh");
                      } else {
                        props.onEffort("medium");
                      }
                    }}
                  >
                    <span className="picker-tri-dot pos-0" />
                    <span className="picker-tri-dot pos-1" />
                    <span className="picker-tri-dot pos-2" />
                    <div className="picker-tri-knob" />
                  </div>
                </div>
              )}
            </>
          )}
          {page === "engine" && props.engine && props.onEngine && (
            <>
              <button className="picker-row back" type="button" onClick={() => setPage("root")}>
                <span>Agent</span>
              </button>
              {([
                ["claude-code", "Claude Code"],
                ["codex", "Codex"]
              ] as const).map(([id, label]) => (
                <button
                  key={id}
                  className={`picker-row sub ${id === props.engine ? "active" : ""}`}
                  type="button"
                  onClick={() => {
                    props.onEngine?.(id);
                    setOpen(false);
                    setPage("root");
                  }}
                >
                  <span>{label}</span>
                </button>
              ))}
            </>
          )}
          {page === "model" && (
            <>
              <button className="picker-row back" type="button" onClick={() => setPage("root")}>
                <span>Model</span>
              </button>
              {models.map((id) => (
                <button
                  key={id}
                  className={`picker-row sub ${id === props.model ? "active" : ""}`}
                  type="button"
                  onClick={() => {
                    props.onModel(id);
                    setOpen(false);
                    setPage("root");
                  }}
                >
                  <span>{id}</span>
                </button>
              ))}
            </>
          )}
          {page === "effort" && (
            <>
              <button className="picker-row back" type="button" onClick={() => setPage("root")}>
                <span>Effort</span>
              </button>
              {(props.reasoningControl === "toggle"
                ? [{ id: "low" as Effort, label: "Off" }, { id: "xhigh" as Effort, label: "On" }]
                : EFFORTS.filter((effort) => !supportedEfforts || supportedEfforts.includes(effort.id))).map((e) => (
                <button
                  key={e.id}
                  className={`picker-row sub ${e.id === props.effort ? "active" : ""}`}
                  type="button"
                  onClick={() => {
                    props.onEffort(e.id);
                    setOpen(false);
                    setPage("root");
                  }}
                >
                  <span>{e.label}</span>
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
