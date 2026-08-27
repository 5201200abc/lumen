import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { CoworkPermissionMode } from "@shared/types";
import { IconAutoApprove, IconCheck, IconHand, IconShield } from "./icons";

type Props = {
  language?: "zh" | "en";
  value: CoworkPermissionMode;
  defaultPermissions: boolean;
  fullAccess: boolean;
  onChange: (mode: CoworkPermissionMode) => void;
};

const LABELS: Record<CoworkPermissionMode, { en: string; zh: string }> = {
  ask: { en: "Ask for approval", zh: "请求批准" },
  approve: { en: "Approve for me", zh: "自动批准" },
  full: { en: "Full access", zh: "完全访问" }
};

export function PermissionPicker(props: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const isZh = (props.language ?? "en") === "zh";

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const options: Array<{
    id: CoworkPermissionMode;
    description: string;
    disabled: boolean;
    icon: ReactNode;
  }> = [
    {
      id: "ask",
      description: isZh ? "编辑工作区文件或使用网络前始终询问" : "Always ask before editing workspace files or using the internet",
      disabled: false,
      icon: <IconHand size={17} />
    },
    {
      id: "approve",
      description: isZh ? "自动批准工作区操作，仅对潜在危险行为询问" : "Only ask for actions detected as potentially unsafe",
      disabled: !props.defaultPermissions,
      icon: <IconAutoApprove size={17} />
    },
    {
      id: "full",
      description: isZh ? "不经批准访问网络以及这台电脑上的任何文件" : "Unrestricted access to the internet and any file on this computer",
      disabled: !props.fullAccess,
      icon: <IconShield size={17} />
    }
  ];

  return (
    <div className="permission-picker" ref={root}>
      <button
        type="button"
        className={`permission-trigger ${props.value === "full" ? "danger" : ""}`}
        aria-expanded={open}
        aria-label={isZh ? "Cowork 权限" : "Cowork permissions"}
        title={isZh ? "Cowork 权限" : "Cowork permissions"}
        onClick={() => setOpen((current) => !current)}
      >
        {props.value === "ask" ? <IconHand size={14} /> : props.value === "approve" ? <IconAutoApprove size={14} /> : <IconShield size={14} />}
        <span>{LABELS[props.value][isZh ? "zh" : "en"]}</span>
      </button>
      {open ? (
        <div className="permission-menu" role="menu">
          <div className="permission-menu-heading">
            {isZh ? "Lumen 应如何批准操作？" : "How should Lumen actions be approved?"}
          </div>
          {options.map((option) => (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={props.value === option.id}
              disabled={option.disabled}
              className={option.id === "full" ? "danger" : ""}
              key={option.id}
              onClick={() => {
                props.onChange(option.id);
                setOpen(false);
              }}
            >
              <span className="permission-option-icon">{option.icon}</span>
              <span className="permission-option-copy">
                <strong>{LABELS[option.id][isZh ? "zh" : "en"]}</strong>
                <small>{option.description}</small>
              </span>
              {props.value === option.id ? <IconCheck size={16} /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
