import { useEffect, useRef, useState } from "react";
import type { CoworkEngine, Effort, ReasoningControl } from "@shared/types";

type Page = "root" | "engine" | "model" | "effort";

const EFFORTS: { id: Effort; label: string }[] = [
  { id: "low", label: "low" },
  { id: "medium", label: "medium" },
  { id: "xhigh", label: "xhigh" }
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
  engine?: CoworkEngine;
  onEngine?: (engine: CoworkEngine) => void;
};

export function ModelPicker(props: Props) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<Page>("root");
  const [pos, setPos] = useState({ right: 0, bottom: 0 });
  const root = useRef<HTMLDivElement>(null);
  const models = props.models.length ? props.models : [props.model];

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
        <span className="picker-model-name">{props.model}</span>
        {props.reasoningControl !== "none" && (
          <span className="picker-effort-tag">
            {props.reasoningControl === "toggle" ? (props.effort === "low" ? "thinking off" : "thinking on") : effortLabel(props.effort)}
          </span>
        )}
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
              {props.reasoningControl !== "none" && (
                <button className="picker-row" type="button" onClick={() => setPage("effort")}>
                  <span>{props.reasoningControl === "toggle" ? "Thinking" : "Effort"}</span>
                  <span className="picker-val">
                    {props.reasoningControl === "toggle" ? (props.effort === "low" ? "Off" : "On") : effortLabel(props.effort)}
                    <Chevron />
                  </span>
                </button>
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
                : EFFORTS).map((e) => (
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
