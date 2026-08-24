import { useEffect, useRef, useState } from "react";
import type { GoogleAccount } from "@shared/types";
import { IconGear } from "./icons";

type Props = {
  account: GoogleAccount;
  busy: boolean;
  onLogin: () => void;
  onCancelLogin: () => void;
  onLogout: () => void;
  onSync: () => void;
  onSettings: () => void;
  collapsed?: boolean;
};

function initials(account: GoogleAccount): string {
  const source = account.name || account.email || "Lumen";
  return source.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
}

export function AccountMenu(props: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const label = props.account.connected
    ? props.account.name || props.account.email || "Google account"
    : "Sign in";

  return (
    <div className={`account-menu-root ${props.collapsed ? "collapsed" : ""}`} ref={root}>
      {open ? (
        <div className={`account-popover ${props.collapsed ? "collapsed-popover" : ""}`} role="menu">
          <div className="account-popover-head">
            <div className="account-avatar large">{initials(props.account)}</div>
            <div className="account-identity">
              <strong>{label}</strong>
            </div>
          </div>
          {props.account.error ? <div className="account-error">{props.account.error}</div> : null}
          <div className="account-menu-separator" />
          {props.account.connected ? (
            <button type="button" className="account-menu-row" onClick={props.onSync} disabled={props.busy}>
              <span className="account-row-icon sync-mark">↻</span>
              <span>{props.busy ? "Syncing…" : "Sync data now"}</span>
              {props.account.lastSyncedAt ? (
                <small>{new Date(props.account.lastSyncedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</small>
              ) : null}
            </button>
          ) : (
            <button
              type="button"
              className="account-menu-row google-login-row"
              onClick={props.busy ? props.onCancelLogin : props.onLogin}
            >
              <span className="google-g">G</span>
              <span>{props.busy ? "Cancel sign-in" : "Continue with Google"}</span>
            </button>
          )}
          <button
            type="button"
            className="account-menu-row"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              props.onSettings();
            }}
          >
            <span className="account-row-icon"><IconGear size={17} /></span>
            <span>Settings</span>
          </button>
          {props.account.connected ? (
            <button type="button" className="account-menu-row logout-row" onClick={props.onLogout} disabled={props.busy}>
              <span className="account-row-icon logout-mark">↪</span>
              <span>Log out</span>
            </button>
          ) : null}
        </div>
      ) : null}
      <button
        className={`account-trigger ${open ? "open" : ""} ${props.collapsed ? "collapsed" : ""}`}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        title={label}
      >
        <span className="account-avatar">{initials(props.account)}</span>
        {!props.collapsed && (
          <span className="account-trigger-copy">
            <strong>{label}</strong>
            {props.account.connected ? <small>Google backup on</small> : null}
          </span>
        )}
      </button>
    </div>
  );
}
