import { useEffect, useState } from "react";
import type { GoogleAccount, Settings } from "@shared/types";
import { IconTrash } from "./icons";

type Props = {
  settings: Settings;
  account: GoogleAccount;
  onChange: (patch: Partial<Settings>) => Promise<void>;
  onClose: () => void;
  onDeleteAllMemories?: () => Promise<void>;
  onDeleteAllChats: () => Promise<boolean>;
};

export function SettingsPanel(props: Props) {
  const s = props.settings;
  const [chatInstructions, setChatInstructions] = useState(s.chatInstructions);
  const [coworkInstructions, setCoworkInstructions] = useState(s.coworkInstructions);
  const [rule, setRule] = useState(s.systemPrompt);
  const [ruleEditable, setRuleEditable] = useState(false);
  const [saving, setSaving] = useState<"chat" | "cowork" | "rule" | "memory" | "chats" | null>(null);
  const [saved, setSaved] = useState<"chat" | "cowork" | "rule" | "memory" | "chats" | null>(null);
  const [error, setError] = useState("");

  useEffect(() => setChatInstructions(s.chatInstructions), [s.chatInstructions]);
  useEffect(() => setCoworkInstructions(s.coworkInstructions), [s.coworkInstructions]);
  useEffect(() => setRule(s.systemPrompt), [s.systemPrompt]);

  const run = async (
    action: "chat" | "cowork" | "rule" | "memory" | "chats",
    operation: () => Promise<void | boolean>
  ): Promise<boolean> => {
    setSaving(action);
    setSaved(null);
    setError("");
    try {
      const completed = await operation();
      if (completed === false) return false;
      setSaved(action);
      window.setTimeout(() => setSaved((current) => (current === action ? null : current)), 1800);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setSaving(null);
    }
  };

  const unlockRule = () => {
    const accepted = window.confirm(
      "Model rule style controls the model's default voice and output behavior. Changing it may noticeably alter every Chat response. Continue?"
    );
    if (accepted) setRuleEditable(true);
  };

  const requestClose = () => {
    const dirty =
      chatInstructions !== s.chatInstructions ||
      coworkInstructions !== s.coworkInstructions ||
      (ruleEditable && rule !== s.systemPrompt);
    if (dirty && !window.confirm("Discard unsaved settings changes?")) return;
    props.onClose();
  };

  const handleDeleteMemories = async () => {
    if (!window.confirm("Delete all memory? This cannot be undone.")) return;
    await run("memory", async () => {
      if (!props.onDeleteAllMemories) throw new Error("Memory deletion is unavailable.");
      await props.onDeleteAllMemories();
    });
  };

  return (
    <div className="overlay" onClick={requestClose}>
      <section className="settings settings-redesign" onClick={(event) => event.stopPropagation()}>
        <header className="settings-header">
          <div>
            <span className="settings-eyebrow">Lumen</span>
            <h2>Settings</h2>
          </div>
          <button className="settings-back" type="button" onClick={requestClose} aria-label="Back to conversation">
            <span aria-hidden="true">←</span>
            Back
          </button>
        </header>

        <div className="settings-scroll">
          <section className="settings-section">
            <div className="settings-section-heading">
              <h3>Account</h3>
              <p>Google login stores an encrypted token locally and backs up Lumen's database to Drive app data.</p>
            </div>
            <label className="field">
              <span>Google OAuth Desktop Client ID</span>
              <input
                value={s.googleClientId}
                onChange={(event) => void props.onChange({ googleClientId: event.target.value }).catch((cause) => setError(String(cause)))}
                placeholder="000000000000-….apps.googleusercontent.com"
                spellCheck={false}
              />
              <small>{props.account.connected ? `Connected as ${props.account.email}` : "Required once before Continue with Google can open."}</small>
            </label>
          </section>

          <section className="settings-section">
            <div className="settings-section-heading">
              <h3>Instructions</h3>
              <p>Separate guidance for lightweight Chat and tool-using Cowork sessions.</p>
            </div>
            <label className="field prompt">
              <span>Chat custom instructions</span>
              <textarea
                value={chatInstructions}
                onChange={(event) => {
                  setChatInstructions(event.target.value);
                  setSaved(null);
                }}
                placeholder="How should Chat respond, format answers, or address you?"
                spellCheck={false}
              />
              <span className="field-action-row">
                <small>{saved === "chat" ? "Saved" : chatInstructions !== s.chatInstructions ? "Unsaved changes" : ""}</small>
                <button
                  type="button"
                  className="settings-save"
                  disabled={saving !== null || chatInstructions === s.chatInstructions}
                  onClick={() => void run("chat", () => props.onChange({ chatInstructions }))}
                >
                  {saving === "chat" ? "Saving…" : saved === "chat" ? "Saved" : "Save"}
                </button>
              </span>
            </label>
            <label className="field prompt">
              <span>Cowork custom instructions</span>
              <textarea
                value={coworkInstructions}
                onChange={(event) => {
                  setCoworkInstructions(event.target.value);
                  setSaved(null);
                }}
                placeholder="Project rules, preferred workflow, verification requirements…"
                spellCheck={false}
              />
              <span className="field-action-row">
                <small>{saved === "cowork" ? "Saved" : coworkInstructions !== s.coworkInstructions ? "Unsaved changes" : ""}</small>
                <button
                  type="button"
                  className="settings-save"
                  disabled={saving !== null || coworkInstructions === s.coworkInstructions}
                  onClick={() => void run("cowork", () => props.onChange({ coworkInstructions }))}
                >
                  {saving === "cowork" ? "Saving…" : saved === "cowork" ? "Saved" : "Save"}
                </button>
              </span>
            </label>
            <label className={`field prompt rule-field ${ruleEditable ? "editing" : "locked"}`}>
              <span className="rule-label-row">
                <span>Model rule style</span>
                {!ruleEditable ? (
                  <button type="button" className="text-button" onClick={unlockRule}>Modify</button>
                ) : (
                  <button
                    type="button"
                    className="text-button"
                    disabled={saving !== null}
                    onClick={() => void run("rule", () => props.onChange({ systemPrompt: rule })).then((ok) => {
                      if (ok) setRuleEditable(false);
                    })}
                  >
                    {saving === "rule" ? "Saving…" : "Save & lock"}
                  </button>
                )}
              </span>
              <div className="locked-rule-wrap">
                <textarea
                  value={rule}
                  readOnly={!ruleEditable}
                  aria-readonly={!ruleEditable}
                  onChange={(event) => setRule(event.target.value)}
                  spellCheck={false}
                  tabIndex={ruleEditable ? 0 : -1}
                />
                {!ruleEditable ? (
                  <div className="rule-lock-note">
                    <span>Style rule protected</span>
                    <small>Modify only when you intend to change model output style.</small>
                  </div>
                ) : null}
              </div>
            </label>
          </section>

          <section className="settings-section">
            <div className="settings-section-heading"><h3>Model & appearance</h3></div>
            <div className="settings-grid">
              <label className="field">
                <span>Llama API URL</span>
                <input value={s.llamaUrl} onChange={(event) => void props.onChange({ llamaUrl: event.target.value }).catch((cause) => setError(String(cause)))} />
              </label>
              <label className="field">
                <span>Model</span>
                <input value={s.model} onChange={(event) => void props.onChange({ model: event.target.value }).catch((cause) => setError(String(cause)))} />
              </label>
              <label className="field">
                <span>Llama API Key</span>
                <input type="password" value={s.llamaApiKey} onChange={(event) => void props.onChange({ llamaApiKey: event.target.value }).catch((cause) => setError(String(cause)))} placeholder="optional" />
              </label>
              <label className="field">
                <span>Tavily API Key</span>
                <input type="password" value={s.tavilyApiKey} onChange={(event) => void props.onChange({ tavilyApiKey: event.target.value }).catch((cause) => setError(String(cause)))} />
              </label>
              <label className="field">
                <span>Default effort</span>
                <select value={s.defaultEffort} onChange={(event) => void props.onChange({ defaultEffort: event.target.value as Settings["defaultEffort"] }).catch((cause) => setError(String(cause)))}>
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="xhigh">xhigh</option>
                </select>
              </label>
              <label className="field">
                <span>Theme</span>
                <select value={s.theme} onChange={(event) => void props.onChange({ theme: event.target.value as Settings["theme"] }).catch((cause) => setError(String(cause)))}>
                  <option value="system">System</option>
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                </select>
              </label>
            </div>
          </section>

          <section className="settings-section danger-section">
            <div className="settings-section-heading">
              <h3>Data</h3>
              <p>These actions affect local data and the next Google backup.</p>
            </div>
            <div className="danger-row">
              <span>Memory</span>
              <button
                className={`toggle ${s.memoryEnabled ? "on" : ""}`}
                type="button"
                aria-label="Memory"
                aria-pressed={s.memoryEnabled}
                onClick={() => void props.onChange({ memoryEnabled: !s.memoryEnabled }).catch((cause) => setError(String(cause)))}
              >
                <i />
              </button>
            </div>
            <div className="danger-row">
              <span>Delete all memory</span>
              <button className="icon-btn ghost-icon danger-icon" type="button" disabled={saving !== null} aria-label="Delete all memory" title={saved === "memory" ? "Cleared" : "Delete all memory"} onClick={() => void handleDeleteMemories()}><IconTrash /></button>
            </div>
            <div className="danger-row">
              <span>Delete all chat</span>
              <button className="icon-btn ghost-icon danger-icon" type="button" disabled={saving !== null} aria-label="Delete all chat" title={saved === "chats" ? "Deleted" : "Delete all chat"} onClick={() => void run("chats", props.onDeleteAllChats)}><IconTrash /></button>
            </div>
            {error ? <div className="settings-error" role="alert">{error}</div> : null}
          </section>
        </div>
      </section>
    </div>
  );
}
